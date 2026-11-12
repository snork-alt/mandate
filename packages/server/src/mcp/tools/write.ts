/**
 * Document, work-order, feedback and verification WRITE tools. Each is a thin wrapper over a storage service
 * (shared with any future REST route): strict input schema (`@mandate/shared` write-schemas), domain rules in the
 * services (inside the write lock), the whole document validated before the commit. Every write returns the
 * canonical refs, the commit(s), warnings and, for section edits, the resulting section with its derived states.
 */
import {
  isClaimStale,
  SERVICE_USER_PREFIX,
  userOfTrailers,
  buildNodeUri,
  buildRef,
  componentSectionInputSchemas,
  feedbackAcceptInputSchema,
  feedbackCloseInputSchema,
  feedbackCreateInputSchema,
  feedbackUpdateInputSchema,
  parseNodeUri,
  parseRef,
  specArchiveInputSchema,
  specCreateInputSchema,
  specDiffSinceImplementedInputSchema,
  specSectionInputSchemas,
  specStatusSetInputSchema,
  specUpdateMetaInputSchema,
  standardCreateInputSchema,
  standardSectionInputSchemas,
  standardStatusSetInputSchema,
  standardUpdateMetaInputSchema,
  verificationRecordInputSchema,
  workOrderCancelInputSchema,
  workOrderClaimInputSchema,
  workOrderCompleteInputSchema,
  workOrderCreateInputSchema,
  workOrderHeartbeatInputSchema,
  workOrderFailInputSchema,
  workOrderNextInputSchema,
  workOrderRefInputSchema,
  workOrderSectionDoneInputSchema,
  type StoredSpec,
  ERROR_ACTIONS,
} from '@mandate/shared';
import { slugSchema } from '@mandate/doc';
import { z } from 'zod';
import { DocWriteService, type DocKind } from '../../storage/doc-writes.js';
import { resolveCauses } from '../../storage/causes.js';
import { parseCommitMessage } from '../../storage/history.js';
import type { CommitMeta } from '../../storage/index.js';
import { defineTool, type AnyToolDef, type ToolContext } from '../define.js';
import { questionProof, withTrailers } from './questions.js';
import { ToolError } from '../errors.js';
import { clientIdentity, effective } from '../../projects/settings.js';
import { componentArchiveInputSchema, componentCreateInputSchema, componentStatusSetInputSchema, componentUpdateMetaInputSchema } from './components.js';

/* ---------------------------------------------------------------- helpers */

const SOFT_LIMIT = 600;
const idOf = (refOrId: string) => parseRef(refOrId)?.id ?? (parseNodeUri(refOrId) as { id?: string } | null)?.id ?? refOrId;
/** Active users: distinct server users (Mandate-User trailer, service accounts excluded) with a write in the last 90 days. */
export const ACTIVE_USER_DAYS = 90;
async function activeUsers(ctx: ToolContext): Promise<Set<string>> {
  const since = Date.now() - ACTIVE_USER_DAYS * 86_400_000;
  const out = new Set<string>();
  for (const c of await ctx.storage.git.log(5000)) {
    if (Date.parse(c.date) < since) continue;
    const u = userOfTrailers(parseCommitMessage(c.message).trailers);
    if (u && !u.startsWith(SERVICE_USER_PREFIX)) out.add(u.trim().toLowerCase());
  }
  return out;
}
/** Who may self-approve (approval override): an admin, or the sole active user. */

export async function overrideEligibility(ctx: ToolContext): Promise<{ ok: boolean; why: string }> {
  if (!ctx.settings) return { ok: true, why: 'no project settings' };
  const user = ctx.commit?.user;
  if (!user) return { ok: false, why: 'no authenticated user (shared key): self-approval needs a user principal' };
  if (ctx.settings.isAdmin(user)) return { ok: true, why: 'admin' };
  const others = [...(await activeUsers(ctx))].filter((u) => u !== user.trim().toLowerCase());
  return others.length ? { ok: false, why: `${others.length} other active user(s) in the last ${ACTIVE_USER_DAYS} days: ask one of them to accept it` } : { ok: true, why: 'sole active user' };
}

/** DF-7: relatedTo entries: feedback as ids, any other element as its canonical (resolved) reference. */
async function relatedOf(ctx: ToolContext, refs: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const r of refs) {
    const n = parseNodeUri(r);
    if (!n || n.kind === 'feedback') out.push(idOf(r));
    else {
      const [uri] = await resolveCauses(ctx.storage, r).catch((e: Error) => {
        throw Object.assign(new Error(`relatedTo: ${e.message.replace(/^cause /, '')}`), { statusCode: 400, code: 'validation' });
      });
      out.push(uri!);
    }
  }
  return out;
}
const docUri = (kind: DocKind, id: string) => buildRef({ kind, id });

/** Commit metadata for the storage layer from the tool context (agent, branch, trailers), collecting commit shas. */
function metaOf(ctx: ToolContext, commits: string[], extra: Record<string, string> = {}): CommitMeta {
  const c = ctx.commit!;
  return {
    agent: c.agent,
    ...(c.branch ? { branch: c.branch } : {}),
    trailers: { ...c.trailers, ...extra },
    onCommit: (sha) => commits.push(sha),
  };
}

const writes = (ctx: ToolContext) => new DocWriteService(ctx.storage, { sectionSoftLimitTokens: SOFT_LIMIT });

/** Commits of a write: the last one is THE commit (cascades before it). */
const commitsOf = (commits: string[]) => ({ commit: commits.at(-1) ?? null, commits });

/** Extra inputs of document edits: feedback the change addresses (`Feedback:` trailer) and the work order it is part of. */
const docEditExtras = {
  /** Feedback items this change addresses (accepted items are required to shrink the criteria of a done or claimed spec). */
  addresses: z.array(z.string().trim().min(1).max(400)).max(20).optional(),
  /** The work order this edit belongs to (`Work-Order:` trailer). */
  workOrder: z.string().trim().min(1).max(400).optional(),
};
const docEditTrailers = (a: { addresses?: string[]; workOrder?: string }) => ({
  Feedback: a.addresses?.length ? a.addresses.map(idOf).join(', ') : undefined,
  'Work-Order': a.workOrder ? idOf(a.workOrder) : undefined,
});

/** `z.object` with the doc-edit extras (refinements of the shared schema are re-applied in `run`). */
function withExtras<S extends z.ZodObject>(schema: S) {
  return schema.extend(docEditExtras).strict();
}
const strip = <T extends Record<string, unknown>>(a: T) => {
  const { addresses: _a, workOrder: _w, ...rest } = a as T & { addresses?: unknown; workOrder?: unknown };
  return rest;
};

const SECTION_GUIDE = `\nSections: one concept each, a one-sentence summary, under ~${SOFT_LIMIT} tokens (warnings otherwise); name symbols, refs and standards in the metadata.`;
/** Write boilerplate (agent, branch, idempotencyKey, cause, returns) lives once in the server INSTRUCTIONS. */
const COMMON = '';

/** Section after a write: its content and metadata plus derived states (links, blocked / broken, upstream changed, criterion state). */
async function sectionAfter(ctx: ToolContext, kind: DocKind, docId: string, sectionId: string) {
  const ref = buildRef({ kind, id: docId, sectionId });
  const r = kind === 'specs' ? await ctx.reads.specSectionGet({ ref }) : kind === 'standards' ? await ctx.reads.standardSectionGet({ ref }) : await ctx.reads.componentSectionGet({ ref });
  const view = (r as { section: Record<string, unknown> & { meta?: Record<string, unknown> } }).section;
  const doc = kind === 'specs' ? await ctx.storage.specs.get(docId) : kind === 'standards' ? await ctx.storage.standards.get(docId) : await ctx.storage.components.get(docId);
  const links = (await ctx.storage.linkService.forDoc(kind, doc)).sections[sectionId];
  let criterion: string | undefined;
  if (kind === 'specs') {
    const v = await ctx.storage.verificationService.forSpec(doc as StoredSpec);
    criterion = v.own.find((c) => c.sectionId === sectionId)?.state;
  }
  return {
    ...view,
    archived: Boolean(view.meta?.archived),
    links: (view.meta?.links as unknown[]) ?? [],
    derived: {
      blocked: links?.blocked ?? false,
      broken: links?.broken ?? false,
      upstreamChanged: links?.upstreamChanged ?? false,
      pinLost: links?.pinLost ?? false,
      supersededTargets: links?.supersededTargets ?? [],
      backlinks: links?.backlinks ?? [],
      ...(criterion ? { criterion } : {}),
    },
  };
}

/* ---------------------------------------------------------------- spec and standard tools */

function docWriteTools(kind: DocKind): AnyToolDef[] {
  const k = kind === 'specs' ? 'spec' : kind === 'standards' ? 'standard' : 'component';
  const S = kind === 'specs' ? specSectionInputSchemas : kind === 'standards' ? standardSectionInputSchemas : componentSectionInputSchemas;
  const createSchema = kind === 'specs' ? specCreateInputSchema : kind === 'standards' ? standardCreateInputSchema : componentCreateInputSchema;
  const metaSchema = kind === 'specs' ? specUpdateMetaInputSchema : kind === 'standards' ? standardUpdateMetaInputSchema : componentUpdateMetaInputSchema;

  const sectionResult = async (ctx: ToolContext, docId: string, sectionId: string, out: { commits: string[]; warnings: string[] }) => ({
    ref: buildRef({ kind, id: docId, sectionId }),
    uri: out.commits.length ? buildRef({ kind, id: docId, sectionId, commit: out.commits.at(-1) }) : buildRef({ kind, id: docId, sectionId }),
    docRef: docUri(kind, docId),
    ...commitsOf(out.commits),
    warnings: out.warnings,
    section: await sectionAfter(ctx, kind, docId, sectionId),
  });

  return [
    defineTool({
      name: `${k}_create`,
      title: `Create a ${k}`,
      kind: 'write',
      description: `Create a ${k} (Mandate assigns the id from the title: use the returned ref / ids; never pass id). ${kind === 'specs' ? 'Starts as draft; use spec_status_set to move it.' : kind === 'standards' ? 'appliesTo rules (repo:x, tag:x, category:x) make it apply to matching specs.' : 'kind service|module|library|datastore|external; owns: code path globs per repo (most specific glob wins in code_owner). layer (optional): ui|api|service|domain|data|infra or another slug; omitted, it is inherited from the parent or derived from depends_on. parent (optional): the containing component (a tree: one parent, no cycles, not archived). Typical sections: responsibility, interfaces, context (mermaid), rationale.'} Sections are optional here (${k}_section_insert).${COMMON}`,
      // DF-11: spec_create takes addresses / workOrder like the other doc writes (Feedback / Work-Order trailers).
      input: (kind === 'specs' ? withExtras(createSchema as unknown as z.ZodObject) : createSchema) as unknown as z.ZodObject,
      ...(kind === 'specs' ? { trailers: docEditTrailers } : {}),
      run: async (a, ctx) => {
        const commits: string[] = [];
        const out = await writes(ctx).create(kind, createSchema.parse(strip(a as Record<string, unknown>)) as never, metaOf(ctx, commits));
        return { ref: docUri(kind, out.value.id), uri: buildRef({ kind, id: out.value.id, ...(commits.length ? { commit: commits.at(-1) } : {}) }), ...commitsOf(commits), warnings: out.warnings, document: out.value };
      },
    }),
    defineTool({
      name: `${k}_update_meta`,
      title: `Update ${k} metadata`,
      kind: 'write',
      description: `Update frontmatter fields of a ${k} (null removes an optional field). ${kind === 'specs' ? 'Status: spec_status_set. Standards are linked from sections (follows), dependencies from section depends_on links.' : kind === 'components' ? 'Status: component_status_set. Dependencies: depends_on links from its sections.' : 'Sections: the section tools.'}${COMMON}`,
      input: withExtras(metaSchema as unknown as z.ZodObject),
      trailers: docEditTrailers,
      run: async (a, ctx) => {
        const { ref, ...patch } = metaSchema.parse(strip(a)) as { ref: string } & Record<string, unknown>;
        const commits: string[] = [];
        const out = await writes(ctx).updateMeta(kind, ref, patch, metaOf(ctx, commits));
        return { ref: docUri(kind, out.value.id), ...commitsOf(commits), warnings: out.warnings, document: { ...out.value, sections: out.value.sections.map((s) => s.id) } };
      },
    }),
    ...(kind === 'standards'
      ? [
          defineTool({
            name: 'standard_status_set',
            title: 'Set standard lifecycle status',
            kind: 'write',
            description: `Set a standard's lifecycle status (deprecated needs supersededBy). effectiveFrom: standard_update_meta.${COMMON}`,
            input: withExtras(standardStatusSetInputSchema),
            trailers: docEditTrailers,
            run: async (a, ctx) => {
              const { ref, status, supersededBy } = standardStatusSetInputSchema.parse(strip(a));
              const commits: string[] = [];
              const out = await writes(ctx).setStandardStatus(ref, status, supersededBy, metaOf(ctx, commits));
              const std = out.value as { id: string; status: string; supersededBy?: string };
              return { ref: docUri('standards', std.id), ...commitsOf(commits), warnings: [], status: std.status, ...(std.supersededBy ? { supersededBy: docUri('standards', std.supersededBy) } : {}) };
            },
          }),
        ]
      : []),
    ...(kind === 'components'
      ? [
          defineTool({
            name: 'component_status_set',
            title: 'Set component status',
            kind: 'write',
            description: `Set a component's lifecycle status (never deleted; archiving never cascades).${COMMON}`,
            input: withExtras(componentStatusSetInputSchema),
            trailers: docEditTrailers,
            run: async (a, ctx) => {
              const { ref, status, reason } = componentStatusSetInputSchema.parse(strip(a));
              const commits: string[] = [];
              const out = await writes(ctx).setComponentStatus(ref, status, metaOf(ctx, commits), reason);
              return { ref: docUri('components', out.value.id), ...commitsOf(commits), warnings: [], status: (out.value as { status: string }).status };
            },
          }),
          defineTool({
            name: 'component_archive',
            title: 'Archive a component',
            kind: 'write',
            description: `Archive a component (final). It leaves architecture_get (includeArchived shows it), still resolves, its owns globs stop claiming code; new links to it are rejected, existing ones show as broken.${COMMON}`,
            input: withExtras(componentArchiveInputSchema),
            trailers: docEditTrailers,
            run: async (a, ctx) => {
              const { ref, reason } = componentArchiveInputSchema.parse(strip(a));
              const commits: string[] = [];
              const out = await writes(ctx).setComponentStatus(ref, 'archived', metaOf(ctx, commits), reason);
              return { ref: docUri('components', out.value.id), ...commitsOf(commits), warnings: [], status: 'archived' };
            },
          }),
        ]
      : []),
    ...(kind === 'specs'
      ? [
          defineTool({
            name: 'spec_status_set',
            title: 'Set spec status',
            kind: 'write',
            description: `Set a spec's status (in_progress is derived, never set). A failing done gate returns done_gate with detail.failures (criterion, state, provenance path).${COMMON}`,
            input: withExtras(specStatusSetInputSchema),
            trailers: docEditTrailers,
            run: async (a, ctx) => {
              const { ref, status } = specStatusSetInputSchema.parse(strip(a));
              const commits: string[] = [];
              const out = await writes(ctx).setStatus(ref, status, metaOf(ctx, commits));
              const spec = out.value as StoredSpec;
              return { ref: docUri('specs', spec.id), ...commitsOf(commits), warnings: [], status: spec.status, ...(spec.gate ? { gate: spec.gate } : {}) };
            },
          }),
          defineTool({
            name: 'spec_archive',
            title: 'Archive a spec',
            kind: 'write',
            description: `Archive a spec (never deleted; cancels its open work orders; spec_status_set draft restores it).${COMMON}`,
            input: withExtras(specArchiveInputSchema),
            trailers: docEditTrailers,
            run: async (a, ctx) => {
              const { ref, reason } = specArchiveInputSchema.parse(strip(a));
              const commits: string[] = [];
              const out = await writes(ctx).setStatus(ref, 'archived', metaOf(ctx, commits), reason);
              return { ref: docUri('specs', out.value.id), ...commitsOf(commits), warnings: [], status: 'archived' };
            },
          }),
        ]
      : []),
    defineTool({
      name: `${k}_section_insert`,
      title: `Insert a ${k} section`,
      kind: 'write',
      description: `Insert a section into a ${k} (after / before a section id, or position first | last; default last). Mandate assigns its id from the title (returned ref). Section types: markdown, mermaid, html, ${kind === 'specs' ? 'acceptance (a criterion: method test|manual|review|metric, threshold for metric)' : kind === 'components' ? 'responsibility, interfaces, context (mermaid diagram), rationale' : 'rule (a criterion of the standard: level must|should|may, rationale, scope {paths, languages}, check {kind, command}, examples as code refs; must rules block done, should only warns)'}, ... Links: ${k}_section_link_add.${kind === 'specs' ? ` Generated files (HTML mockups, large diagrams): upload with curl (project_info.upload or upload_url_create), never inline.${SECTION_GUIDE}` : ''}${COMMON}`,
      input: withExtras(S.insert as unknown as z.ZodObject),
      trailers: docEditTrailers,
      run: async (a, ctx) => {
        const { doc, section, after, before, position } = S.insert.parse(strip(a));
        const commits: string[] = [];
        const out = await writes(ctx).sectionInsert(kind, doc, section, { after, before, position }, metaOf(ctx, commits));
        return sectionResult(ctx, out.value.id, out.sectionId, { commits, warnings: out.warnings });
      },
    }),
    defineTool({
      name: `${k}_section_update`,
      title: `Update a ${k} section`,
      kind: 'write',
      description: `Update a section's content (title, summary, body, type, refs, symbols, verifiedBy, method, threshold; null clears an optional field). Pass ref as copied; a ref with @sha must be the current version (else stale_version: re-read and retry). Archived sections cannot be edited. Section guide: spec_section_insert.${COMMON}`,
      input: withExtras(S.update as unknown as z.ZodObject),
      trailers: docEditTrailers,
      run: async (a, ctx) => {
        const { ref, ...patch } = S.update.parse(strip(a)) as { ref: string } & Record<string, unknown>;
        const commits: string[] = [];
        const out = await writes(ctx).sectionUpdate(kind, ref, patch, metaOf(ctx, commits));
        return sectionResult(ctx, out.value.id, parseRef(ref)!.sectionId!, { commits, warnings: out.warnings });
      },
    }),
    defineTool({
      name: `${k}_section_move`,
      title: `Move a ${k} section`,
      kind: 'write',
      description: `Move a section (exactly one of after, before, position first | last).${COMMON}`,
      input: withExtras(S.move as unknown as z.ZodObject),
      trailers: docEditTrailers,
      run: async (a, ctx) => {
        const { ref, after, before, position } = S.move.parse(strip(a));
        const commits: string[] = [];
        const out = await writes(ctx).sectionMove(kind, ref, { after, before, position }, metaOf(ctx, commits));
        return sectionResult(ctx, out.value.id, parseRef(ref)!.sectionId!, { commits, warnings: out.warnings });
      },
    }),
    defineTool({
      name: `${k}_section_archive`,
      title: `Archive a ${k} section`,
      kind: 'write',
      description: `Archive a section: it stays in the document (ids are never reused) and is no longer in force. Sections are never deleted. ${kind === 'specs' ? 'Pending work-order sections on it become obsolete.' : kind === 'components' ? 'Its depends_on links leave the architecture.' : 'Specs following it see it as archived.'}${COMMON}`,
      input: withExtras(S.archive as unknown as z.ZodObject),
      trailers: docEditTrailers,
      run: async (a, ctx) => {
        const { ref, reason } = S.archive.parse(strip(a));
        const commits: string[] = [];
        const out = await writes(ctx).sectionArchive(kind, ref, metaOf(ctx, commits), reason);
        return sectionResult(ctx, out.value.id, parseRef(ref)!.sectionId!, { commits, warnings: out.warnings });
      },
    }),
    defineTool({
      name: `${k}_section_link_add`,
      title: `Link a ${k} section`,
      kind: 'write',
      description: `Add a typed link from a section. ${kind === 'specs' ? 'Spec section -> spec section: depends_on, extends, relates_to, conflicts_with, supersedes. Spec section -> standard section or whole standard: follows, deviates_from (note required; a waiver needs feedback: an accepted item filed by someone else), relates_to. Spec section -> component or component section: affects.' : kind === 'components' ? 'Component section -> component or component section: depends_on (an architecture edge). Component section -> standard or standard section: follows, deviates_from (note required).' : 'Standard section -> standard section: extends, relates_to, conflicts_with, supersedes.'}
One link per target; cycles and superseded / archived targets are rejected (the hint names the successor).${COMMON}`,
      input: withExtras(S.linkAdd as unknown as z.ZodObject),
      trailers: docEditTrailers,
      run: async (a, ctx) => {
        const { ref, to, rel, note, feedback } = S.linkAdd.parse(strip(a));
        const commits: string[] = [];
        const out = await writes(ctx).linkAdd(kind, ref, { to, rel, note, feedback }, metaOf(ctx, commits));
        return sectionResult(ctx, out.value.id, parseRef(ref)!.sectionId!, { commits, warnings: out.warnings });
      },
    }),
    defineTool({
      name: `${k}_section_link_remove`,
      title: `Unlink a ${k} section`,
      kind: 'write',
      description: `Remove a link from a section (to, optionally rel). Unfollowing a standard from a done or claimed spec needs addresses: [accepted feedback].${COMMON}`,
      input: withExtras(S.linkRemove as unknown as z.ZodObject),
      trailers: docEditTrailers,
      run: async (a, ctx) => {
        const { ref, to, rel } = S.linkRemove.parse(strip(a));
        const commits: string[] = [];
        const out = await writes(ctx).linkRemove(kind, ref, { to, rel }, metaOf(ctx, commits));
        return sectionResult(ctx, out.value.id, parseRef(ref)!.sectionId!, { commits, warnings: out.warnings });
      },
    }),
  ];
}

/* ---------------------------------------------------------------- work orders */

const woResult = async (ctx: ToolContext, id: string, commits: string[], extra: Record<string, unknown> = {}, warnings: string[] = []) => ({
  ref: buildRef({ kind: 'work-orders', id }),
  ...commitsOf(commits),
  warnings,
  workOrder: (await ctx.reads.workOrderGet({ ref: id })) as unknown,
  ...extra,
});

/** `claim_overlap` warnings: other open work orders touching the same files (never an error). */
async function overlapWarnings(ctx: ToolContext, id: string) {
  const overlaps = await ctx.storage.workOrderService.overlaps(id);
  return {
    overlaps,
    warnings: overlaps.map((o) => `claim_overlap: work order ${o.workOrder} (${o.status}${o.agent ? `, claimed by ${o.agent}` : ''}) also touches ${o.files.slice(0, 10).join(', ')}${o.files.length > 10 ? ', ...' : ''}: coordinate (comment_add) before changing them`),
  };
}

const WO_COMMON = COMMON;
const GIT_NOTE = 'git (per repo, fields as work_order_git_update)';

const workOrderTools: AnyToolDef[] = [
  defineTool({
    name: 'work_order_create',
    title: 'Create a work order',
    kind: 'write',
    description: `Ask for work on sections of ONE spec, pinned to its current version (or specCommit): kind implement | update | review | verify | fix, priority p0..p3, note (why), reason (feedback items it acts on), plan (markdown; or later with work_order_plan_set), title, dependencies (work orders to finish first), fastPath (kind fix with one section: claimable without a plan). The work order is a markdown document work-orders/<id>.md (plan, one section per targeted spec section, reconciliation, outcome). At most one open implement/update work order per spec section.${COMMON}`,
    input: workOrderCreateInputSchema,
    // L-2: the feedback a work order acts on is its recorded cause (Caused-By), so lineage reaches it both ways.
    causes: (a) => a.reason?.map((r) => buildRef({ kind: 'feedback', id: idOf(r) })),
    run: async (a, ctx) => {
      const commits: string[] = [];
      const spec = idOf(a.spec);
      const sections = a.sections.map((s) => parseRef(s)?.sectionId ?? s);
      const bad = sections.find((s) => !slugSchema.safeParse(s).success);
      if (bad) throw Object.assign(new Error(`invalid section '${bad}'`), { statusCode: 400 });
      const wo = await ctx.storage.workOrderService.create(
        {
          spec,
          kind: a.kind,
          status: 'pending',
          sections: sections.map((id) => ({ id })),
          ...(a.priority ? { priority: a.priority } : {}),
          ...(a.note ? { note: a.note } : {}),
          ...(a.reason ? { reason: a.reason.map(idOf) } : {}),
          ...(a.specCommit ? { specCommit: a.specCommit } : {}),
          ...(a.title ? { title: a.title } : {}),
          ...(a.plan ? { plan: a.plan } : {}),
          ...(a.fastPath ? { fastPath: true } : {}),
          ...(a.dependencies?.length ? { dependencies: a.dependencies.map(idOf) } : {}),
          createdBy: ctx.commit!.agent,
        },
        metaOf(ctx, commits),
      );
      return woResult(ctx, wo.id, commits);
    },
  }),
  defineTool({
    name: 'work_order_next',
    title: 'Take the next work order',
    kind: 'write',
    description: `Atomically pick AND claim the next eligible work order for you: open, unclaimed (or stale, or already yours), with a plan (or a fast-path fix), no pending section blocked or broken, matching the filters (kinds, spec, priority, repo, category, tags); highest priority first (p0), then oldest. Concurrent callers never get the same item. Returns workOrder: null when nothing is eligible (skipped lists why, e.g. no plan yet). No git input: record it with work_order_git_update.${WO_COMMON}`,
    input: workOrderNextInputSchema,
    run: async (a, ctx) => {
      const commits: string[] = [];
      const specOk = (s: StoredSpec) => (!a.repo || s.repo === a.repo) && (!a.category || s.category === a.category) && (!a.tags || a.tags.some((t) => s.tags.includes(t)));
      const { workOrder, skipped } = await ctx.storage.workOrderService.next(
        { kinds: a.kinds, spec: a.spec ? idOf(a.spec) : undefined, priority: a.priority, specs: specOk },
        { agent: ctx.commit!.agent, ...(ctx.commit!.branch ? { branch: ctx.commit!.branch } : {}), ...(a.worktree ? { worktree: a.worktree } : {}) },
        metaOf(ctx, commits),
      );
      if (!workOrder) return { ref: null, workOrder: null, skipped, commit: null, commits, warnings: [] };
      const o = await overlapWarnings(ctx, workOrder.id);
      return woResult(ctx, workOrder.id, commits, { skipped, overlaps: o.overlaps }, o.warnings);
    },
  }),
  defineTool({
    name: 'work_order_claim',
    title: 'Claim a work order',
    kind: 'write',
    description: `Claim a work order (records agent, branch, worktree; takes over a stale claim). Optional ${GIT_NOTE}. Warns claim_overlap when another open work order touched the same files.${WO_COMMON}`,
    input: workOrderClaimInputSchema,
    run: async (a, ctx) => {
      const commits: string[] = [];
      const id = idOf(a.ref);
      await ctx.storage.workOrderService.claim({ id, agent: ctx.commit!.agent, ...(ctx.commit!.branch ? { branch: ctx.commit!.branch } : {}), ...(a.worktree ? { worktree: a.worktree } : {}), ...(a.git ? { git: a.git } : {}) }, metaOf(ctx, commits));
      const o = await overlapWarnings(ctx, id);
      return woResult(ctx, id, commits, { overlaps: o.overlaps }, o.warnings);
    },
  }),
  defineTool({
    name: 'work_order_heartbeat',
    title: 'Heartbeat a claim',
    kind: 'write',
    description: `Keep your claim alive (a claim without heartbeat for 30 minutes is stale and can be taken over). Runtime state only: no commit, unless you pass git fields that change the work order (${GIT_NOTE}).${WO_COMMON}`,
    input: workOrderHeartbeatInputSchema,
    run: async (a, ctx) => {
      const commits: string[] = [];
      const id = idOf(a.ref);
      await ctx.storage.workOrderService.heartbeat({ id, agent: ctx.commit!.agent, ...(a.git ? { git: a.git } : {}) }, metaOf(ctx, commits));
      return woResult(ctx, id, commits);
    },
  }),
  defineTool({
    name: 'work_order_release',
    title: 'Release a claim',
    kind: 'write',
    description: `Give a work order back (claim moved to claims as released; in_progress -> pending).${WO_COMMON}`,
    input: workOrderRefInputSchema,
    uiAllowed: true,
    run: async (a, ctx) => {
      const commits: string[] = [];
      const id = idOf(a.ref);
      let agent = ctx.commit!.agent;
      // Web UI (a human decision): release ANOTHER agent's claim, only once it is stale (no heartbeat recently).
      if (ctx.principal?.kind === 'ui') {
        const cur = await ctx.storage.workOrderService.get(id);
        if (!cur.claim) throw Object.assign(new Error(`not_claimed: work order ${id} is not claimed`), { statusCode: 409, code: 'not_claimed' });
        if (!isClaimStale(cur.claim)) throw Object.assign(new Error(`claim_fresh: ${cur.claim.agent} sent a heartbeat ${cur.claim.heartbeatAt}; only a stale claim can be released from the UI`), { statusCode: 409, code: 'claim_fresh' });
        agent = cur.claim.agent;
      }
      await ctx.storage.workOrderService.release({ id, agent }, { ...metaOf(ctx, commits), ...(agent !== ctx.commit!.agent ? { message: `work order: release stale claim of ${agent} on ${id}` } : {}) });
      return woResult(ctx, id, commits);
    },
  }),
  defineTool({
    name: 'work_order_section_done',
    title: 'Mark work-order sections done',
    kind: 'write',
    description: `Mark sections (spec section ids or work-order section refs) done or obsolete, writing notes (appended), codeRefs ("repo:path#Lx-Ly" or { repo, path, lines, symbols, change, from }; merged into touched), deviations and verifications into each. implement/update: records implementedCommit on the spec sections. Optional ${GIT_NOTE}, touched.${WO_COMMON}`,
    input: workOrderSectionDoneInputSchema,
    run: async (a, ctx) => {
      const commits: string[] = [];
      const id = idOf(a.ref);
      // MW-12: the caller must hold the claim (checked inside the write lock).
      const w = await ctx.storage.workOrderService.sectionDone(
        { id, agent: ctx.commit!.agent, sections: a.sections, status: a.status, notes: a.notes, codeRefs: a.codeRefs, deviations: a.deviations, verifications: a.verifications, git: a.git, touched: a.touched },
        metaOf(ctx, commits),
      );
      const warnings: string[] = [];
      if (w.sections.every((s) => s.status !== 'pending')) warnings.push('every section is finished: reconcile specs / components with the code, then work_order_complete with the outcome');
      if (a.status === 'done' && !a.codeRefs?.length && !a.touched?.length) warnings.push('no code refs given for these sections: record the code you changed (codeRefs here, or work_order_touch with section)');
      return woResult(ctx, id, commits, {}, warnings);
    },
  }),
  defineTool({
    name: 'work_order_complete',
    title: 'Complete a work order',
    kind: 'write',
    description: `Finish a work order: outcome (what was delivered; required), reconciliation (what you updated). Remaining pending sections are marked done; the work order is then frozen (only PR / merge fields change). Optional ${GIT_NOTE} (final headCommit, PR, merge), touched.${WO_COMMON}`,
    input: workOrderCompleteInputSchema,
    run: async (a, ctx) => {
      const commits: string[] = [];
      const id = idOf(a.ref);
      const { warnings } = await ctx.storage.workOrderService.complete(id, ctx.commit!.agent, { outcome: a.outcome, reconciliation: a.reconciliation, git: a.git, touched: a.touched }, metaOf(ctx, commits));
      return woResult(ctx, id, commits, {}, warnings);
    },
  }),
  defineTool({
    name: 'work_order_fail',
    title: 'Fail a work order',
    kind: 'write',
    description: `Mark a work order failed with a note (why); claim it again to retry.${WO_COMMON}`,
    input: workOrderFailInputSchema,
    run: async (a, ctx) => {
      const commits: string[] = [];
      const id = idOf(a.ref);
      await ctx.storage.workOrderService.close(id, 'failed', ctx.commit!.agent, a.note, metaOf(ctx, commits));
      return woResult(ctx, id, commits);
    },
  }),
  defineTool({
    name: 'work_order_cancel',
    title: 'Cancel a work order',
    kind: 'write',
    description: `Cancel a work order (final).${WO_COMMON}`,
    input: workOrderCancelInputSchema,
    run: async (a, ctx) => {
      const commits: string[] = [];
      const id = idOf(a.ref);
      await ctx.storage.workOrderService.close(id, 'cancelled', ctx.commit!.agent, a.note, metaOf(ctx, commits));
      return woResult(ctx, id, commits);
    },
  }),
];

/* ---------------------------------------------------------------- feedback */

const fbResult = async (ctx: ToolContext, id: string, commits: string[]) => ({
  ref: buildRef({ kind: 'feedback', id }),
  ...commitsOf(commits),
  warnings: [] as string[],
  ...(await ctx.reads.feedbackGet({ ref: id }).then((r) => ({ feedback: (r as { feedback: unknown }).feedback, targets: (r as { targets: unknown }).targets }))),
});
/** Feedback targets as stored: canonical refs (line ranges kept; `@mandate:` prefix dropped). */
const target = (t: string) => {
  const r = parseRef(t);
  if (r) return buildRef({ kind: r.kind, id: r.id, sectionId: r.sectionId, ...(r.lines ? { lines: r.lines } : {}) });
  const n = parseNodeUri(t);
  return n ? buildNodeUri(n) : t;
};

const feedbackTools: AnyToolDef[] = [
  defineTool({
    name: 'feedback_create',
    title: 'File feedback',
    kind: 'write',
    description: `File feedback on sections (#Lx-Ly ranges allowed) or verification results (improvement / bug at intake: targets may wait until spec_match; set them with feedback_update): kind ambiguity | conflict | bug | improvement | question, body (the why), quote (the exact text), relatedTo, fromFinding (the audit finding it comes from: spec_wrong / ambiguous findings). Starts open; the author is your agent identity (approvals of waivers need feedback from someone else).${COMMON}`,
    input: feedbackCreateInputSchema,
    run: async (a, ctx) => {
      const commits: string[] = [];
      // From an audit finding (spec_wrong / ambiguous): the finding must exist; it records the feedback in its resolution.
      const from = a.fromFinding ? await ctx.storage.auditService.requireFinding(a.fromFinding) : null;
      const relatedTo = await relatedOf(ctx, a.relatedTo ?? []);
      // MW-11: the item and the finding backlink are written under one hold of the (re-entrant) write lock.
      const f = await ctx.storage.lock.run(async () => {
        const created = await ctx.storage.feedbackService.create(
          { targets: a.targets.map(target), kind: a.kind, body: a.body, ...(a.quote ? { quote: a.quote } : {}), relatedTo, ...(from ? { fromFinding: from.uri } : {}) },
          metaOf(ctx, commits),
        );
        if (from) await ctx.storage.auditService.linkFeedback(from.uri, created.id, ctx.commit!.agent, metaOf(ctx, commits, { Audit: from.audit }));
        return created;
      });
      return fbResult(ctx, f.id, commits);
    },
  }),
  defineTool({
    name: 'feedback_update',
    title: 'Update feedback',
    kind: 'write',
    description: `Edit an open or accepted feedback item (body, targets, relatedTo: feedback or any element reference). Closed items are immutable (code feedback_closed).${COMMON}`,
    input: feedbackUpdateInputSchema,
    run: async (a, ctx) => {
      const commits: string[] = [];
      const id = idOf(a.ref);
      await ctx.storage.feedbackService.update(
        id,
        { ...(a.body ? { body: a.body } : {}), ...(a.targets ? { targets: a.targets.map(target) } : {}), ...(a.relatedTo ? { relatedTo: await relatedOf(ctx, a.relatedTo) } : {}) },
        metaOf(ctx, commits),
      );
      return fbResult(ctx, id, commits);
    },
  }),
  defineTool({
    name: 'feedback_accept',
    title: 'Accept feedback',
    kind: 'write',
    uiAllowed: true,
    description: `Accept a feedback item: it will be acted on; it approves waivers / exemptions / criteria removals written by someone other than its filer and accepter. override: true + overrideReason lets it approve your own: only when the user explicitly says so (sole active user or admin; recorded); never to pass a gate. cause: an answered approval question records who approved.${COMMON}`,
    input: feedbackAcceptInputSchema,
    run: async (a, ctx) => {
      const commits: string[] = [];
      const id = idOf(a.ref);
      // An answered `approval` question cited as cause: the answering user approved (and is the one checked for an override).
      const proof = await questionProof(ctx, ['approval']);
      if (proof) ctx = withTrailers({ ...ctx, commit: { ...ctx.commit!, ...(proof.user ? { user: proof.user } : {}) } }, { 'User-Approved': proof.id, 'Approved-By': proof.by });
      if (a.override) {
        if (!a.overrideReason?.trim()) throw Object.assign(new Error('override needs overrideReason (why self-approval is acceptable)'), { statusCode: 400, code: 'validation' });
        const e = await overrideEligibility(ctx);
        if (!e.ok) throw Object.assign(new Error(`override_not_allowed: ${e.why}`), { statusCode: 403, code: 'override_not_allowed' });
      }
      const cur = await ctx.storage.feedback.get(id);
      await ctx.storage.feedbackService.update(id, cur.status === 'accepted' ? {} : { status: 'accepted' }, metaOf(ctx, commits), { ...(a.override ? { override: a.overrideReason!.trim() } : {}), ...(proof?.user ? { acceptedBy: proof.user } : {}) });
      return fbResult(ctx, id, commits);
    },
  }),
  defineTool({
    name: 'feedback_close',
    title: 'Close feedback',
    kind: 'write',
    uiAllowed: true,
    description: `Close a feedback item: applied (changes come from commits with its Feedback trailer), rejected (resolutionNote) or duplicate (duplicateOf). Closed is immutable.${COMMON}`,
    input: feedbackCloseInputSchema,
    run: async (a, ctx) => {
      const commits: string[] = [];
      const id = idOf(a.ref);
      // The UI records decisions only: "applied" means content changed, which agents write (and cite) themselves.
      if (ctx.principal?.kind === 'ui' && a.resolution === 'applied') throw Object.assign(new Error('forbidden: the web UI can reject or mark duplicate; an agent closes an item as applied when its change is written'), { statusCode: 403, code: 'forbidden' });
      await ctx.storage.feedbackService.update(
        id,
        { status: 'closed', resolution: a.resolution, ...(a.resolutionNote ? { resolutionNote: a.resolutionNote } : {}), ...(a.duplicateOf ? { duplicateOf: idOf(a.duplicateOf) } : {}) },
        metaOf(ctx, commits),
      );
      return fbResult(ctx, id, commits);
    },
  }),
];

/* ---------------------------------------------------------------- verification and diff */

const verificationTools: AnyToolDef[] = [
  defineTool({
    name: 'verification_record',
    title: 'Record a verification result',
    kind: 'write',
    description: `Append a verification result for an acceptance criterion (append-only; the server sets the time and the author = your agent identity): criterion (acceptance section ref), appliedTo (the spec; required for standard criteria), specCommit (default HEAD), code { repo, commit, branch }, result pass | fail | skipped (skipped verifies nothing), method test | manual | review | metric, evidence { test, ci, note }.${COMMON}`,
    input: verificationRecordInputSchema,
    run: async (a, ctx) => {
      const commits: string[] = [];
      const c = parseRef(a.criterion)!;
      const r = await ctx.storage.verificationService.record(
        {
          criterion: buildRef({ kind: c.kind, id: c.id, sectionId: c.sectionId }),
          ...(a.appliedTo ? { appliedTo: buildRef({ kind: 'specs', id: idOf(a.appliedTo) }) } : {}),
          ...(a.specCommit ?? c.commit ? { specCommit: a.specCommit ?? c.commit } : {}),
          code: a.code,
          result: a.result,
          method: a.method,
          evidence: a.evidence ?? {},
          ...(a.codeRefs?.length ? { codeRefs: a.codeRefs } : {}),
          by: ctx.commit!.agent,
        },
        metaOf(ctx, commits),
      );
      return { ref: buildNodeUri({ kind: 'verifications', id: r.id }), ...commitsOf(commits), warnings: [], verification: r };
    },
  }),
  defineTool({
    name: 'spec_diff_since_implemented',
    title: 'Diff since implemented',
    kind: 'read',
    description: `What changed in spec sections since they were implemented: a work order's sections between its pinned specCommit and HEAD (workOrder), or given section refs each since their implementedCommit (sections). Per section: status (unchanged | modified | added | removed | missing | never_implemented | pin_lost), title change, body diff ops, metadata changes.`,
    input: specDiffSinceImplementedInputSchema,
    run: (a, ctx) => writes(ctx).diffSinceImplemented(a),
  }),
];

/** Standards are cross-cutting: every standard write needs the user's explicit confirmation first (recorded, not enforced). */
export const STANDARD_CONFIRMATION = 'Needs the user\'s confirmation, even with approval off: cite an answered standard_confirmation question (question_ask) as cause (questions in chat: confirmedByUser: true).\n';

/**
 * Flow on (settings known): a standard write needs proof of the user's confirmation, an answered standard_confirmation
 * question cited as cause; a client whose questions go to chat may pass confirmedByUser: true instead. Flow off or no
 * settings (in-process seeds, tests): recorded only.
 */
async function requireConfirmation(ctx: ToolContext, flag: boolean): Promise<void> {
  if (!ctx.settings || ctx.principal?.kind === 'ui') return;
  const eff = effective(ctx.settings.policy(), await ctx.settings.clients.get(ctx.settings.project, clientIdentity(ctx).id));
  if (eff.flow === 'off') return;
  if (eff.questions === 'chat' && flag) return;
  throw new ToolError(
    'confirmation_required',
    eff.questions === 'chat' ? 'standard writes need the user\'s explicit confirmation: ask in chat, then pass confirmedByUser: true' : 'standard writes need the user\'s confirmation: cite an answered standard_confirmation question (question_ask) as cause; confirmedByUser alone is not enough',
    ERROR_ACTIONS.confirmation_required,
    'cause',
  );
}

/** Adds the confirmation note and the optional `confirmedByUser` flag (→ `User-Confirmed: yes` trailer) to a standard write tool. */
export function withUserConfirmation(def: AnyToolDef): AnyToolDef {
  const input = def.input as unknown as z.ZodObject;
  if (typeof input.extend !== 'function') throw new Error(`${def.name}: input must be a z.object`);
  return {
    ...def,
    description: typeof def.description === 'string' ? STANDARD_CONFIRMATION + def.description : async (c) => STANDARD_CONFIRMATION + (await (def.description as (x: typeof c) => Promise<string> | string)(c)),
    input: input.extend({ confirmedByUser: z.boolean().optional() }).strict() as unknown as AnyToolDef['input'],
    trailers: (a: Record<string, unknown>) => ({ ...(def.trailers?.(a as never) ?? {}), 'User-Confirmed': a.confirmedByUser === true ? 'yes' : undefined }),
    run: async (a: Record<string, unknown>, ctx) => {
      const { confirmedByUser: _c, ...rest } = a;
      // An answered standard_confirmation question cited as cause: User-Confirmed names it and the answering user.
      const proof = await questionProof(ctx, ['standard_confirmation']);
      if (!proof) await requireConfirmation(ctx, a.confirmedByUser === true);
      return def.run(rest as never, proof ? withTrailers(ctx, { 'User-Confirmed': proof.id, 'Confirmed-By': proof.by }) : ctx);
    },
  } as AnyToolDef;
}

export const writeTools: AnyToolDef[] = [...docWriteTools('specs'), ...docWriteTools('standards').map(withUserConfirmation), ...docWriteTools('components'), ...workOrderTools, ...feedbackTools, ...verificationTools];

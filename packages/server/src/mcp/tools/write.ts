/**
 * Document, work-order, feedback and verification WRITE tools. Each is a thin wrapper over a storage service
 * (shared with any future REST route): strict input schema (`@mandate/shared` write-schemas), domain rules in the
 * services (inside the write lock), the whole document validated before the commit. Every write returns the
 * canonical refs, the commit(s), warnings and, for section edits, the resulting section with its derived states.
 */
import {
  allSectionsFinished,
  isClaimStale,
  SERVICE_USER_PREFIX,
  userOfTrailers,
  buildNodeUri,
  buildRef,
  componentSectionInputSchemas,
  requestCloseInputSchema,
  requestCreateInputSchema,
  requestUpdateInputSchema,
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
  touchedFromInput,
  type CodeLink,
  type TouchedInput,
} from '@mandate/shared';
import { slugSchema } from '@mandate/doc';
import { canonicalRef, extractRefs } from '@mandate/shared/refs';
import { ANY, deliverAssigned, wakeableAny } from '../../flow/assign.js';
import { newsOfProject } from '../../comments/route.js';
import { z } from 'zod';
import { DocWriteService, type DocKind } from '../../storage/doc-writes.js';
import { coveredCriteria } from '../../storage/work-order-plan.js';
import { resolveCauses } from '../../storage/causes.js';
import { parseCommitMessage } from '../../storage/history.js';
import type { CommitMeta } from '../../storage/index.js';
import { defineTool, type AnyToolDef, type ToolContext } from '../define.js';
import { questionProof, withTrailers } from './questions.js';
import { ToolError } from '../errors.js';
import { checkClaim, checkCodeRepos, registeredCodeRepos, requireCommit, stampLocations, repoOfLocation } from '../code-claims.js';
import { clientIdentity, effective } from '../../projects/settings.js';
import { componentArchiveInputSchema, componentCreateInputSchema, componentStatusSetInputSchema, componentUpdateMetaInputSchema } from './components.js';

/* ---------------------------------------------------------------- helpers */

const SOFT_LIMIT = 600;
const idOf = (refOrId: string) => parseRef(refOrId)?.id ?? (parseNodeUri(refOrId) as { id?: string } | null)?.id ?? refOrId;
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
  Request: a.addresses?.length ? a.addresses.map(idOf).join(', ') : undefined,
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

/** Added to the create / update_meta descriptions of specs, standards and components. */
const TLDR_GUIDE = ' tldr: plain-language overview for a human reader (2-5 short sentences or bullets, markdown, max 1200 chars, no jargon, no ids or refs: what it is, why it exists, the key behaviours); write it on create, refresh it whenever a change alters what the document does. summary stays the terse one-liner.';
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
      description: `Create a ${k} (Mandate assigns the id from the title: use the returned ref / ids; never pass id). ${kind === 'specs' ? 'Starts as draft; use spec_status_set to move it.' : kind === 'standards' ? 'appliesTo rules (repo:x, tag:x, category:x) make it apply to matching specs.' : 'kind service|module|library|datastore|external; owns: code path globs per repo (most specific glob wins in code_owner). layer (optional): ui|api|service|domain|data|infra or another slug; omitted, it is inherited from the parent or derived from depends_on. parent (optional): the containing component (a tree: one parent, no cycles, not archived). Architecture level, few: not one per folder or class; reuse first (architecture_get). Typical sections: responsibility, interfaces, context (mermaid), rationale.'} Sections are optional here (${k}_section_insert).${COMMON}${TLDR_GUIDE}`,
      // DF-11: spec_create takes addresses / workOrder like the other doc writes (Request / Work-Order trailers).
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
      description: `Update frontmatter fields of a ${k} (null removes an optional field). ${kind === 'specs' ? 'Status: spec_status_set. Standards are linked from sections (follows), dependencies from section depends_on links.' : kind === 'components' ? 'Status: component_status_set. Dependencies: depends_on links from its sections.' : 'Sections: the section tools.'}${TLDR_GUIDE}${COMMON}`,
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
      description: `Insert a section into a ${k} (after / before a section id, or position first | last; default last). Mandate assigns its id from the title (returned ref). Section types: markdown, mermaid, html, ${kind === 'specs' ? 'acceptance (a criterion: method test|manual|review|metric, threshold for metric)' : kind === 'components' ? 'responsibility, interfaces, context (mermaid diagram), rationale' : 'rule (a criterion of the standard: level must|should|may, rationale, scope {paths, languages}, check {kind, command}, examples as code refs; must rules block done, should only warns)'}, ... Links: ${k}_section_link_add.${kind === 'specs' ? ` Generated files (HTML mockups, large diagrams, images with alt): upload with curl (project_info.upload or upload_url_create), never inline.${SECTION_GUIDE}` : ''}${COMMON}`,
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
      description: `Add a typed link from a section. ${kind === 'specs' ? 'Spec section -> spec section: depends_on, extends, relates_to, conflicts_with, supersedes. Spec section -> standard section or whole standard: follows, deviates_from (note required; a waiver is in force only with the user approval of an answered question_ask (purpose approval) cited as cause), relates_to. Spec section -> component or component section: affects.' : kind === 'components' ? 'Component section -> component or component section: depends_on (an architecture edge). Component section -> standard or standard section: follows, deviates_from (note required).' : 'Standard section -> standard section: extends, relates_to, conflicts_with, supersedes.'}
One link per target; cycles and superseded / archived targets are rejected (the hint names the successor).${COMMON}`,
      input: withExtras(S.linkAdd as unknown as z.ZodObject),
      trailers: docEditTrailers,
      run: async (a, ctx) => {
        const { ref, to, rel, note } = S.linkAdd.parse(strip(a));
        const commits: string[] = [];
        const out = await writes(ctx).linkAdd(kind, ref, { to, rel, note }, metaOf(ctx, commits));
        return sectionResult(ctx, out.value.id, parseRef(ref)!.sectionId!, { commits, warnings: out.warnings });
      },
    }),
    defineTool({
      name: `${k}_section_link_remove`,
      title: `Unlink a ${k} section`,
      kind: 'write',
      description: `Remove a link from a section (to, optionally rel). Unfollowing a standard from a done or claimed spec needs the user's approval (cite an answered question_ask purpose approval as cause).${COMMON}`,
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

/** Repos for which a git input records a commit (headCommit / commits). */
const committedRepos = (git: { repo: string; headCommit?: string; commits?: string[] }[] | undefined) => new Set((git ?? []).filter((g) => g.headCommit || g.commits?.length).map((g) => g.repo));

/** Work order kinds that change code: completing them needs the commits that implemented them. */
const CODE_KINDS = new Set(['implement', 'update', 'fix']);

/**
 * work_order_complete: the commits that implemented it (git[] now or recorded before: headCommit / commits per repo),
 * repos registered; code locations without a commit get their repo's final commit, and dirty claims of this work order
 * (touched entries, the claiming agent's dirty verifications of the spec since the claim) are linked to that commit.
 */
async function completionCode(ctx: ToolContext, id: string, git: { repo: string; headCommit?: string; commits?: string[] }[] | undefined, touched: TouchedInput[] | undefined) {
  const warnings: string[] = [];
  const wo = await ctx.storage.workOrderService.get(id);
  const doc = await ctx.storage.workOrderDocs.get(id);
  warnings.push(...checkCodeRepos(ctx, [...(git ?? []).map((g) => g.repo), ...(touched ?? []).map((t) => repoOfLocation(t) ?? '').filter(Boolean)], 'git'));
  // Final commit per repo: this call's git, else what was recorded before.
  const head = new Map<string, string>();
  for (const g of doc.git ?? []) {
    const c = g.headCommit ?? g.commits?.at(-1);
    if (c) head.set(g.repo, c);
  }
  for (const g of git ?? []) {
    const c = g.headCommit ?? g.commits?.at(-1);
    if (c) head.set(g.repo, c);
  }
  const links: CodeLink[] = [];
  if (CODE_KINDS.has(wo.kind) && !head.size && registeredCodeRepos(ctx)) {
    warnings.push(...requireCommit(ctx, `work order ${id} (${wo.kind}) has no code commit recorded`, 'pass git: [{ repo, headCommit }] (the commit that implemented it; commit uncommitted work first), or record it with work_order_git_update', 'git'));
  }
  // Touched entries without a commit (incl. dirty claims): the repo's final commit.
  const extra: TouchedInput[] = [];
  for (const t of [...(doc.touched ?? []), ...(touched ?? []).map(touchedFromInput)]) {
    const c = head.get(t.repo);
    if (!t.commits?.length && c) extra.push({ ...t, commits: [c] } as TouchedInput);
  }
  const missing = [...new Set([...(doc.touched ?? []), ...(touched ?? []).map(touchedFromInput)].filter((t) => !t.commits?.length && !head.has(t.repo)).map((t) => t.repo))];
  if (missing.length && registeredCodeRepos(ctx)) warnings.push(...requireCommit(ctx, `code locations in ${missing.join(', ')} have no commit`, 'pass git: [{ repo, headCommit }] for each repo you changed', 'git'));
  // Dirty verifications recorded for this spec by the claiming agent since the claim.
  const since = wo.claim?.startedAt ?? wo.createdAt;
  const agent = wo.claim?.agent;
  if (head.size && agent) {
    const spec = buildRef({ kind: 'specs', id: wo.spec });
    for (const r of await ctx.storage.verificationService.list()) {
      const code = r.code as { repo: string; commit: string; dirty?: boolean };
      const c = head.get(code.repo);
      if (code.dirty && c && r.appliedTo === spec && r.by === agent && r.at >= since) links.push({ ref: buildNodeUri({ kind: 'verifications', id: r.id }), repo: code.repo, base: code.commit, commit: c });
    }
  }
  return { touched: touched || extra.length ? [...(touched ?? []), ...extra] : undefined, links, warnings };
}

/** The open work order on this spec that covers the criterion (the caller's, else the only one): where its test was delivered. */
async function workOrderOf(ctx: ToolContext, specId: string, criterionId: string): Promise<string | undefined> {
  const spec = await ctx.storage.specs.get(specId).catch(() => null);
  const open = (await ctx.storage.workOrderService.list()).filter(
    (w) => w.spec === specId && ['pending', 'in_progress'].includes(w.status) && ['implement', 'update', 'fix'].includes(w.kind) && coveredCriteria(spec, w.sections.map((s) => s.id)).some((c) => c.id === criterionId),
  );
  // Yours (the last section done releases the claim, so a finished-but-open one has none), else the only candidate.
  return open.find((w) => w.claim?.agent === ctx.commit!.agent)?.id ?? (open.length === 1 ? open[0]!.id : undefined);
}

const WO_COMMON = COMMON;
const GIT_NOTE = 'git (per repo, fields as work_order_git_update)';

const workOrderTools: AnyToolDef[] = [
  defineTool({
    name: 'work_order_create',
    title: 'Create a work order',
    kind: 'write',
    description: `Ask for work on sections of ONE spec, pinned to its current version (or specCommit): kind implement | update | review | verify | fix, priority p0..p3, note (why), reason (requests it acts on), title, dependencies (work orders to finish first), fastPath (kind fix with one section: no plan needed). plan is REQUIRED for implement / update / fix and carries everything: { steps: [..], files: [files to change], tests: [{ name, ref?, proves: [acceptance criterion ids] }], risks: [..] }; every acceptance criterion of the targeted sections (own, or listed in verifiedBy) must be proved by a planned test (plan_invalid names the missing ones); review / verify take a markdown string. The work order cannot complete until each criterion has a passing verification_record naming its test. The work order is a markdown document work-orders/<id>.md (plan, one section per targeted spec section, reconciliation, outcome). At most one open implement/update work order per spec section.${COMMON}`,
    input: workOrderCreateInputSchema,
    // L-2: the feedback a work order acts on is its recorded cause (Caused-By), so lineage reaches it both ways.
    causes: (a) => a.reason?.map((r) => buildRef({ kind: 'feedback', id: idOf(r) })),
    run: async (a, ctx) => {
      const commits: string[] = [];
      const spec = idOf(a.spec);
      const sections = a.sections.map((s) => parseRef(s)?.sectionId ?? s);
      const bad = sections.find((s) => !slugSchema.safeParse(s).success);
      if (bad) throw Object.assign(new Error(`invalid section '${bad}'`), { statusCode: 400 });
      const needsPlan = (a.kind === 'implement' || a.kind === 'update' || a.kind === 'fix') && !a.fastPath;
      if (needsPlan && (!a.plan || typeof a.plan === 'string')) {
        throw new ToolError('plan_required', `a ${a.kind} work order carries the full plan from creation: plan { steps, files, tests: [{ name, proves: [criterion ids] }], risks }`, ERROR_ACTIONS.plan_required!, 'plan');
      }
      // Flow order: a request is matched against the specs and changed (spec / standard commits that address it) before
      // work orders exist for it. The fast-path fix route is exempt (no behaviour change).
      if (!a.fastPath) {
        for (const rid of (a.reason ?? []).map(idOf)) {
          const f = await ctx.storage.feedbackService.get(rid).catch(() => null);
          if (!f || f.status === 'closed') continue;
          const hasChange = f.changes.some((c) => c.kind === 'specs' || c.kind === 'standards');
          const missing = [...(f.specMatch ? [] : ['spec_match recorded on it (spec_match { request, for: "' + rid + '" })']), ...(hasChange ? [] : ['a spec / standard change that addresses it (edit with addresses: [mandate://requests/' + rid + '])'])];
          if (missing.length) {
            throw new ToolError('flow_out_of_order', `flow_out_of_order: request ${rid} is not ready for a work order: it needs ${missing.join(' and ')}`, `call flow_next { request: "${rid}" } and follow it; a bug fix without behaviour change: kind fix, fastPath: true`, 'reason', { kind: 'request', request: rid, missing });
          }
        }
      }
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
      // Plan-only requests: their work orders are not taken until the user approved the plan in the web UI.
      const planOnly = (await ctx.storage.feedbackService.list()).filter((f) => f.status !== 'closed' && f.planOnly);
      const hold = (w: { reason: string[] }) => {
        const f = planOnly.find((x) => w.reason.includes(x.id));
        return f ? `plan_not_approved: request ${f.id} is plan-only; the user approves the plan in the web UI first (flow_next { request: "${f.id}" } says plan_ready)` : null;
      };
      const { workOrder, skipped } = await ctx.storage.workOrderService.next(
        { kinds: a.kinds, spec: a.spec ? idOf(a.spec) : undefined, priority: a.priority, specs: specOk, hold },
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
      const cw = checkCodeRepos(ctx, (a.git ?? []).map((g) => g.repo), 'git');
      // Plan-only requests: no claim (no code) until the user approved the plan in the web UI.
      const wo = await ctx.storage.workOrderService.get(id);
      const unapproved = (await ctx.storage.feedbackService.list()).find((f) => f.status !== 'closed' && f.planOnly && wo.reason.includes(f.id));
      if (unapproved) throw new ToolError('plan_not_approved', `plan_not_approved: request ${unapproved.id} is plan-only: the user reviews the plan and approves it in the web UI before any code is written`, `flow_next { request: "${unapproved.id}" } says plan_ready; wait for the request_assigned event (plan approved)`, 'ref', { kind: 'work_order', id });
      await ctx.storage.workOrderService.claim({ id, agent: ctx.commit!.agent, ...(ctx.commit!.branch ? { branch: ctx.commit!.branch } : {}), ...(a.worktree ? { worktree: a.worktree } : {}), ...(a.git ? { git: a.git } : {}) }, metaOf(ctx, commits));
      const o = await overlapWarnings(ctx, id);
      return woResult(ctx, id, commits, { overlaps: o.overlaps }, [...cw, ...o.warnings]);
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
      const cw = checkCodeRepos(ctx, (a.git ?? []).map((g) => g.repo), 'git');
      await ctx.storage.workOrderService.heartbeat({ id, agent: ctx.commit!.agent, ...(a.git ? { git: a.git } : {}) }, metaOf(ctx, commits));
      return woResult(ctx, id, commits, {}, cw);
    },
  }),
  defineTool({
    name: 'work_order_release',
    title: 'Release a claim',
    kind: 'write',
    description: `Give a work order back (claim moved to claims as released; in_progress -> pending). Not for finished work: when every section is done the claim is released automatically and the work order stays in_progress until work_order_complete.${WO_COMMON}`,
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
        if (allSectionsFinished(cur.sections)) throw Object.assign(new Error(`all_done: every section of ${id} is done; ask the agent to complete it (work_order_complete), do not release the claim`), { statusCode: 409, code: 'all_done' });
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
    description: `Mark sections (spec section ids or work-order section refs) done or obsolete, writing notes (appended), codeRefs ("repo:path#Lx-Ly" or { repo, path, lines, symbols, change, from }; merged into touched), deviations and verifications into each; code { repo, commit, dirty } for codeRefs / touched without commits. implement/update: records implementedCommit on the spec sections. When the last section is done the claim is released automatically; then call work_order_complete (no claim needed). Optional ${GIT_NOTE}, touched.${WO_COMMON}`,
    input: workOrderSectionDoneInputSchema,
    run: async (a, ctx) => {
      const commits: string[] = [];
      const id = idOf(a.ref);
      // MW-12: the caller must hold the claim (checked inside the write lock).
      // Code locations carry repo + commit (code, per-file commits, or a commit recorded in git for that repo).
      const stamped = stampLocations(ctx, [{ files: a.codeRefs, path: 'codeRefs' }, { files: a.touched, path: 'touched' }], a.code, committedRepos(a.git));
      const w = await ctx.storage.workOrderService.sectionDone(
        { id, agent: ctx.commit!.agent, sections: a.sections, status: a.status, notes: a.notes, codeRefs: stamped.lists[0], deviations: a.deviations, verifications: a.verifications, git: a.git, touched: stamped.lists[1] },
        metaOf(ctx, commits),
      );
      const warnings: string[] = [...checkCodeRepos(ctx, (a.git ?? []).map((g) => g.repo), 'git'), ...stamped.warnings];
      const open = (w.planSteps ?? []).filter((s) => s.status === 'pending' || s.status === 'in_progress');
      if (w.sections.every((s) => s.status !== 'pending') && open.length) warnings.push(`${open.length} plan step(s) still unfinished (${open.map((s) => s.id).join(', ')}): work_order_complete refuses until each is done or skipped with a note (work_order_step_set)`);
      if (w.sections.every((s) => s.status !== 'pending')) warnings.push('every section is finished and your claim was released automatically: reconcile specs / components with the code, then call work_order_complete with the outcome (no claim needed)');
      // Implementation <-> work order: implement / update / fix sections copy their code refs into the spec section. Without any, say why it matters.
      if (a.status === 'done' && (w.kind === 'implement' || w.kind === 'update' || w.kind === 'fix') && !a.codeRefs?.length && !a.touched?.length) {
        const doc = await ctx.storage.workOrderService.doc(id);
        const noCode = doc.sections.filter((x) => x.type === 'wo-section' && a.sections.some((k) => k === x.id || parseRef(k)?.sectionId === x.id || x.target?.endsWith(`/${k}`))).some((x) => !(x.codeRefs ?? []).length);
        if (noCode) {
          warnings.push(
            `no code refs for ${a.sections.join(', ')}: the spec section keeps no link to its code (its refs / symbols stay empty), so impact analysis, drift and code search cannot find the implementation. Likely cause: the code repo is not registered (unknown_code_repo: register it in Settings → Code repositories, then call code_context_set) or the work has no commit yet (commit first). Pass codeRefs ("repo:path#Lx-Ly") here, or record them with work_order_touch with section`,
          );
        }
      }
      return woResult(ctx, id, commits, {}, warnings);
    },
  }),
  defineTool({
    name: 'work_order_complete',
    title: 'Complete a work order',
    kind: 'write',
    description: `Finish a work order: outcome (what was delivered; required), reconciliation (what you updated). Needs the claim, or no claim at all once every section is done (the claim is released automatically with the last section; any agent may complete). Remaining pending sections are marked done; the work order is then frozen (only PR / merge fields change). ${GIT_NOTE}: the final headCommit per repo (required for implement / update / fix unless recorded before; dirty claims are linked to it), PR, merge; touched.${WO_COMMON}`,
    input: workOrderCompleteInputSchema,
    run: async (a, ctx) => {
      const commits: string[] = [];
      const id = idOf(a.ref);
      const pre = await completionCode(ctx, id, a.git, a.touched);
      const { warnings } = await ctx.storage.workOrderService.complete(id, ctx.commit!.agent, { outcome: a.outcome, reconciliation: a.reconciliation, git: a.git, touched: pre.touched, codeLinks: pre.links }, metaOf(ctx, commits));
      return woResult(ctx, id, commits, pre.links.length ? { codeLinks: pre.links } : {}, [...pre.warnings, ...warnings]);
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
  ...(await ctx.reads.feedbackGet({ ref: id }).then((r) => ({ request: (r as { feedback: unknown }).feedback, targets: (r as { targets: unknown }).targets }))),
});
/** Request targets as stored: canonical refs (line ranges kept; `@mandate:` prefix dropped). */
const target = (t: string) => {
  const r = parseRef(t);
  if (r) return buildRef({ kind: r.kind, id: r.id, sectionId: r.sectionId, ...(r.lines ? { lines: r.lines } : {}) });
  const n = parseNodeUri(t);
  return n ? buildNodeUri(n) : t;
};

const requestTools: AnyToolDef[] = [
  defineTool({
    name: 'request_create',
    title: 'Record a request',
    kind: 'write',
    uiAllowed: true,
    description: `Record a REQUEST: every instruction the user gives (a feature, change, fix, wish) is one; it needs no approval and starts open. targets: sections it concerns (#Lx-Ly ranges allowed) or verification results (improvement / bug at intake: targets may wait until spec_match; set them with request_update). kind ambiguity | conflict | bug | improvement | question; body (the user's words and the why), quote (the exact text), relatedTo, fromFinding (the audit finding it comes from: spec_wrong / ambiguous findings), source: "comment" (it comes from a comment: relatedTo the commented object and mandate://comments/<id>); assignee (an agent handle from agents_presence, or "any" = the next free agent: it is told and the first to start it takes it; offline: queued), priority, planOnly (stop after the spec update and the work-order plan; the user reviews), context (mandate:// refs; those written in the body are added). From the web UI (source "ui") the signed-in user files it. Then: spec_match, edit the specs / standards with addresses: [this request], work_order_create with the full plan. Questions for the user go through question_ask.${COMMON}`,
    input: requestCreateInputSchema,
    run: async (a, ctx) => {
      const commits: string[] = [];
      // From an audit finding (spec_wrong / ambiguous): the finding must exist; it records the request in its resolution.
      const from = a.fromFinding ? await ctx.storage.auditService.requireFinding(a.fromFinding) : null;
      const relatedTo = await relatedOf(ctx, a.relatedTo ?? []);
      const fromUi = ctx.principal?.kind === 'ui';
      if (a.source === 'ui' && !fromUi) throw new ToolError('forbidden', 'forbidden: source "ui" is for requests filed in the web UI', 'omit source');
      const news = newsOfProject(ctx);
      let assignee: string | undefined;
      if (a.assignee) {
        const h = a.assignee.trim();
        assignee = h.toLowerCase() === ANY ? ANY : (news?.presence.resolve(h)[0] ?? h);
      }
      const context = [...new Set([...(a.context ?? []).map((c) => canonicalRef(c) ?? c), ...extractRefs(a.body)])].slice(0, 30);
      // MW-11: the item and the finding backlink are written under one hold of the (re-entrant) write lock.
      const f = await ctx.storage.lock.run(async () => {
        const created = await ctx.storage.feedbackService.create(
          { targets: a.targets.map(target), kind: a.kind, body: a.body, ...(a.quote ? { quote: a.quote } : {}), relatedTo, ...(fromUi ? { source: 'ui' as const } : a.source ? { source: a.source } : {}), ...(assignee ? { assignee, assignedAt: new Date().toISOString() } : {}), ...(context.length ? { context } : {}), ...(a.priority ? { priority: a.priority } : {}), ...(a.planOnly ? { planOnly: true } : {}), ...(from ? { fromFinding: from.uri } : {}) },
          metaOf(ctx, commits),
        );
        if (from) await ctx.storage.auditService.linkFeedback(from.uri, created.id, ctx.commit!.agent, metaOf(ctx, commits, { Audit: from.audit }));
        return created;
      });
      const delivered = assignee && news ? await deliverAssigned(news, f, 'new') : [];
      return { ...(await fbResult(ctx, f.id, commits)), ...(assignee ? { assignee, queued: assignee !== ANY && !news?.presence.isOnline(assignee), wakeable: wakeableAny(news, assignee, delivered), delivered } : {}) };
    },
  }),
  defineTool({
    name: 'request_update',
    title: 'Update a request',
    kind: 'write',
    description: `Edit an open request (body, targets, relatedTo: request or any element reference). Closed requests are immutable (code request_closed).${COMMON}`,
    input: requestUpdateInputSchema,
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
    name: 'request_close',
    title: 'Close a request',
    kind: 'write',
    uiAllowed: true,
    description: `Close a request: applied (changes come from commits with its Request trailer), rejected (resolutionNote) or duplicate (duplicateOf). A request whose work orders are all complete is closed automatically; use this for requests handled without a work order. Closed is immutable.${COMMON}`,
    input: requestCloseInputSchema,
    run: async (a, ctx) => {
      const commits: string[] = [];
      const id = idOf(a.ref);
      // The UI records decisions only: "applied" means content changed, which agents write (and cite) themselves.
      if (ctx.principal?.kind === 'ui' && a.resolution === 'applied') throw Object.assign(new Error('forbidden: the web UI can reject or mark duplicate; an agent closes a request as applied when its change is written'), { statusCode: 403, code: 'forbidden' });
      await ctx.storage.feedbackService.update(
        id,
        { status: 'closed', resolution: a.resolution, ...(a.resolutionNote ? { resolutionNote: a.resolutionNote } : {}), ...(a.duplicateOf ? { duplicateOf: idOf(a.duplicateOf) } : {}) },
        metaOf(ctx, commits),
      );
      return fbResult(ctx, id, commits);
    },
  }),
];
/** The old `feedback_*` names: hidden, callable aliases of the request tools. */
const LEGACY_REQUEST_NAMES: Record<string, string> = { request_create: 'feedback_create', request_update: 'feedback_update', request_close: 'feedback_close' };
const legacyRequestTools: AnyToolDef[] = requestTools.map((t) => ({ ...t, name: LEGACY_REQUEST_NAMES[t.name]! }) as AnyToolDef);

/* ---------------------------------------------------------------- verification and diff */

const verificationTools: AnyToolDef[] = [
  defineTool({
    name: 'verification_record',
    title: 'Record a verification result',
    kind: 'write',
    description: `Append a verification result for an acceptance criterion (append-only; the server sets the time and the author = your agent identity): criterion (acceptance section ref), appliedTo (the spec; required for standard criteria), specCommit (default HEAD), code { repo (short name), commit, branch, dirty: uncommitted on top of commit }, result pass | fail | skipped (skipped verifies nothing), method test | manual | review | metric, evidence { test (the test's name or repo:path#Lx-Ly), ci, note }, codeRefs (the test's file / lines), workOrder (default: yours). A passing result that names its test is stored on the criterion ("Proved by <test>"); work_order_complete needs one per criterion the work order covers.${COMMON}`,
    input: verificationRecordInputSchema,
    run: async (a, ctx) => {
      const commits: string[] = [];
      const c = parseRef(a.criterion)!;
      // Inside a work order, results are recorded by the agent that holds it (or once every section is done): an open
      // implement / update / fix work order covering the criterion that nobody claimed yet gives not_claimed.
      if (c.kind === 'specs' && c.sectionId) {
        const spec = await ctx.storage.specs.get(c.id).catch(() => null);
        const covering = (await ctx.storage.workOrderService.list()).filter(
          (w) => w.spec === c.id && ['pending', 'in_progress'].includes(w.status) && ['implement', 'update', 'fix'].includes(w.kind) && coveredCriteria(spec, w.sections.map((s) => s.id)).some((x) => x.id === c.sectionId),
        );
        if (covering.length && covering.every((w) => !w.claim && !w.sections.every((s) => s.status === 'done' || s.status === 'obsolete'))) {
          const w = covering[0]!;
          throw new ToolError('not_claimed', `not_claimed: work order ${w.id} covers this criterion and nobody has claimed it: claim it (work_order_claim) before recording its results`, `flow_next { request: "${w.reason[0] ?? ''}" } names the next step`, 'criterion', { kind: 'work_order', id: w.id });
        }
      }
      // A claim about code: repo (registered) + commit; codeRefs in registered repos too.
      const cw = [...checkClaim(ctx, a.code, 'code'), ...checkCodeRepos(ctx, (a.codeRefs ?? []).map((x) => repoOfLocation(x) ?? '').filter(Boolean), 'codeRefs')];
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
      // Criteria <-> tests: a passing result that names its test is stored on the spec criterion (with the work order).
      const warnings = [...cw];
      const testRef = a.evidence?.test?.trim() || a.codeRefs?.[0];
      if (a.result === 'pass' && testRef && c.kind === 'specs' && c.sectionId) {
        try {
          const wo = a.workOrder ? idOf(a.workOrder) : await workOrderOf(ctx, c.id, c.sectionId);
          await ctx.storage.specs.modify(
            c.id,
            (spec) => ({
              ...spec,
              sections: spec.sections.map((s) => {
                if (s.id !== c.sectionId || s.type !== 'acceptance') return s;
                const entry = { test: testRef, ...(wo ? { workOrder: wo } : {}), verification: r.id, at: r.at };
                return { ...s, provedBy: [...(s.provedBy ?? []).filter((p) => p.test !== testRef), entry] };
              }),
            }),
            { ...metaOf(ctx, commits), message: `spec(${c.id}): criterion ${c.sectionId} proved by ${testRef}`, trailers: { ...ctx.commit!.trailers, ...(wo ? { 'Work-Order': wo } : {}) } },
          );
        } catch (e) {
          warnings.push(`could not store the test on the criterion: ${(e as Error).message}`);
        }
      }
      return { ref: buildNodeUri({ kind: 'verifications', id: r.id }), ...commitsOf(commits), warnings, verification: r };
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
export const STANDARD_CONFIRMATION = 'Needs the user\'s confirmation, even with approval off: cite an answered standard_confirmation question (question_ask) as cause (questions in chat: confirmedByUser: true). Drafts with only inferred sections: not until activation.\n';

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

/**
 * Inferred drafts (e.g. /mandate-bootstrap) need no confirmation yet: creating a standard whose sections are all
 * provenance "inferred", or editing a DRAFT standard whose live sections are all inferred (and stay so). The user
 * reviews the drafts later; activating (standard_status_set) and any change to an active standard still need it.
 */
async function inferredDraftWrite(tool: string, a: Record<string, unknown>, ctx: ToolContext): Promise<boolean> {
  if (tool === 'standard_status_set') return false;
  const inferred = (s: unknown) => (s as { provenance?: unknown } | undefined)?.provenance === 'inferred';
  if (tool === 'standard_create') {
    const sections = (a.sections as unknown[] | undefined) ?? [];
    return sections.length > 0 && sections.every(inferred);
  }
  if (tool === 'standard_section_insert' && !inferred(a.section)) return false;
  if (tool === 'standard_section_update' && a.provenance !== undefined && a.provenance !== 'inferred') return false;
  const ref = (a.doc ?? a.ref) as string | undefined;
  if (!ref) return false;
  try {
    const std = (await ctx.storage.standards.get(idOf(ref))) as unknown as { status?: string; sections: { archived?: boolean; provenance?: string }[] };
    return std.status === 'draft' && std.sections.filter((s) => !s.archived).every(inferred);
  } catch {
    return false;
  }
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
      // A tldr-only metadata update is descriptive (it changes no rule): no confirmation needed.
      if (def.name === 'standard_update_meta' && Object.keys(rest).every((k) => ['ref', 'tldr', 'agent', 'branch', 'idempotencyKey', 'cause', 'addresses', 'workOrder'].includes(k)) && rest.tldr !== undefined) return def.run(rest as never, ctx);
      // An answered standard_confirmation question cited as cause: User-Confirmed names it and the answering user.
      const proof = await questionProof(ctx, ['standard_confirmation']);
      let draft = false;
      if (!proof)
        await requireConfirmation(ctx, a.confirmedByUser === true).catch(async (e: unknown) => {
          if (!(await inferredDraftWrite(def.name, rest, ctx))) throw e;
          draft = true;
        });
      // An unconfirmed inferred standard is created as a draft (it applies nowhere until the user confirms it).
      return def.run((draft && def.name === 'standard_create' ? { ...rest, status: 'draft' } : rest) as never, proof ? withTrailers(ctx, { 'User-Confirmed': proof.id, 'Confirmed-By': proof.by }) : ctx);
    },
  } as AnyToolDef;
}

/**
 * The user's approval for a waiver, exemption or criteria removal: an answered question_ask (purpose approval) cited as
 * cause. Validated here (answered by a signed-in user); the storage rules look for the `User-Approved` trailer.
 */
export function withApprovalProof(def: AnyToolDef): AnyToolDef {
  return {
    ...def,
    run: async (a: unknown, ctx: ToolContext) => {
      const proof = await questionProof(ctx, ['approval']);
      return def.run(a as never, proof ? withTrailers(ctx, { 'User-Approved': proof.id, 'Approved-By': proof.by }) : ctx);
    },
  } as AnyToolDef;
}

export const writeTools: AnyToolDef[] = [...docWriteTools('specs').map(withApprovalProof), ...docWriteTools('standards').map(withUserConfirmation).map(withApprovalProof), ...docWriteTools('components').map(withApprovalProof), ...workOrderTools, ...requestTools, ...legacyRequestTools, ...verificationTools];

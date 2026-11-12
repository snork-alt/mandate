/**
 * Document, work-order, feedback and verification WRITE tools. Each is a thin wrapper over a storage service
 * (shared with any future REST route): strict input schema (`@mandate/shared` write-schemas), domain rules in the
 * services (inside the write lock), the whole document validated before the commit. Every write returns the
 * canonical refs, the commit(s), warnings and, for section edits, the resulting section with its derived states.
 */
import {
  AUTHORING_GUIDANCE,
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
  workOrderCreateInputSchema,
  workOrderFailInputSchema,
  workOrderNextInputSchema,
  workOrderRefInputSchema,
  workOrderSectionDoneInputSchema,
  type StoredSpec,
} from '@mandate/shared';
import { slugSchema } from '@mandate/doc';
import { z } from 'zod';
import { DocWriteService, type DocKind } from '../../storage/doc-writes.js';
import type { CommitMeta } from '../../storage/index.js';
import { defineTool, type AnyToolDef, type ToolContext } from '../define.js';
import { componentArchiveInputSchema, componentCreateInputSchema, componentStatusSetInputSchema, componentUpdateMetaInputSchema } from './components.js';

/* ---------------------------------------------------------------- helpers */

const SOFT_LIMIT = 600;
const idOf = (refOrId: string) => parseRef(refOrId)?.id ?? (parseNodeUri(refOrId) as { id?: string } | null)?.id ?? refOrId;
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

const SECTION_GUIDE = `\n\n${AUTHORING_GUIDANCE}\nEvery section should have a one-sentence summary (a warning is returned when missing or stale) and stay under ~${SOFT_LIMIT} tokens (a warning names the size).`;
const COMMON = `\nWrites are git commits (trailers: Agent, Branch, plus Feedback / Work-Order when given). Pass agent (default: your MCP client name), branch, and an idempotencyKey to make retries safe (24 h). Result: ref, uri (versioned), commit, commits, warnings.`;

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
      description: `Create a ${k} (id derived from the title unless given; ids are never reused). ${kind === 'specs' ? 'Starts as draft; use spec_status_set to move it.' : kind === 'standards' ? 'appliesTo rules (repo:x, tag:x, category:x) make it apply to matching specs.' : 'kind service|module|library|datastore|external; owns: code path globs per repo (most specific glob wins in code_owner). layer (optional): ui|api|service|domain|data|infra or another slug; omitted, it is inherited from the parent or derived from depends_on. parent (optional): the containing component (a tree: one parent, no cycles, not archived). Typical sections: responsibility, interfaces, context (mermaid), rationale.'} Sections are optional here and can be added with ${k}_section_insert.${SECTION_GUIDE}${COMMON}`,
      input: createSchema,
      run: async (a, ctx) => {
        const commits: string[] = [];
        const out = await writes(ctx).create(kind, createSchema.parse(a) as never, metaOf(ctx, commits));
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
            description: `Move a standard through its lifecycle: draft (never applies) -> active -> deprecated (still applies, points at its successor: supersededBy required). Use standard_update_meta for effectiveFrom (ISO date or commit: before it, rules are announced, not required).${COMMON}`,
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
            description: `Move a component through its lifecycle: active -> deprecated | archived, deprecated -> active | archived; archived is final (components are never deleted, ids never reused). Archiving never cascades: non-archived children fail it with has_children; a non-archived child cannot sit under an archived parent (archived_parent).${COMMON}`,
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
            description: `Archive a component (final; same as component_status_set archived). It leaves the architecture view (architecture_get includeArchived shows it), still resolves by reference, and its owns globs no longer claim code. New affects / depends_on links to it are rejected; existing ones show as "Broken dependency". Never cascades: a component with non-archived children fails with has_children (archive or move them first).${COMMON}`,
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
            description: `Move a spec through its transition table: draft -> ready | archived; ready -> draft | done | archived; done -> ready (reopen) | archived; archived -> draft. in_progress is derived (a claimed work order), never set.
Moving to done passes the DONE GATE: every own and inherited criterion (from followed standards, extends, appliesTo) verified or waived (approved), no blocked / broken section, no open implement/update work order. A failing gate returns code done_gate with detail.failures (criterion, state, provenance path).${COMMON}`,
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
            description: `Archive a spec (specs are never deleted). Cancels its open work orders. Reversible: spec_status_set draft.${COMMON}`,
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
      description: `Insert a section into a ${k} (after / before a section id, or position first | last; default last). Section types: markdown, mermaid, html, ${kind === 'specs' ? 'acceptance (a criterion: method test|manual|review|metric, threshold for metric)' : kind === 'components' ? 'responsibility, interfaces, context (mermaid diagram), rationale' : 'rule (a criterion of the standard: level must|should|may, rationale, scope {paths, languages}, check {kind, command}, examples as code refs; must rules block done, should only warns)'}, ... Links: ${k}_section_link_add.${SECTION_GUIDE}${COMMON}`,
      input: withExtras(S.insert as unknown as z.ZodObject),
      trailers: docEditTrailers,
      run: async (a, ctx) => {
        const { doc, section, after, before, position } = S.insert.parse(strip(a));
        const commits: string[] = [];
        const out = await writes(ctx).sectionInsert(kind, doc, section, { after, before, position }, metaOf(ctx, commits));
        return sectionResult(ctx, out.value.id, section.id, { commits, warnings: out.warnings });
      },
    }),
    defineTool({
      name: `${k}_section_update`,
      title: `Update a ${k} section`,
      kind: 'write',
      description: `Update a section's content (title, summary, body, type, refs, symbols, verifiedBy, method, threshold; null clears an optional field). Pass ref as copied; a ref with @sha must be the current version (else stale_version: re-read and retry). Archived sections cannot be edited.${SECTION_GUIDE}${COMMON}`,
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
      description: `Archive a section: it stays in the document (ids are never reused) and is no longer in force. Sections are never deleted. ${kind === 'specs' ? 'Pending work-order sections on it become obsolete. Archiving a criterion of a done or claimed spec needs addresses: [accepted feedback].' : kind === 'components' ? 'Its depends_on links leave the architecture.' : 'Specs following it see it as archived.'}${COMMON}`,
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
One link per (section, target). Rejected: cycles (code cycle), links to superseded or archived targets (code superseded_target, the hint names the successor), forbidden directions.${COMMON}`,
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

const woResult = async (ctx: ToolContext, id: string, commits: string[], extra: Record<string, unknown> = {}) => ({
  ref: buildRef({ kind: 'work-orders', id }),
  ...commitsOf(commits),
  warnings: [] as string[],
  workOrder: (await ctx.reads.workOrderGet({ ref: id })) as unknown,
  ...extra,
});

const WO_COMMON = `${COMMON}\nClaims: the claiming agent (your agent identity) holds the work order; another agent's fresh claim gives claim_conflict, a stale one (no heartbeat for 30 min) stale_claim (claim it to take over).`;

const workOrderTools: AnyToolDef[] = [
  defineTool({
    name: 'work_order_create',
    title: 'Create a work order',
    kind: 'write',
    description: `Ask for work on sections of ONE spec, pinned to its current version (or specCommit): kind implement | update | review | verify, priority p0..p3, note, reason (feedback items it acts on). At most one open implement/update work order per spec section.${COMMON}`,
    input: workOrderCreateInputSchema,
    run: async (a, ctx) => {
      const commits: string[] = [];
      const spec = idOf(a.spec);
      const sections = a.sections.map((s) => parseRef(s)?.sectionId ?? s);
      const bad = sections.find((s) => !slugSchema.safeParse(s).success);
      if (bad) throw Object.assign(new Error(`invalid section '${bad}'`), { statusCode: 400 });
      const wo = await ctx.storage.workOrderService.create(
        { spec, kind: a.kind, status: 'pending', sections: sections.map((id) => ({ id })), ...(a.priority ? { priority: a.priority } : {}), ...(a.note ? { note: a.note } : {}), ...(a.reason ? { reason: a.reason.map(idOf) } : {}), ...(a.specCommit ? { specCommit: a.specCommit } : {}), createdBy: ctx.commit!.agent },
        metaOf(ctx, commits),
      );
      return woResult(ctx, wo.id, commits);
    },
  }),
  defineTool({
    name: 'work_order_next',
    title: 'Take the next work order',
    kind: 'write',
    description: `Atomically pick AND claim the next eligible work order for you: open, unclaimed (or stale, or already yours), no pending section blocked or broken, matching the filters (kinds, spec, priority, repo, category, tags); highest priority first (p0), then oldest. Concurrent callers never get the same item. Returns workOrder: null when nothing is eligible (skipped lists why).${WO_COMMON}`,
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
      return woResult(ctx, workOrder.id, commits, { skipped });
    },
  }),
  defineTool({
    name: 'work_order_claim',
    title: 'Claim a work order',
    kind: 'write',
    description: `Claim a work order (sets it in progress; records agent, branch, worktree). Takes over a stale claim.${WO_COMMON}`,
    input: workOrderClaimInputSchema,
    run: async (a, ctx) => {
      const commits: string[] = [];
      const id = idOf(a.ref);
      await ctx.storage.workOrderService.claim({ id, agent: ctx.commit!.agent, ...(ctx.commit!.branch ? { branch: ctx.commit!.branch } : {}), ...(a.worktree ? { worktree: a.worktree } : {}) }, metaOf(ctx, commits));
      return woResult(ctx, id, commits);
    },
  }),
  defineTool({
    name: 'work_order_heartbeat',
    title: 'Heartbeat a claim',
    kind: 'write',
    description: `Keep your claim alive (a claim without heartbeat for 30 minutes is stale and can be taken over).${WO_COMMON}`,
    input: workOrderRefInputSchema,
    run: async (a, ctx) => {
      const commits: string[] = [];
      const id = idOf(a.ref);
      await ctx.storage.workOrderService.heartbeat({ id, agent: ctx.commit!.agent }, metaOf(ctx, commits));
      return woResult(ctx, id, commits);
    },
  }),
  defineTool({
    name: 'work_order_release',
    title: 'Release a claim',
    kind: 'write',
    description: `Give a work order back (claim dropped; in_progress -> pending).${WO_COMMON}`,
    input: workOrderRefInputSchema,
    run: async (a, ctx) => {
      const commits: string[] = [];
      const id = idOf(a.ref);
      await ctx.storage.workOrderService.release({ id, agent: ctx.commit!.agent }, metaOf(ctx, commits));
      return woResult(ctx, id, commits);
    },
  }),
  defineTool({
    name: 'work_order_section_done',
    title: 'Mark work-order sections done',
    kind: 'write',
    description: `Mark covered sections done (implement/update: records implementedCommit = the work order's specCommit on the spec sections, in a spec commit with a Work-Order trailer) or obsolete. The work order becomes done when every section is done or obsolete.${WO_COMMON}`,
    input: workOrderSectionDoneInputSchema,
    run: async (a, ctx) => {
      const commits: string[] = [];
      const id = idOf(a.ref);
      await ctx.storage.workOrderService.requireHolder(id, ctx.commit!.agent);
      await ctx.storage.workOrderService.sectionDone({ id, sections: a.sections, status: a.status }, metaOf(ctx, commits));
      return woResult(ctx, id, commits);
    },
  }),
  defineTool({
    name: 'work_order_complete',
    title: 'Complete a work order',
    kind: 'write',
    description: `Finish a work order: every remaining pending section is marked done (as work_order_section_done), so it becomes done (final).${WO_COMMON}`,
    input: workOrderRefInputSchema,
    run: async (a, ctx) => {
      const commits: string[] = [];
      const id = idOf(a.ref);
      await ctx.storage.workOrderService.complete(id, ctx.commit!.agent, metaOf(ctx, commits));
      return woResult(ctx, id, commits);
    },
  }),
  defineTool({
    name: 'work_order_fail',
    title: 'Fail a work order',
    kind: 'write',
    description: `Mark a work order failed with a note (why). Failed work orders can be reopened (pending / in_progress) or cancelled; the claim is dropped.${WO_COMMON}`,
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
    description: `Cancel a work order (final; the claim is dropped; the pin is never validated).${WO_COMMON}`,
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
    description: `File feedback on sections (#Lx-Ly ranges allowed) or verification results: kind ambiguity | conflict | bug | improvement | question, body (the why), quote (the exact text), relatedTo. Starts open; the author is your agent identity (approvals of waivers need feedback from someone else).${COMMON}`,
    input: feedbackCreateInputSchema,
    run: async (a, ctx) => {
      const commits: string[] = [];
      const f = await ctx.storage.feedbackService.create(
        { targets: a.targets.map(target), kind: a.kind, body: a.body, ...(a.quote ? { quote: a.quote } : {}), relatedTo: (a.relatedTo ?? []).map(idOf) },
        metaOf(ctx, commits),
      );
      return fbResult(ctx, f.id, commits);
    },
  }),
  defineTool({
    name: 'feedback_update',
    title: 'Update feedback',
    kind: 'write',
    description: `Edit an open or accepted feedback item (body, targets, relatedTo). Closed items are immutable (code feedback_closed).${COMMON}`,
    input: feedbackUpdateInputSchema,
    run: async (a, ctx) => {
      const commits: string[] = [];
      const id = idOf(a.ref);
      await ctx.storage.feedbackService.update(
        id,
        { ...(a.body ? { body: a.body } : {}), ...(a.targets ? { targets: a.targets.map(target) } : {}), ...(a.relatedTo ? { relatedTo: a.relatedTo.map(idOf) } : {}) },
        metaOf(ctx, commits),
      );
      return fbResult(ctx, id, commits);
    },
  }),
  defineTool({
    name: 'feedback_accept',
    title: 'Accept feedback',
    kind: 'write',
    description: `Accept a feedback item (open -> accepted): it will be acted on, and can approve waivers / exemptions / criteria removals.${COMMON}`,
    input: feedbackAcceptInputSchema,
    run: async (a, ctx) => {
      const commits: string[] = [];
      const id = idOf(a.ref);
      await ctx.storage.feedbackService.update(id, { status: 'accepted' }, metaOf(ctx, commits));
      return fbResult(ctx, id, commits);
    },
  }),
  defineTool({
    name: 'feedback_close',
    title: 'Close feedback',
    kind: 'write',
    description: `Close a feedback item with a resolution: applied (the changes are derived from commits with a Feedback trailer), rejected (resolutionNote required) or duplicate (duplicateOf required). Closed is final and immutable.${COMMON}`,
    input: feedbackCloseInputSchema,
    run: async (a, ctx) => {
      const commits: string[] = [];
      const id = idOf(a.ref);
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
    description: `Append a verification result for an acceptance criterion (append-only; the server sets the time and the author = your agent identity): criterion (acceptance section ref), appliedTo (the spec; required for standard criteria), specCommit (default HEAD), code { repo, commit, branch }, result pass | fail | skipped, method test | manual | review | metric, evidence { test, ci, note }.${COMMON}`,
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

export const writeTools: AnyToolDef[] = [...docWriteTools('specs'), ...docWriteTools('standards'), ...docWriteTools('components'), ...workOrderTools, ...feedbackTools, ...verificationTools];

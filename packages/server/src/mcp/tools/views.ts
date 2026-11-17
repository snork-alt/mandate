/** UI view tools: the full, derived payloads the web UI renders (lists with rollups, detail, versions, raw files, ...). */
import {
  docFeedbackInputSchema,
  docGetInputSchema,
  docListInputSchema,
  docRawInputSchema,
  gitLogInputSchema,
  sectionTypesInputSchema,
  specImplementationInputSchema,
  standardUsageInputSchema,
  versionGetInputSchema,
  projectOverviewInputSchema,
} from '@mandate/shared';
import { defineTool, type ToolContext } from '../define.js';
import { projectOverview } from '../../storage/overview.js';
import { lineageCoverage } from '../../index/lineage-backfill.js';
import type { DB } from '../../index/db.js';

/** Cause coverage per index DB, recomputed only when the indexed history grows. */
const lineageCache = new WeakMap<DB, { seq: number; value: ReturnType<typeof lineageCoverage> }>();
function cachedLineage(ctx: ToolContext) {
  const db = ctx.index?.db;
  if (!db) return null;
  const seq = (db.prepare('SELECT coalesce(max(seq), 0) AS s FROM commits').get() as { s: number }).s;
  const hit = lineageCache.get(db);
  if (hit && hit.seq === seq) return hit.value;
  const value = lineageCoverage(db);
  lineageCache.set(db, { seq, value });
  return value;
}

export const viewTools = [
  defineTool({
    name: 'project_overview',
    title: 'Project overview',
    kind: 'read',
    description: `Project state in one call: maturity distribution, needs-attention counts (failing / outdated / blocked specs, must findings, stale claims, integrity), work in progress, blocked items and their blockers, pending decisions and coverage.
Example: {}`,
    input: projectOverviewInputSchema,
    run: (a, ctx) => projectOverview(ctx.storage, a, { lineage: () => cachedLineage(ctx) }),
  }),
  defineTool({
    name: 'doc_list',
    title: 'List documents (full)',
    kind: 'read',
    description: `Every entity of a kind as full objects with git times and list rollups. Not paginated: agents should prefer spec_list / search.
Example: {"kind":"specs"}`,
    input: docListInputSchema,
    run: (a, ctx) => ctx.views.list(a),
  }),
  defineTool({
    name: 'doc_get',
    title: 'Get a document (full)',
    kind: 'read',
    description: `One spec, standard or component as the full stored object plus git times, verification, links, backlinks and derived states (work orders / requests: use their get tools).
Example: {"kind":"specs","id":"login-sso"}`,
    input: docGetInputSchema,
    run: (a, ctx) => ctx.views.get(a),
  }),
  defineTool({
    name: 'version_get',
    title: 'Get a version',
    kind: 'read',
    description: `A spec / standard / component file at a commit vs its parent, head or a base commit: before / after text, status, commit meta, neighbouring versions. Works for deleted docs.
Example: {"kind":"specs","id":"login-sso","commit":"3f2a9c1","against":"head"}`,
    input: versionGetInputSchema,
    run: (a, ctx) => ctx.views.version(a),
  }),
  defineTool({
    name: 'doc_raw',
    title: 'Raw document file',
    kind: 'read',
    description: `The stored markdown of a spec, standard or component at HEAD ({ text }, null if missing).
Example: {"kind":"standards","id":"security-baseline"}`,
    input: docRawInputSchema,
    run: (a, ctx) => ctx.views.raw(a),
  }),
  defineTool({
    name: 'standard_usage',
    title: 'Standard usage',
    kind: 'read',
    description: `Specs using a standard (directly, in sections, via appliesTo or follows links; archived included), with deviations.
Example: {"id":"security-baseline"}`,
    input: standardUsageInputSchema,
    run: (a, ctx) => ctx.views.standardUsage(a),
  }),
  defineTool({
    name: 'spec_implementation',
    title: 'Spec implementation state',
    kind: 'read',
    description: `Per-section implementation state of a spec: implementedCommit and outdated.
Example: {"id":"login-sso"}`,
    input: specImplementationInputSchema,
    run: (a, ctx) => ctx.views.specImplementation(a),
  }),
  defineTool({
    name: 'doc_feedback',
    title: 'Requests on a document',
    kind: 'read',
    description: `Requests targeting one spec, standard or component, with open + accepted counts per section ("" = whole doc).
Example: {"kind":"specs","id":"login-sso"}`,
    input: docFeedbackInputSchema,
    run: (a, ctx) => ctx.views.docFeedback(a),
  }),
  defineTool({
    name: 'section_types',
    title: 'Section types',
    kind: 'read',
    description: `Registered section types (id, label, description, fence).
Example: {}`,
    input: sectionTypesInputSchema,
    run: async (_a, ctx) => ctx.views.sectionTypes({}),
  }),
  defineTool({
    name: 'git_log',
    title: 'Git log',
    kind: 'read',
    description: `Recent Mandate repo commits, newest first. For filtered history use history_search.
Example: {"limit":20}`,
    input: gitLogInputSchema,
    run: (a, ctx) => ctx.views.gitLog(a),
  }),
];

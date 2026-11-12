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
} from '@mandate/shared';
import { defineTool } from '../define.js';

export const viewTools = [
  defineTool({
    name: 'doc_list',
    title: 'List documents (full)',
    kind: 'read',
    description: `Every entity of a kind as full objects with git-derived times (createdAt, updatedAt, updatedBy, revisions, lastCommit) and list rollups: specs (verification rollup, blocked sections, derived states), standards (usedBy, rule counts, in force), components (derived states), work orders (file order), feedback (derived changes). Not paginated: prefer spec_list / search for agent queries.
Example: {"kind":"specs"}`,
    input: docListInputSchema,
    run: (a, ctx) => ctx.views.list(a),
  }),
  defineTool({
    name: 'doc_get',
    title: 'Get a document (full)',
    kind: 'read',
    description: `One spec, standard or component as the full stored object (frontmatter + sections with bodies) plus git-derived times and derived detail: verification (own + inherited criteria), section links and backlinks, derived states. For work orders and feedback use work_order_get / feedback_get.
Example: {"kind":"specs","id":"login-sso"}`,
    input: docGetInputSchema,
    run: (a, ctx) => ctx.views.get(a),
  }),
  defineTool({
    name: 'version_get',
    title: 'Get a version',
    kind: 'read',
    description: `A version of a spec, standard or component file at a commit and what it is compared with: against parent (what the commit changed) or head (from the commit to now), or an explicit base commit. Returns before / after file text, status, commit meta and the neighbouring versions (older / newer, index / total). Works for deleted documents.
Example: {"kind":"specs","id":"login-sso","commit":"3f2a9c1","against":"head"}`,
    input: versionGetInputSchema,
    run: (a, ctx) => ctx.views.version(a),
  }),
  defineTool({
    name: 'doc_raw',
    title: 'Raw document file',
    kind: 'read',
    description: `The stored markdown file of a spec, standard or component at HEAD ({ text }, null when missing). The same text is the mandate://<kind>/<id> resource.
Example: {"kind":"standards","id":"security-baseline"}`,
    input: docRawInputSchema,
    run: (a, ctx) => ctx.views.raw(a),
  }),
  defineTool({
    name: 'standard_usage',
    title: 'Standard usage',
    kind: 'read',
    description: `Specs using a standard (directly, in sections, via appliesTo rules or follows links), archived ones included, with deviations.
Example: {"id":"security-baseline"}`,
    input: standardUsageInputSchema,
    run: (a, ctx) => ctx.views.standardUsage(a),
  }),
  defineTool({
    name: 'spec_implementation',
    title: 'Spec implementation state',
    kind: 'read',
    description: `Per-section implementation state of a spec: implementedCommit and whether the section changed since (outdated).
Example: {"id":"login-sso"}`,
    input: specImplementationInputSchema,
    run: (a, ctx) => ctx.views.specImplementation(a),
  }),
  defineTool({
    name: 'doc_feedback',
    title: 'Feedback on a document',
    kind: 'read',
    description: `Feedback items targeting one spec, standard or component (with the section ids they target) and open + accepted counts per section ("" = whole document).
Example: {"kind":"specs","id":"login-sso"}`,
    input: docFeedbackInputSchema,
    run: (a, ctx) => ctx.views.docFeedback(a),
  }),
  defineTool({
    name: 'section_types',
    title: 'Section types',
    kind: 'read',
    description: `Registered section types (id, label, description, fence) accepted in documents.
Example: {}`,
    input: sectionTypesInputSchema,
    run: async (_a, ctx) => ctx.views.sectionTypes({}),
  }),
  defineTool({
    name: 'git_log',
    title: 'Git log',
    kind: 'read',
    description: `Recent commits of the Mandate repository (id, message, author, date), newest first. limit ≤ 500 (default 80). For filtered history use history_search.
Example: {"limit":20}`,
    input: gitLogInputSchema,
    run: (a, ctx) => ctx.views.gitLog(a),
  }),
];

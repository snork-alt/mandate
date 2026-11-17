/** Document READ tools (specs, standards, sections, work orders, requests, verifications, history, diff). */
import {
  diffGetInputSchema,
  feedbackGetInputSchema,
  feedbackListInputSchema,
  historyGetInputSchema,
  specGetInputSchema,
  specListInputSchema,
  specSectionGetInputSchema,
  standardGetInputSchema,
  standardListInputSchema,
  standardSectionGetInputSchema,
  verificationListInputSchema,
  workOrderGetInputSchema,
  workOrderListInputSchema,
  FEEDBACK_KINDS,
  FEEDBACK_STATUSES,
  SPEC_STATUSES,
  WORK_ORDER_KINDS,
  WORK_ORDER_STATUSES,
} from '@mandate/shared';
import { defineTool } from '../define.js';
import { sectionGetWithImage, withImageMeta } from '../images.js';

const REF_NOTE = '';

export const docTools = [
  defineTool({
    name: 'spec_list',
    title: 'List specs',
    kind: 'read',
    description: `List specs (metadata, newest change first) with verification rollup, blocked sections, lastAudit (null = never) and maturity (specified | in_progress | implemented; overlays failing | outdated | blocked | archived).
Filters: status (${SPEC_STATUSES.join('|')}), category, repo, tags (any), standard (id), blocked, verification, audit (never|stale|open_findings|fail|warn|pass), maturity, q (id/title substring). Paginated.
Example: {"status":["ready"],"blocked":true}`,
    input: specListInputSchema,
    run: (a, ctx) => ctx.reads.specList(a),
  }),
  defineTool({
    name: 'spec_get',
    title: 'Get a spec',
    kind: 'read',
    description: `Get one spec: frontmatter, sections (with bodies, lines, metadata) and, at HEAD, verification, section links and implementation state.
metadataOnly: outline only; sections: only these ids; at: a commit. ${REF_NOTE}
Example: {"ref":"login-sso","metadataOnly":true}`,
    input: specGetInputSchema,
    run: async (a, ctx) => {
      const r = await ctx.reads.specGet(a);
      return withImageMeta(r, ctx, 'specs', (r as { id: string }).id);
    },
  }),
  defineTool({
    name: 'spec_section_get',
    title: 'Get a spec section',
    kind: 'read',
    description: `Get one spec section (body, type, summary, metadata, lines); #Lx-Ly in the ref also returns that excerpt; includeImage: the picture of an image section. ${REF_NOTE}
Example: {"ref":"mandate://specs/login-sso/sections/auth-flow"}`,
    input: specSectionGetInputSchema,
    run: async (a, ctx) => sectionGetWithImage(await ctx.reads.specSectionGet(a), ctx, a.includeImage),
  }),
  defineTool({
    name: 'standard_list',
    title: 'List standards',
    kind: 'read',
    description: `List standards (metadata, appliesTo rules, number of specs using each, lastAudit: null = never). Filters: tags (any), q (id/title substring). Paginated.
Example: {"tags":["security"]}`,
    input: standardListInputSchema,
    run: (a, ctx) => ctx.reads.standardList(a),
  }),
  defineTool({
    name: 'standard_get',
    title: 'Get a standard',
    kind: 'read',
    description: `Get one standard: frontmatter, sections and, at HEAD, its acceptance checklist per spec and section links. Options as spec_get. ${REF_NOTE}
Example: {"ref":"security-baseline","sections":["rules"]}`,
    input: standardGetInputSchema,
    run: async (a, ctx) => {
      const r = await ctx.reads.standardGet(a);
      return withImageMeta(r, ctx, 'standards', (r as { id: string }).id);
    },
  }),
  defineTool({
    name: 'standard_section_get',
    title: 'Get a standard section',
    kind: 'read',
    description: `Get one standard section (body, type, metadata, lines; #Lx-Ly excerpt). ${REF_NOTE}
Example: {"ref":"mandate://standards/security-baseline/sections/rules"}`,
    input: standardSectionGetInputSchema,
    run: async (a, ctx) => sectionGetWithImage(await ctx.reads.standardSectionGet(a), ctx, a.includeImage),
  }),
  defineTool({
    name: 'work_order_list',
    title: 'List work orders',
    kind: 'read',
    description: `List work orders. Filters: status (${WORK_ORDER_STATUSES.join('|')}), kind (${WORK_ORDER_KINDS.join('|')}), spec (id or ref). Paginated.
Example: {"status":["pending","in_progress"],"spec":"login-sso"}`,
    input: workOrderListInputSchema,
    run: (a, ctx) => ctx.reads.workOrderList(a),
  }),
  defineTool({
    name: 'work_order_get',
    title: 'Get a work order',
    kind: 'read',
    description: `Get one work order resolved: item, spec, each covered section at specCommit (headChanged / blocked flags, latest text if changed) and the section dependency tree (depth, at).
Example: {"ref":"q-0003","depth":2}`,
    input: workOrderGetInputSchema,
    run: (a, ctx) => ctx.reads.workOrderGet(a),
  }),
  defineTool({
    name: 'request_list',
    title: 'List requests',
    kind: 'read',
    description: `List requests with derived changes (Request-trailer commits) and closedAt. Filters: status (${FEEDBACK_STATUSES.join('|')}), kind (${FEEDBACK_KINDS.join('|')}), target (doc or section ref). Paginated.
Example: {"status":["open"],"target":"mandate://specs/login-sso"}`,
    input: feedbackListInputSchema,
    run: (a, ctx) => ctx.reads.feedbackList(a),
  }),
  defineTool({
    name: 'request_get',
    title: 'Get a request',
    kind: 'read',
    description: `Get one request with resolved targets (section text, lines) and derived changes.
Example: {"ref":"fb-0004"}`,
    input: feedbackGetInputSchema,
    run: async (a, ctx) => {
      const { feedback, targets } = (await ctx.reads.feedbackGet(a)) as { feedback: unknown; targets: unknown };
      return { request: feedback, targets };
    },
  }),
  defineTool({
    name: 'verification_list',
    title: 'List verification results',
    kind: 'read',
    description: `Verification results (newest first) and derived criterion states.
Filters: criterion (acceptance section ref), spec (its results plus each own and inherited criterion's state), state (verified|failing|stale|unverified|waived; all live specs if no spec), result (pass|fail|skipped). Paginated.
Example: {"spec":"login-sso","state":["failing","stale"]}`,
    input: verificationListInputSchema,
    run: (a, ctx) => ctx.reads.verificationList(a),
  }),
  defineTool({
    name: 'history_get',
    title: 'Get history',
    kind: 'read',
    description: `Commit history of a spec, standard, work order or request, newest first (subject, author, trailers, change kinds). A section ref returns only commits changing it, with action and what changed.
Example: {"ref":"mandate://specs/login-sso","limit":20}`,
    input: historyGetInputSchema,
    run: (a, ctx) => ctx.reads.historyGet(a),
  }),
  defineTool({
    name: 'diff_get',
    title: 'Diff two versions',
    kind: 'read',
    description: `Structured diff of a spec or standard between two commits (to defaults to HEAD): frontmatter, sections added / removed / modified / moved with word or line ops, stats. A section ref narrows it; full: include both parsed docs.
Example: {"ref":"mandate://specs/login-sso","from":"3f2a9c1"}`,
    input: diffGetInputSchema,
    run: (a, ctx) => ctx.reads.diffGet(a),
  }),
];

/** The old `feedback_get` / `feedback_list` names: hidden, callable aliases of the request tools. */
export const legacyRequestReadTools = docTools
  .filter((t) => t.name === 'request_get' || t.name === 'request_list')
  .map((t) => ({ ...t, name: t.name.replace('request_', 'feedback_') })) as typeof docTools;

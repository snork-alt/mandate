/** Document READ tools (specs, standards, sections, work orders, feedback, verifications, history, diff). */
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

const REF_NOTE = 'References are accepted exactly as copied: `login-sso`, `mandate://specs/login-sso`, `@mandate:mandate://specs/login-sso@3f2a9c1/sections/auth-flow#L12-L20` (`@sha` reads that version).';

export const docTools = [
  defineTool({
    name: 'spec_list',
    title: 'List specs',
    kind: 'read',
    description: `List specs (metadata only, newest change first) with verification rollup and blocked sections.
Filters: status (${SPEC_STATUSES.join('|')}), category, repo, tags (any), standard (id; direct, section or appliesTo usage), blocked (true/false), verification (verified|failing|stale|unverified|none), q (id/title substring). Paginated: limit (≤200), cursor.
Example: {"status":["ready"],"blocked":true}`,
    input: specListInputSchema,
    run: (a, ctx) => ctx.reads.specList(a),
  }),
  defineTool({
    name: 'spec_get',
    title: 'Get a spec',
    kind: 'read',
    description: `Get one spec: frontmatter, sections (id, title, type, summary, file lines, metadata, body), and at HEAD the verification detail, section links and implementation state.
metadataOnly: outline without bodies. sections: only these section ids. at: a commit (or put @sha in the reference). ${REF_NOTE}
Example: {"ref":"login-sso","metadataOnly":true}`,
    input: specGetInputSchema,
    run: (a, ctx) => ctx.reads.specGet(a),
  }),
  defineTool({
    name: 'spec_section_get',
    title: 'Get a spec section',
    kind: 'read',
    description: `Get one spec section (markdown body, type, summary, metadata, file lines). With #Lx-Ly in the reference, also returns that excerpt of the file. ${REF_NOTE}
Example: {"ref":"mandate://specs/login-sso/sections/auth-flow"} or {"doc":"login-sso","section":"auth-flow","at":"3f2a9c1"}`,
    input: specSectionGetInputSchema,
    run: (a, ctx) => ctx.reads.specSectionGet(a),
  }),
  defineTool({
    name: 'standard_list',
    title: 'List standards',
    kind: 'read',
    description: `List standards (metadata, appliesTo rules, number of specs using each). Filters: tags (any), q (id/title substring). Paginated.
Example: {"tags":["security"]}`,
    input: standardListInputSchema,
    run: (a, ctx) => ctx.reads.standardList(a),
  }),
  defineTool({
    name: 'standard_get',
    title: 'Get a standard',
    kind: 'read',
    description: `Get one standard: frontmatter, sections and, at HEAD, its acceptance checklist with per-spec states and section links. Same options as spec_get. ${REF_NOTE}
Example: {"ref":"security-baseline","sections":["rules"]}`,
    input: standardGetInputSchema,
    run: (a, ctx) => ctx.reads.standardGet(a),
  }),
  defineTool({
    name: 'standard_section_get',
    title: 'Get a standard section',
    kind: 'read',
    description: `Get one standard section (body, type, metadata, lines; #Lx-Ly excerpt). ${REF_NOTE}
Example: {"ref":"mandate://standards/security-baseline/sections/rules"}`,
    input: standardSectionGetInputSchema,
    run: (a, ctx) => ctx.reads.standardSectionGet(a),
  }),
  defineTool({
    name: 'work_order_list',
    title: 'List work orders',
    kind: 'read',
    description: `List work orders (file order). Filters: status (${WORK_ORDER_STATUSES.join('|')}), kind (${WORK_ORDER_KINDS.join('|')}), spec (id or reference). Paginated.
Example: {"status":["pending","in_progress"],"spec":"login-sso"}`,
    input: workOrderListInputSchema,
    run: (a, ctx) => ctx.reads.workOrderList(a),
  }),
  defineTool({
    name: 'work_order_get',
    title: 'Get a work order',
    kind: 'read',
    description: `Get one work order resolved: the item, its spec, each covered section at specCommit (with headChanged / blocked flags and the latest text when it changed), and the section dependency tree (depth, at).
Example: {"ref":"mandate://work-orders/wo-01jc..."} or {"ref":"q-0003","depth":2}`,
    input: workOrderGetInputSchema,
    run: (a, ctx) => ctx.reads.workOrderGet(a),
  }),
  defineTool({
    name: 'feedback_list',
    title: 'List feedback',
    kind: 'read',
    description: `List feedback items with derived changes (commits with a Feedback trailer) and closedAt. Filters: status (${FEEDBACK_STATUSES.join('|')}), kind (${FEEDBACK_KINDS.join('|')}), target (a doc or section reference: items targeting it). Paginated.
Example: {"status":["open"],"target":"mandate://specs/login-sso"}`,
    input: feedbackListInputSchema,
    run: (a, ctx) => ctx.reads.feedbackList(a),
  }),
  defineTool({
    name: 'feedback_get',
    title: 'Get feedback',
    kind: 'read',
    description: `Get one feedback item with its resolved targets (section text, lines) and derived changes.
Example: {"ref":"fb-0004"} or {"ref":"mandate://feedback/fb-0004"}`,
    input: feedbackGetInputSchema,
    run: (a, ctx) => ctx.reads.feedbackGet(a),
  }),
  defineTool({
    name: 'verification_list',
    title: 'List verification results',
    kind: 'read',
    description: `Verification results (verifications.jsonl, newest first) and derived criterion states.
Filters: criterion (acceptance section reference), spec (id/reference: results applied to it plus the state of each own and inherited criterion), state (verified|failing|stale|unverified|waived: criteria in that state, across all live specs when no spec is given), result (pass|fail|skipped). Paginated.
Example: {"spec":"login-sso","state":["failing","stale"]}`,
    input: verificationListInputSchema,
    run: (a, ctx) => ctx.reads.verificationList(a),
  }),
  defineTool({
    name: 'history_get',
    title: 'Get history',
    kind: 'read',
    description: `Commit history of a spec, standard, work order or feedback item, newest first (subject, author, agent/branch trailers, change kinds text|metadata|status). A section reference returns only the commits that changed that section, with the action (added|removed|modified|moved) and what changed (title, metadata keys, body).
Example: {"ref":"mandate://specs/login-sso","limit":20}`,
    input: historyGetInputSchema,
    run: (a, ctx) => ctx.reads.historyGet(a),
  }),
  defineTool({
    name: 'diff_get',
    title: 'Diff two versions',
    kind: 'read',
    description: `Structured diff of a spec or standard between two commits (to defaults to HEAD): frontmatter changes, sections added/removed/modified/moved with word or line ops, per-item changes, stats. A section reference narrows to that section. full: include both parsed documents.
Example: {"ref":"mandate://specs/login-sso","from":"3f2a9c1"}`,
    input: diffGetInputSchema,
    run: (a, ctx) => ctx.reads.diffGet(a),
  }),
];

/**
 * `/mandate-bootstrap`: reverse-engineer an existing codebase into a Mandate project (components, standards, specs),
 * as a resumable, checkpointed procedure tracked by a work order. A separate Agent Skill (`mandate-bootstrap`) so the
 * master skill stays small. Pure module (no server imports): the CLI bundles it. Tool names are checked against the
 * registry by test/mcp/bootstrap.test.ts.
 */

export const BOOTSTRAP_SKILL_DESCRIPTION =
  'Reverse-engineer an existing codebase into Mandate (extract notes → distill into components, standards, specs → review), checkpointed and resumable. Use for /mandate-bootstrap or requests to populate / import a repo into Mandate.';

/** Fact types of the extract notes (validated by `mandate bootstrap validate`). */
export const NOTE_TYPES = ['component_candidate', 'convention', 'behavior', 'test', 'dependency', 'api_surface', 'data_model', 'doc_claim', 'question'] as const;

export const BOOTSTRAP_SKILL_BODY = `# Mandate bootstrap

Three stages, each in a **fresh** agent: EXTRACT (raw notes) → DISTILL (Mandate docs) → REVIEW (docs vs notes and code). Accuracy beats coverage. \`mandate …\` = shell commands.
Forms: \`/mandate-bootstrap\` (all) · \`extract|distill|review [--run <id>] [--area <path>]\` · \`--resume\` · other words = scope.

## Rules (every stage)
- \`project_info\` first; \`effective.flow\` off: stop and give its \`reason\`.
- Never duplicate: \`spec_list\` / \`component_list\` / \`standard_list\` and \`spec_match\` before any create; extend instead.
- Never invent requirements: unclear intent → \`question\` note (extract), \`feedback_create\` kind \`question\` on the section (distill).
- Every section written: \`provenance: "inferred"\` + \`confidence\` (0..1). Every write: \`cause: <tracking work order ref>\`. Ids are assigned by Mandate: use the ids returned.
- Notes stay in the run folder, never in a repo.
- Diagrams and mockups: upload with curl (\`project_info.upload\`, or \`upload_url_create\`); never paste them into tool calls.
- Ask the user with \`question_ask\` (options + recommended; \`effective.questions\` chat: in chat) at setup, at the architecture checkpoint, before creating or changing ANY standard (always, even with approval off), and on ambiguous intent, code-vs-doc conflicts, naming, scope. Keep working on what doesn't depend on the answer. Never ask what code, configs or docs answer. ≤ 4 questions per checkpoint.

## Setup (coordinator)
1. Check what exists; ask in one batch: scope, depth (outline | full specs with criteria), skips (vendored, generated, legacy), authoritative docs.
2. \`mandate bootstrap init <project> [--scope <p1,p2>] [<area>=<paths,…> …]\` (one area per module) → run id + folder \`~/.mandate/bootstrap/<project>/<runId>/\` (\`manifest.json\`, \`notes/\`).
3. Tracking: \`spec_create\` a draft spec "Bootstrap" with sections Extract, Distill, Review; \`work_order_create\` on it (kind \`review\`; note = run id, notes path, scope, depth; plan = Setup · Extract per area · Distill (survey, architecture, each standard, specs per area) · Review · Done, kept current with \`work_order_plan_set\`). \`work_order_claim\`; \`work_order_heartbeat\` on long stages; \`work_order_section_done\` per stage with notes.

**--resume**: \`work_order_list\` (the tracking spec, open) → \`work_order_get\` → \`mandate bootstrap status <runId>\` → continue at the first unfinished stage / area.

## Stage 1: EXTRACT (read-only facts, no conclusions)
Inventory: languages, manifests, entrypoints, modules, tests + how to run, CI, lint configs, docs / ADRs / AGENTS.md, API and DB schemas, migrations, feature flags.
With sub-agents: one extractor per area in parallel, each writing only \`notes/<area>.jsonl\`. Progress: \`mandate bootstrap status <runId> --area <id> --area-status extracting|extracted|distilled|reviewed\`; \`--stage extract|distill|review|done\`.
One JSON object per line:
\`\`\`
{"type":"convention","area":"api","statement":"handlers return {error:{code,message}}","evidence":["shop:src/api/orders.ts#L40-L52"],"confidence":"high","conforming":23,"violating":2}
\`\`\`
- \`type\`: ${NOTE_TYPES.join(' | ')}; \`evidence\` ≥ 1 ref \`repo:path#Lx-Ly\` (doc path for \`doc_claim\`); note \`confidence\` low | med | high (notes only).
- Extra fields: \`convention\` conforming + violating · \`test\` test (+ command) · \`component_candidate\` name + paths (globs) · \`dependency\` from + to · \`question\` question.
- Then \`mandate bootstrap validate <runId>\`; fix every error.

## Stage 2: DISTILL (fresh agent)
Read manifest + notes; dedup; code beats stale docs unless docs are authoritative (ask on contradiction). Per area:
1. Survey (≤ 30 lines: what, parts, interactions, testing) in the tracking spec's Distill section; the user corrects.
2. Architecture: components from \`component_candidate\` / \`dependency\` notes (name, responsibility, \`owns\`, \`layer\`, \`parent\`, \`depends_on\`); the user confirms / renames / merges / splits; \`component_create\` + \`component_section_link_add\` \`depends_on\`; check \`architecture_get\`, \`code_owner\`. Each component gets \`affects\` / \`follows\` links and \`owns\` (or \`kind: external\`), as in the mandate skill.
3. Standards: only conventions with a clear majority (violating ≤ ~10%); the rest are questions. Rule = \`level\`, Do / Don't \`examples\` from evidence, \`rationale\`, \`scope\`, \`check\`. One standard at a time: \`question_ask\` purpose \`standard_confirmation\` (Approve / Edit / Skip), then \`standard_create\` / \`standard_section_insert\` with \`cause\`: the answered question.
4. Specs: \`spec_match\`, then extend or \`spec_create\`. Intent, not implementation; one section per behaviour; mermaid only from real call paths; criteria from \`test\` notes first (method \`test\`, \`verifiedBy\`); \`refs\` + \`symbols\`; links \`affects\` / \`follows\` / \`depends_on\`. Tested and implemented: \`verification_record\` per criterion (run the tests; cannot run: \`skipped\`, note "not run", which verifies nothing), \`spec_status_set\` ready, then done only if every criterion passed (on \`done_gate\` stay ready; never force). Partial: \`ready\` + feedback. Gaps: \`draft\`.
5. Area end: ask the collected questions; confirmed sections → \`provenance: "confirmed"\`, the rest → \`feedback_create\` kind \`question\`. Update the plan and \`--area-status distilled\`.

## Stage 3: REVIEW (fresh agent, default on)
Audit each doc of the run against notes and code: unsupported claims, stale refs (open them), criteria without tests, wrong \`owns\` (\`code_owner\`). Fix clear errors, lower \`confidence\` where weak, \`feedback_create\` the rest; list items for the user and coverage gaps (suggest \`audit_plan\`).
Finish: \`work_order_complete\` (outcome: counts, open questions, next steps), \`--stage done\` (notes deleted after 14 days), ask the user to confirm inferred items (UI badges or "confirm <ref>"); \`spec_archive\` the tracking spec.
`;

/** The command (`/mandate-bootstrap [extract|distill|review] [--run <id>] [--area <path>] [--resume] [scope…]`). */
export const BOOTSTRAP_COMMAND = {
  name: 'mandate-bootstrap',
  title: 'Bootstrap Mandate from this codebase',
  description: 'Reverse-engineer this codebase into Mandate (extract → distill → review). Forms: (none) · extract|distill|review [--run id] [--area path] · --resume · scope.',
  argumentHint: '[extract|distill|review] [--run <id>] [--area <path>] [--resume] [scope…]',
  render: (args: string) => `Run the Mandate bootstrap per the "mandate-bootstrap" skill. Arguments: "${args}".
No stage word = all stages. DISTILL and REVIEW each need a fresh agent; without sub-agents, stop after the stage and tell the user to start a new session with "/mandate-bootstrap distill --run <id>".
Skill not loaded: project_info first (stop if flow is off); spec_match before every create; sections get provenance "inferred"; confirm every standard with the user first (question_ask).`,
};

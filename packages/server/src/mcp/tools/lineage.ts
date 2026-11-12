/** Lineage tools: why / led to, blast radius, where standards are used in code, recent writers (attribution). */
import { blastRadiusInputSchema, codeRulesInputSchema, contributorsInputSchema, lineageAnnotateInputSchema, lineageInputSchema, usersResolveInputSchema, whereUsedInputSchema, writersInputSchema } from '@mandate/shared';
import { userDirectory, githubAvatar } from '../../auth/users.js';
import { recentWriters } from '../../storage/writers.js';
import { CauseError } from '../../storage/causes.js';
import { AnnotationError } from '../../storage/lineage-annotations.js';
import { defineTool, needIndex, principalUser } from '../define.js';
import { ToolError } from '../errors.js';

const REFS = '`at` (sha | ISO date) = past state.';

export const lineageTools = [
  defineTool({
    name: 'lineage',
    title: 'Lineage',
    kind: 'read',
    description: `Why any node exists or changed (direction up: causes) and what it led to (down: effects).
Walks recorded causes (write \`cause\`, Feedback / Work-Order / Verification / Audit trailers), oriented cause -> effect. Nodes carry layer (<0 causes, 0 element, >0 effects), status, createdAt / createdBy; edges have recorded: true for write-time causes; summary.text is a one-line digest. structure: true adds structural edges (has_section, depends_on, affects, covers, ...); story: true adds chronological events[]; hideHistory hides commits / versions / agents. ${REFS}
Example: {"ref":"mandate://feedback/fb-01J...","direction":"down"}`,
    input: lineageInputSchema,
    run: (a, ctx) => needIndex(ctx).lineage(a),
  }),
  defineTool({
    name: 'lineage_annotate',
    title: 'Annotate lineage',
    kind: 'write',
    description: `Record the causes of a PAST commit of the data repo (history is never rewritten): appends one frozen record to lineage.jsonl {commit (full sha), causes, note, by, at, confidence?}; lineage then shows caused_by edges from that commit and everything it changed to each cause (source: annotation). confidence: 'low' when the cause is inferred from circumstantial evidence (shown dashed, "inferred"). causes are validated like \`cause\` (existing feedback, findings, work orders, sections, commits ...) and must not be later than the commit. Append-only: a record is never changed; an identical annotation is refused (duplicate).
Example: {"commit":"b7b35d7","causes":["mandate://feedback/fb-0005"],"note":"the edit applies fb-0005 (same day, same section)"}`,
    input: lineageAnnotateInputSchema,
    run: async (a, ctx) => {
      const commits: string[] = [];
      try {
        const rec = await ctx.storage.lineageAnnotationService.annotate(
          { commit: a.commit, causes: a.causes, note: a.note, by: principalUser(ctx) ?? ctx.commit!.agent, ...(a.confidence ? { confidence: a.confidence } : {}) },
          { agent: ctx.commit!.agent, ...(ctx.commit!.branch ? { branch: ctx.commit!.branch } : {}), trailers: { ...ctx.commit!.trailers }, onCommit: (sha) => commits.push(sha) },
        );
        return { id: rec.id, annotation: rec, commit: commits.at(-1) ?? null, commits, warnings: [] };
      } catch (e) {
        if (e instanceof CauseError) throw new ToolError('invalid_cause', e.message, 'pass existing references: a feedback item, audit finding, work order, spec / standard section, ...', e.path.replace(/^cause/, 'causes'));
        if (e instanceof AnnotationError) throw new ToolError(e.code, e.message, e.code === 'cause_after_effect' ? 'a cause must exist before the commit it explains' : 'pass a commit sha of the data repo (history_get / activity list them)', e.path);
        throw e;
      }
    },
  }),
  defineTool({
    name: 'blast_radius',
    title: 'Blast radius',
    kind: 'read',
    description: `Impact BEFORE changing a spec, standard, component, section or code location: dependent specs, standard / rule followers and deviations, affected components and their code, open work orders, feedback and findings. ${REFS}
Example: {"ref":"mandate://standards/api-errors"}`,
    input: blastRadiusInputSchema,
    run: (a, ctx) => needIndex(ctx).blastRadius(a),
  }),
  defineTool({
    name: 'standard_where_used',
    title: 'Where a standard is used',
    kind: 'read',
    description: `Where a standard (or one rule) is used in code: compliant / violating locations (from verifications with codeRefs and open code_deviates findings) per component, plus appliesTo coverage (checked, violating, never-checked files).
Example: {"ref":"mandate://standards/api-errors/sections/error-shape"}`,
    input: whereUsedInputSchema,
    run: (a, ctx) => needIndex(ctx).whereUsed(a),
  }),
  defineTool({
    name: 'code_rules',
    title: 'Rules at a code location',
    kind: 'read',
    description: `Standard rules a code file or range follows (recorded compliant) and violates (failed verification / open finding); ranges match by overlap and whole-file records.
Example: {"ref":"mandate://code/app/src/auth/session.ts#L10-L40"}`,
    input: codeRulesInputSchema,
    run: (a, ctx) => needIndex(ctx).codeRules(a),
  }),
  defineTool({
    name: 'contributors',
    title: 'Contributors',
    kind: 'read',
    description: `People who contributed to elements (server mode only; empty in local mode).
Direct: wrote to the element, its sections, comments or verifications (roles, count, last time, agents). Indirect (kind via): contributed to a recorded cause within depth hops, with the chain; both = direct with alsoVia. Up to 100 refs.
Example: {"refs":["mandate://standards/security-baseline/sections/r-mfa"],"depth":2}`,
    input: contributorsInputSchema,
    run: (a, ctx) => needIndex(ctx).contributors(a, { agentsOnly: ctx.settings?.mode === 'local' }),
  }),
  defineTool({
    name: 'users_resolve',
    title: 'Resolve users',
    kind: 'read',
    description: `Server-mode user directory: login -> name and avatar URL (service:<name> accounts have none). Used by the web UI for avatars.
Example: {"logins":["octocat","service:ci"]}`,
    input: usersResolveInputSchema,
    run: async (a) => {
      const dir = userDirectory();
      return { users: a.logins.map((l) => (dir ? dir.resolve(l) : { login: l, name: null, avatarUrl: l.startsWith('service:') ? null : githubAvatar(l), known: false, service: l.startsWith('service:') })) };
    },
  }),
  defineTool({
    name: 'writers_recent',
    title: 'Recent writers',
    kind: 'read',
    description: `Who wrote to this project recently: commits grouped by user (server mode: GitHub login or service:<name>; local mode: agent only), agent and credential, with unattributed and service-account counts.
Example: {"limit":500}`,
    input: writersInputSchema,
    run: (a, ctx) => recentWriters(ctx.storage.git, ctx.settings?.mode ?? null, a.limit),
  }),
];

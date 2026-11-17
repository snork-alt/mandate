/**
 * Audit tools. An audit is a written report (`audits/<id>.md`) by a coding agent on whether the code TODAY conforms to
 * a spec (criteria + applicable rules) or a standard (its rules). Mandate never reads the code: it gives the checklist
 * (audit_plan), stores the report (each write is a commit with an `Audit:` trailer), freezes it on completion, turns
 * code deviations into fix work orders and tracks re-checks.
 */
import {
  auditAbandonInputSchema,
  auditCompleteInputSchema,
  auditFindingsInputSchema,
  auditFindingRelinkInputSchema,
  auditFindingsToWorkOrdersInputSchema,
  auditGetInputSchema,
  auditListInputSchema,
  auditOverviewInputSchema,
  auditPlanInputSchema,
  auditRequestInputSchema,
  auditRecheckInputSchema,
  auditRecordItemInputSchema,
  auditStartInputSchema,
  buildFindingRef,
  buildRef,
  commitRefSchema,
  docRefSchema,
  sectionRefSchema,
} from '@mandate/shared';
import { slugSchema } from '@mandate/doc';
import { z } from 'zod';
import type { CommitMeta } from '../../storage/index.js';
import { ToolError } from '../errors.js';
import { defineTool, type AnyToolDef, type ToolContext } from '../define.js';
import { clientIdentity } from '../../projects/settings.js';
import { newsOfProject, seedKnownClients } from '../../comments/route.js';
import { afterAuditComplete, deliverAuditRequested } from '../../flow/audit-flow.js';
import { checkClaim, checkCodeRepos, repoOfLocation, requireCommit } from '../code-claims.js';

function metaOf(ctx: ToolContext, commits: string[], extra: Record<string, string> = {}): CommitMeta {
  const c = ctx.commit!;
  return { agent: c.agent, ...(c.branch ? { branch: c.branch } : {}), trailers: { ...c.trailers, ...extra }, onCommit: (sha) => commits.push(sha) };
}
const commitsOf = (commits: string[]) => ({ commit: commits.at(-1) ?? null, commits });
/** The auditor: the agent identity plus the user it acts as. */
// The user is the write's attributed user (a GitHub login or service:<name>).
const auditor = (ctx: ToolContext) => ({ agent: ctx.commit!.agent, ...(ctx.commit!.user ? { user: ctx.commit!.user } : {}) });
const result = async (ctx: ToolContext, id: string, commits: string[], extra: Record<string, unknown> = {}) => {
  const { audit } = await ctx.storage.auditService.get(id);
  return { ref: buildRef({ kind: 'audits', id }), ...commitsOf(commits), warnings: [] as string[], ...extra, audit };
};

/** Write boilerplate lives once in the server INSTRUCTIONS. */
const COMMON = '';
const REPORT = 'An audit is a written report: explain in prose how you checked each item against the code (quote or point at code with code refs) and why it passes or fails; give every finding a description and a suggested fix.';

export const auditSectionGetInputSchema = z
  .object({
    ref: sectionRefSchema(['audits']).optional(),
    doc: docRefSchema(['audits'], { sections: false }).optional(),
    section: slugSchema.optional(),
    at: commitRefSchema.optional(),
  })
  .strict()
  .refine((v) => !!v.ref !== !!(v.doc && v.section), { message: 'give either ref, or doc and section' });

/** audit_record_item: finding code refs in registered repos; the audit itself names the audited code (repo + commit). */
async function itemCodeWarnings(ctx: ToolContext, auditId: string, codeRefs: unknown[]): Promise<string[]> {
  const warnings = checkCodeRepos(ctx, codeRefs.map(repoOfLocation).filter((r): r is string => !!r), 'findings.codeRefs');
  const doc = await ctx.storage.audits.get(auditId).catch(() => null);
  if (doc && !doc.code && ctx.settings) warnings.push('code_commit_missing: this audit was started without code { repo, commit }; its results are not tied to a code commit (start audits with code)');
  return warnings;
}

export const auditTools: AnyToolDef[] = [
  defineTool({
    name: 'audit_plan',
    title: 'Audit plan',
    kind: 'read',
    description: `The checklist to audit a spec or a standard: its acceptance criteria plus every applicable rule (level must | should | may, check, rationale, the spec sections a rule follows), the code to inspect (the spec's code refs, the owns globs of the components it affects; for a standard: its appliesTo paths / languages, rule scopes and the code of the specs using it), prior open findings, the last audit and any audit still in progress. Mandate never reads the code: you inspect it.
Example: {"target":"mandate://specs/login-sso"}`,
    input: auditPlanInputSchema,
    run: (a, ctx) => ctx.storage.auditService.plan(a.target),
  }),
  defineTool({
    name: 'audit_start',
    title: 'Start an audit',
    kind: 'write',
    description: `Start an audit report of a spec or standard: creates audits/<yyyy-mm-dd>-<target>.md with an overview section and one audit-item section per checklist item (result pending), pinned to the Mandate commit (default HEAD); pass code { repo, commit, branch } for the code you audit. Prefer that a different agent or session audits than the one that implemented.${COMMON}
Example: {"target":"mandate://specs/login-sso","code":{"repo":"app","commit":"3f2a9c1d"}}`,
    input: auditStartInputSchema,
    run: async (a, ctx) => {
      const commits: string[] = [];
      if (!a.request && !a.target) throw new ToolError('validation', 'give target (a spec or standard) or request (the audit you were asked to do)', 'e.g. {"target":"mandate://specs/login-sso"}', 'target');
      if (a.request) {
        // The agent that was asked to do it (audit-request event) starts THAT audit.
        const news = newsOfProject(ctx);
        const me = clientIdentity(ctx);
        const cw = a.code ? checkClaim(ctx, a.code, 'code') : [];
        const id = a.request.replace(/^mandate:\/\/audits\//, '');
        await ctx.storage.auditService.begin({ auditId: id, ...(a.code ? { code: a.code } : {}) }, auditor(ctx), { id: me.id, handles: news?.presence.get(me.id)?.label ? [news.presence.get(me.id)!.label] : [] }, metaOf(ctx, commits));
        return { ...(await result(ctx, id, commits)), warnings: cw };
      }
      // The audited code is a claim about code: repo (registered) + commit.
      const warnings: string[] = a.code ? checkClaim(ctx, a.code, 'code') : requireCommit(ctx, 'an audit asserts the state of code: pass code { repo, commit } (the code you audit)', 'code: { "repo": "<short name from project_info.codeRepos>", "commit": "<sha>" }', 'code');
      const target = a.target!;
      const doc = await ctx.storage.auditService.start({ ...a, target }, auditor(ctx), metaOf(ctx, commits));
      const plan = await ctx.storage.auditService.plan(target);
      if (plan.inProgress && plan.inProgress.id !== doc.id) warnings.push(`another audit of this target is in progress: ${plan.inProgress.uri}`);
      return { ...(await result(ctx, doc.id, commits)), warnings };
    },
  }),
  defineTool({
    name: 'audit_request',
    title: 'Request an audit from an agent',
    kind: 'write',
    uiAllowed: true,
    description: `Queue a FULL audit (every section, own and inherited criteria) of a spec or standard for an agent: assignee = an agent handle (agents_presence). It is created in state requested and the agent is told (audit-request event; an offline agent is caught up when it connects, the audit stays queued). The agent starts it with audit_start { request } and records items; progress shows on the spec page. Findings become requests (code deviates) or questions for the user (spec wrong / ambiguous).
Example: {"target":"mandate://specs/login-sso","assignee":"claude-code@mbp"}`,
    input: auditRequestInputSchema,
    run: async (a, ctx) => {
      const commits: string[] = [];
      const c = ctx.commit!;
      const news = newsOfProject(ctx);
      const h = a.assignee.trim();
      const assignee = news?.presence.resolve(h)[0] ?? h;
      const label = news?.presence.get(assignee)?.label ?? assignee;
      const by = ctx.principal?.kind === 'ui' ? ctx.principal.user.login : undefined;
      const doc = await ctx.storage.auditService.start({ target: a.target, ...(a.note ? { overview: a.note } : {}) }, { agent: label }, metaOf(ctx, commits), { assignee, ...(by ? { requestedBy: by } : {}), ...(a.trigger ? { trigger: a.trigger } : {}) });
      const { audit } = await ctx.storage.auditService.get(doc.id);
      if (news) await seedKnownClients(ctx, news.presence);
      const delivered = await deliverAuditRequested(news, audit, a.note);
      return { ...(await result(ctx, doc.id, commits)), assignee, queued: !news?.presence.isOnline(assignee), delivered, agent: c.agent };
    },
  }),
  defineTool({
    name: 'audit_record_item',
    title: 'Record an audit item',
    kind: 'write',
    description: `Record one checklist item of an in-progress audit: ref (plan item), result pass | fail | partial | n_a, notes (how you checked, why; required for fail / partial), findings for fail / partial { title, description, suggestedFix, evidence, codeRefs, classification code_deviates | spec_wrong | ambiguous, severity (default from level) }. Re-recording replaces the item. ${REPORT}${COMMON}`,
    input: auditRecordItemInputSchema,
    run: async (a, ctx) => {
      const commits: string[] = [];
      const warnings = await itemCodeWarnings(ctx, a.auditId, (a.findings ?? []).flatMap((f) => (f as { codeRefs?: unknown[] }).codeRefs ?? []));
      const { item } = await ctx.storage.auditService.recordItem(a, metaOf(ctx, commits));
      return { ...(await result(ctx, a.auditId, commits, { item: buildRef({ kind: 'audits', id: a.auditId, sectionId: item.id }), findings: (item.findings ?? []).map((f) => buildFindingRef({ audit: a.auditId, id: f.id })) })), warnings };
    },
  }),
  defineTool({
    name: 'audit_complete',
    title: 'Complete an audit',
    kind: 'write',
    description: `Complete an audit: summary (one line) and overview (scope, what was inspected, assessment, risks, recommendations; required unless already written).${COMMON}`,
    input: auditCompleteInputSchema,
    run: async (a, ctx) => {
      const commits: string[] = [];
      await ctx.storage.auditService.complete(a, metaOf(ctx, commits));
      const flow = await afterAuditComplete(ctx, a.auditId, metaOf(ctx, commits));
      return result(ctx, a.auditId, commits, { flow, note: flow.requests.length || flow.questions.length ? `Findings fed the flow: ${flow.requests.length} request(s) (assigned to the auditing agent: run /mandate resume <id>) and ${flow.questions.length} question(s) for the user.` : undefined });
    },
  }),
  defineTool({
    name: 'audit_abandon',
    title: 'Abandon an audit',
    kind: 'write',
    description: `Abandon an audit in progress (reason optional). It stays in history; start a new one to audit again.${COMMON}`,
    input: auditAbandonInputSchema,
    run: async (a, ctx) => {
      const commits: string[] = [];
      await ctx.storage.auditService.abandon(a, metaOf(ctx, commits));
      return result(ctx, a.auditId, commits);
    },
  }),
  defineTool({
    name: 'audit_findings_to_work_orders',
    title: 'Turn findings into fix work orders',
    kind: 'write',
    description: `After a completed audit and the user's approval: ONE fix work order per spec for open must / should code_deviates findings (includeShould: false drops should; may never), linked to the findings. Returns feedbackNeeded (spec_wrong / ambiguous): request_create with fromFinding for each.${COMMON}`,
    input: auditFindingsToWorkOrdersInputSchema,
    run: async (a, ctx) => {
      const commits: string[] = [];
      const out = await ctx.storage.auditService.findingsToWorkOrders(a, ctx.commit!.agent, metaOf(ctx, commits));
      return { ref: buildRef({ kind: 'audits', id: a.auditId }), ...commitsOf(commits), warnings: [], ...out };
    },
  }),
  defineTool({
    name: 'audit_recheck',
    title: 'Re-check a finding',
    kind: 'write',
    description: `Re-check one finding on the SAME audit after its fix: pass (with the code commit), fail (stays open) or wont_fix (notes required); or a whole item (item: pass | fail | partial | n_a, notes). Appended; the original result stays.${COMMON}
Example: {"auditId":"2026-11-12-login-sso","findingId":"f2","result":"pass","commit":"9ab1c2d","notes":"Verified the callback now rejects unverified emails (src/auth/callback.ts#L40-L52)."}`,
    input: auditRecheckInputSchema,
    run: async (a, ctx) => {
      const commits: string[] = [];
      // pass / fail / partial assert the state of code: the re-checked commit is required.
      const cw = !a.commit && a.result !== 'wont_fix' && a.result !== 'n_a' ? requireCommit(ctx, `a ${a.result} re-check asserts the state of code: pass commit (the code commit you re-checked)`, 'commit: "<sha>" of the audited repo', 'commit') : [];
      if (a.item) {
        const { item } = await ctx.storage.auditService.recheckItem({ auditId: a.auditId, item: a.item, result: a.result as 'pass', notes: a.notes ?? '', ...(a.commit ? { commit: a.commit } : {}) }, ctx.commit!.agent, metaOf(ctx, commits));
        return { ...(await result(ctx, a.auditId, commits)), item: buildRef({ kind: 'audits', id: a.auditId, sectionId: item.id }), warnings: cw };
      }
      const { warnings } = await ctx.storage.auditService.recheck({ ...a, findingId: a.findingId!, result: a.result as 'pass' }, ctx.commit!.agent, metaOf(ctx, commits));
      return { ...(await result(ctx, a.auditId, commits)), finding: buildFindingRef({ audit: a.auditId, id: a.findingId! }), warnings: [...cw, ...warnings] };
    },
  }),
  defineTool({
    name: 'audit_finding_relink',
    title: 'Relink a finding',
    kind: 'write',
    description: `Point an open finding at a replacement fix work order after its linked one was cancelled or failed (frozen audits too).${COMMON}`,
    input: auditFindingRelinkInputSchema,
    run: async (a, ctx) => {
      const commits: string[] = [];
      const { previous } = await ctx.storage.auditService.relinkFinding(a, ctx.commit!.agent, metaOf(ctx, commits));
      return { ...(await result(ctx, a.auditId, commits)), finding: buildFindingRef({ audit: a.auditId, id: a.findingId }), previous };
    },
  }),
  defineTool({
    name: 'audit_get',
    title: 'Get an audit',
    kind: 'read',
    description: `One audit: the derived view (items with results, notes and findings joined with their fix work orders / requests, counts per level, outcome pass | warn | fail, staleness with reasons and "N commits since") and the stored report document. Sections: audit_section_get; history: history_get.
Example: {"auditId":"mandate://audits/2026-11-12-login-sso"}`,
    input: auditGetInputSchema,
    run: (a, ctx) => ctx.storage.auditService.get(a.auditId),
  }),
  defineTool({
    name: 'audit_section_get',
    title: 'Get an audit section',
    kind: 'read',
    description: `One section of an audit report (overview or an audit-item: ref, level, result, findings, body), optionally at a commit.
Example: {"ref":"mandate://audits/2026-11-12-login-sso/sections/ac-google-signin"}`,
    input: auditSectionGetInputSchema,
    run: (a, ctx) => ctx.reads.auditSectionGet(auditSectionGetInputSchema.parse(a)),
  }),
  defineTool({
    name: 'audit_list',
    title: 'List audits',
    kind: 'read',
    description: `Audits, newest first, as summaries (target, status, outcome, auditor, counts, open findings, stale + commitsSince). Filters: target, status (in_progress | completed | abandoned), stale.
Example: {"target":"mandate://specs/login-sso","status":["completed"]}`,
    input: auditListInputSchema,
    run: (a, ctx) => ctx.storage.auditService.listSummaries(a),
  }),
  defineTool({
    name: 'audit_findings',
    title: 'List audit findings',
    kind: 'read',
    description: `Findings across audits (most severe first) with their resolution (open | resolved | wont_fix, fix work order, request, re-checks). Filters: target, status, classification, severity.
Example: {"status":["open"],"classification":["code_deviates"]}`,
    input: auditFindingsInputSchema,
    run: (a, ctx) => ctx.storage.auditService.findings(a),
  }),
  defineTool({
    name: 'audit_overview',
    title: 'Audit overview',
    kind: 'read',
    description: `When each spec was last audited (lastAudit: at, auditor, result, open findings, stale, commitsSince; null = never) and an audit status per component (worst open finding of the specs affecting it). Use it to find what needs an audit.`,
    input: auditOverviewInputSchema,
    run: (_a, ctx) => ctx.storage.auditService.overview(),
  }),
];

/**
 * Audits in the flow. An audit the user requested (web UI Audit button, or the auditAfterWorkOrder setting) is queued for
 * an agent (`audit_requested` event, exclusive like requests). When it completes, its findings feed the flow:
 *  - code_deviates (must / should) -> a request (source audit, linked to the finding) assigned to the auditing agent;
 *  - spec_wrong / ambiguous -> a question to the user (Waiting for you) with options;
 *  - what the audit confirms (full-spec audit, no open finding on the section's criteria) moves the sections' implemented
 *    marker to the current commit, acknowledges their upstream links (seenAt) and refreshes their out-of-date test results.
 */
import { buildRef, type Audit, type AuditFinding, type StoredSpec } from '@mandate/shared';
import type { NewsService } from '../news/index.js';
import type { CommitMeta } from '../storage/index.js';
import { clientIdentity } from '../projects/settings.js';
import { newsOfProject, seedKnownClients } from '../comments/route.js';
import type { ToolContext } from '../mcp/define.js';
import { UPSTREAM_RELS } from '../storage/model.js';
import { assignedSummary, deliverAssigned } from './assign.js';

export const AUDIT_REQUESTED_KIND = 'audit_requested';
const clip = (s: string, n: number) => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

export function auditRequestedSummary(a: Pick<Audit, 'id' | 'targetTitle' | 'target' | 'requestedBy' | 'trigger'>, note?: string): string {
  const by = a.trigger ? `queued after ${a.trigger.replace('work-order:', 'work order ')}` : `requested${a.requestedBy ? ` by ${a.requestedBy}` : ''} in the web UI`;
  return `Audit ${a.id} of ${a.targetTitle ?? a.target} ${by}${note ? ` (${clip(note, 200)})` : ''}. Hand it to the mandate-audit subagent in the background (audit_start { request: "${a.id}" } starts it) and carry on.`;
}

/** Tell the assigned agent (stored as a news item: an offline agent is caught up when it connects). Returns the delivered client ids. */
export async function deliverAuditRequested(news: NewsService | null | undefined, a: Audit, note?: string): Promise<string[]> {
  if (!news || !a.assignee) return [];
  try {
    await news.addClientWide(a.assignee, AUDIT_REQUESTED_KIND, a.uri, auditRequestedSummary(a, note));
    return [a.assignee];
  } catch {
    return [];
  }
}

const sectionRef = (spec: string, id: string) => buildRef({ kind: 'specs', id: spec, sectionId: id });

/** After audit_complete: requests, questions and confirmed sections. Never throws (the audit is already completed). */
export async function afterAuditComplete(ctx: ToolContext, auditId: string, meta: CommitMeta): Promise<{ requests: string[]; questions: string[]; confirmed: string[]; refreshed: string[]; acknowledged: number }> {
  const out = { requests: [] as string[], questions: [] as string[], confirmed: [] as string[], refreshed: [] as string[], acknowledged: 0 };
  try {
    const { audit } = await ctx.storage.auditService.get(auditId);
    if (audit.status !== 'completed') return out;
    const me = clientIdentity(ctx).id;
    const agent = audit.assignee ?? me;
    const asked = !!audit.assignee || !!audit.requestedBy;
    if (asked) await routeFindings(ctx, audit, agent, meta, out);
    if (audit.targetKind === 'spec') await confirmSpec(ctx, audit, meta, out);
  } catch {
    /* best effort */
  }
  return out;
}

async function routeFindings(ctx: ToolContext, audit: Audit, agent: string, meta: CommitMeta, out: { requests: string[]; questions: string[] }): Promise<void> {
  const news = newsOfProject(ctx);
  const open = audit.items.flatMap((i) => i.findings).filter((f) => f.status === 'open' && !f.resolution.feedback && !f.resolution.workOrder && f.level !== 'may');
  const existing = await ctx.storage.questionService.list().catch(() => []);
  for (const f of open) {
    if (f.classification === 'code_deviates') {
      const body = `Fix the code: ${f.title}. ${clip(f.description, 600)}${f.suggestedFix ? ` Suggested fix: ${clip(f.suggestedFix, 400)}` : ''}${f.codeRefs.length ? ` Code: ${f.codeRefs.join(', ')}.` : ''} (audit finding ${f.uri})`;
      const created = await ctx.storage.lock.run(async () => {
        const fb = await ctx.storage.feedbackService.create({ targets: [f.ref], kind: 'bug', body, source: 'audit', assignee: agent, assignedAt: new Date().toISOString(), priority: f.level === 'must' ? 'high' : 'normal', context: [audit.uri, f.ref], fromFinding: f.uri } as never, meta);
        await ctx.storage.auditService.linkFeedback(f.uri, fb.id, meta.agent ?? 'mandate', { ...meta, trailers: { ...meta.trailers, Audit: audit.id } });
        return fb;
      });
      out.requests.push(created.id);
      if (news) {
        await seedKnownClients(ctx, news.presence);
        await deliverAssigned(news, created, 'new');
      }
    } else {
      if (existing.some((q) => q.status === 'open' && q.context.includes(f.uri))) continue;
      const spec = f.classification === 'spec_wrong';
      const q = await ctx.storage.questionService.ask(
        {
          purpose: 'decision',
          context: [f.ref, audit.uri],
          blocking: false,
          questions: [
            {
              header: spec ? 'Spec wrong' : 'Ambiguous',
              question: clip(`${f.itemTitle}: ${f.title}. ${spec ? 'The audit says the spec is wrong, not the code.' : 'The audit found the spec ambiguous.'} ${f.description}`, 480),
              options: [
                { label: 'Update the spec', description: 'Change the spec to match the code; an agent will propose the edit.' },
                { label: 'Fix the code', description: 'Keep the spec as written; the code gets fixed.' },
                { label: 'Leave as is', description: 'Accept the difference for now.' },
              ],
              recommended: spec ? 'Update the spec' : 'Fix the code',
              multiSelect: false,
            },
          ],
        } as never,
        { agent: meta.agent ?? 'mandate-audit', client: agent },
        meta,
      );
      out.questions.push(q.id);
    }
  }
}

async function confirmSpec(ctx: ToolContext, audit: Audit, meta: CommitMeta, out: { confirmed: string[]; refreshed: string[]; acknowledged: number }): Promise<void> {
  const st = ctx.storage;
  const specId = audit.target.replace('mandate://specs/', '');
  const spec = (await st.specs.get(specId).catch(() => null)) as StoredSpec | null;
  if (!spec || spec.status === 'archived') return;
  const openItems = new Set(audit.items.filter((i) => i.findings.some((f) => f.status === 'open') || i.result === 'fail' || i.result === 'partial').map((i) => i.ref));
  // An open finding on an inherited rule (a standard's item) is not mapped to a section: nothing is confirmed then.
  if ([...openItems].some((r) => !r.startsWith(`mandate://specs/${specId}/`))) return;
  const own = new Set(audit.items.map((i) => i.ref));
  const confirmed = spec.sections.filter((s) => {
    if (s.archived || s.type === 'acceptance' || s.type === 'rule') return false;
    const mine = [sectionRef(specId, s.id), ...s.verifiedBy.map((v) => sectionRef(specId, v))].filter((r) => own.has(r));
    return !mine.some((r) => openItems.has(r));
  });
  if (!confirmed.length) return;
  const ids = new Set(confirmed.map((s) => s.id));
  const head = await st.git.head().catch(() => null);
  const base = (await st.history.meta(st.specs.pathOf(spec.id)).catch(() => ({ lastCommit: null as string | null }))).lastCommit;
  const at = (meta.date ?? new Date()).toISOString();
  const links = await st.linkService.forDoc('specs', spec).catch(() => null);
  const stale = links ? new Set(Object.entries(links.sections).filter(([k]) => ids.has(k)).flatMap(([k, v]) => v.outgoing.filter((l) => l.upstreamChanged).map((l) => `${k}|${l.to}|${l.rel}`))) : new Set<string>();
  let acked = 0;
  await st.specs.modify(
    spec.id,
    (cur) => ({
      ...cur,
      sections: cur.sections.map((s) => {
        if (!ids.has(s.id)) return s;
        const links = s.links.map((l) => (UPSTREAM_RELS.has(l.rel) && head && stale.has(`${s.id}|${l.to}|${l.rel}`) ? (acked++, { ...l, seenAt: head }) : l));
        const marker = s.implementedCommit && base ? { implementedCommit: base, implementationNotes: [...(s.implementationNotes ?? []), { kind: 'reverified' as const, commit: base, reason: `confirmed by audit ${audit.id}`, by: meta.agent ?? 'audit', at }] } : {};
        return { ...s, ...marker, links };
      }),
    }) as never,
    { ...meta, message: `spec(${spec.id}): confirmed by audit ${audit.id} (${confirmed.length} sections)`, trailers: { ...meta.trailers, Audit: audit.id } },
  );
  out.confirmed = [...ids];
  out.acknowledged = acked;
  // Out-of-date test results of the criteria the audit passed: re-recorded against the current commit.
  const v = await st.verificationService.forSpec(spec).catch(() => null);
  const passed = new Set(audit.items.filter((i) => i.result === 'pass').map((i) => i.ref));
  for (const c of v?.own ?? []) {
    if ((c.state !== 'stale' && c.state !== 'unknown') || !passed.has(c.uri) || c.last?.result !== 'pass') continue;
    try {
      const l = c.last;
      await st.verificationService.record({ criterion: l.criterion, appliedTo: l.appliedTo, code: audit.code ?? l.code, result: 'pass', method: l.method, evidence: { ...(l.evidence ?? {}), note: `re-confirmed by audit ${audit.id}` } } as never, { ...meta, trailers: { ...meta.trailers, Audit: audit.id } });
      out.refreshed.push(c.uri);
    } catch {
      /* keep stale */
    }
  }
}

export { assignedSummary };

/** Project setting auditAfterWorkOrder: queue a full audit of the spec for the agent that completed the work order. Never throws. */
export async function queueAuditAfterWorkOrder(ctx: ToolContext, workOrderId: string, meta: CommitMeta): Promise<string | null> {
  try {
    if (ctx.settings?.policy().auditAfterWorkOrder !== 'on') return null;
    const wo = await ctx.storage.workOrderService.get(workOrderId);
    if (!['implement', 'update', 'fix'].includes(wo.kind)) return null;
    const target = buildRef({ kind: 'specs', id: wo.spec });
    const open = (await ctx.storage.auditService.list()).some((a) => a.target === target && (a.status === 'requested' || a.status === 'in_progress'));
    if (open) return null;
    const news = newsOfProject(ctx);
    const me = clientIdentity(ctx);
    const label = news?.presence.get(me.id)?.label ?? ctx.commit?.agent ?? me.id;
    const doc = await ctx.storage.auditService.start({ target }, { agent: label }, meta, { assignee: me.id, trigger: `work-order:${workOrderId}` });
    const { audit } = await ctx.storage.auditService.get(doc.id);
    if (news) await seedKnownClients(ctx, news.presence);
    await deliverAuditRequested(news, audit, `the sections ${wo.sections.map((s) => s.id).join(', ')} changed`);
    return doc.id;
  } catch {
    return null;
  }
}

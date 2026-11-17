/**
 * Decisions (MCP `decisions_list`, the Overview's "Needs a decision"): every item that waits for a HUMAN decision, with
 * a one-line question, the options (and the Mandate tool that applies each) and a suggested default when derivable.
 * A coding agent can walk the list with the user; the web UI shows the same list.
 */
import {
  buildRef,
  DECISION_KINDS,
  decisionsListInputSchema,
  allSectionsFinished,
  isClaimStale,
  OPEN_WORK_ORDER_STATUSES,
  type Decision,
  type DecisionKind,
  type DecisionsList,
  type DecisionsListInput,
} from '@mandate/shared';
import { deriveSpecs } from './insights.js';

/** "ac-callback-logging" -> "Callback logging" (criterion / section ids to a readable label). */
const humanize = (sid: string) => {
  const t = sid.replace(/^(ac|sec|api|test|ui)-/, '').replace(/-/g, ' ').trim();
  return t ? t[0]!.toUpperCase() + t.slice(1) : sid;
};
/** A mandate:// reference to a short readable label ("specs/login-sso/sections/callback" -> "login-sso › callback"). */
const pretty = (ref: string) => {
  const m = ref.replace(/^mandate:\/\//, '').match(/^[a-z-]+\/([^/@]+)(?:@[^/]+)?(?:\/sections\/([^#]+))?/);
  return m ? (m[2] ? `${m[1]} › ${m[2]}` : m[1]!) : ref;
};
import type { Storage } from './index.js';

const one = (s: string, n = 140) => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const HOUR = 3_600_000;
const ago = (iso: string, now: number) => {
  const h = Math.max(0, (now - Date.parse(iso)) / HOUR);
  return h < 1 ? `${Math.round(h * 60)} min` : h < 48 ? `${Math.round(h)} h` : `${Math.round(h / 24)} days`;
};
const WAIVER_WHY: Record<string, string> = {
  no_feedback: 'the user has not approved it (no answered approval question)',
  feedback_missing: 'its approval record is missing',
  not_accepted: 'the user has not approved it yet',
  same_author: 'it was approved by its own author',
  self_approved: 'it was self-approved',
  stale: 'the criterion changed since the approval',
};
/** Kind order = priority order (broken invariants first). */
const ORDER = new Map(DECISION_KINDS.map((k, i) => [k, i]));

export async function listDecisions(storage: Storage, input: DecisionsListInput = {}, now = Date.now()): Promise<DecisionsList> {
  const { kinds, limit } = decisionsListInputSchema.parse(input);
  const want = (k: DecisionKind) => !kinds || kinds.includes(k);
  const m = await storage.model();
  const items: Decision[] = [];
  const specTitle = new Map(m.specs.map((s) => [s.id, s.title]));
  const integrity = await storage.integrity.current();

  // Open questions agents asked through Mandate (question_ask): the user answers them in the web UI.
  for (const q of await storage.questionService.list(now)) {
    if (q.status !== 'open') continue;
    const first = q.questions[0]!;
    const rec = Array.isArray(first.recommended) ? first.recommended[0] : first.recommended;
    items.push({
      ref: q.uri,
      kind: 'question',
      title: q.questions.map((x) => x.header).join(' · '),
      question: q.questions.length > 1 ? `${q.questions.length} questions: ${one(first.question, 110)}` : one(first.question),
      options: first.options.map((o) => ({ id: o.label, label: `${o.label}: ${one(o.description, 90)}`, tool: 'question_answer' })),
      ...(rec ? { suggested: rec } : {}),
      context: `${q.asker.user ? `${q.asker.user} via ` : ''}${q.asker.agent} · ${q.purpose.replace(/_/g, ' ')}${q.blocking ? ' · blocking' : ''}`,
      ...(q.context[0] ? { subject: q.context[0] } : {}),
      since: q.createdAt,
      ask: q,
    });
  }

  // Integrity errors (ready_gate and every other broken invariant).
  for (const i of integrity.issues) {
    if ((i.severity ?? 'warning') !== 'error') continue;
    items.push({
      ref: i.uri,
      kind: 'integrity_error',
      title: i.rule.replace(/_/g, ' '),
      question: `${one(i.message)}: fix it now${i.hint ? ` (${one(i.hint, 90)})` : ''}?`,
      options: [
        { id: 'fix', label: i.hint ? `Fix: ${one(i.hint, 90)}` : 'Fix it' },
        { id: 'later', label: 'Leave it for now (writes that touch it stay blocked)' },
      ],
      suggested: 'fix',
      context: `Integrity rule ${i.rule}`,
    });
  }

  const workOrders = await storage.workOrderService.list();
  const open = workOrders.filter((w) => OPEN_WORK_ORDER_STATUSES.includes(w.status));

  // Waivers (deviates_from / exemptions) that do not waive yet.
  if (want('waiver_pending')) {
    const recs = await storage.verificationService.list();
    for (const spec of m.specs) {
      if (spec.status === 'archived') continue;
      const v = await storage.verificationService.forSpec(spec, recs, m);
      for (const c of [...v.own, ...v.inherited.flatMap((g) => g.criteria)]) {
        if (!c.waiver || c.waiver.effective) continue;
        const why = WAIVER_WHY[c.waiver.reason ?? 'not_accepted'] ?? (c.waiver.reason ?? '').replace(/_/g, ' ');
        items.push({
          ref: c.uri,
          kind: 'waiver_pending',
          title: `${c.title} (${spec.title})`,
          question: `Waive "${one(c.title, 80)}" for ${spec.title}? It is not in effect: ${why}.`,
          options: [
            { id: 'approve', label: 'Approve: the agent asks (question_ask purpose approval) and cites the answer' },
            { id: 'reject', label: 'Reject: the spec must meet the criterion (remove the deviation)' },
          ],
          context: one(c.waiver.note || why),
          subject: buildRef({ kind: 'specs', id: spec.id }),
          ...(c.waiver.feedback ? { feedback: c.waiver.feedback } : {}),
          ...(c.waiver.reason === 'same_author' || c.waiver.reason === 'self_approved' ? { selfApproval: true } : {}),
        });
      }
    }
  }

  // Approval overrides (self-approved acceptances) and contradicted audit passes, from the integrity report.
  for (const i of integrity.issues) {
    if (i.rule === 'audit_pass_contradicted') {
      items.push({
        ref: i.uri,
        kind: 'audit_contradicted',
        title: `Audit item “${humanize(i.uri.split('/').pop() ?? '')}” passes but a finding contradicts it`,
        context: `audit ${i.uri.replace(/^mandate:\/\/audits\//, '').split('/')[0]} · ${one(i.message, 120)}`,
        question: `An audit pass is contradicted (${one(i.message, 100)}): re-audit the item?`,
        options: [
          { id: 'reaudit', label: 'Record a failing verification and re-check the item', tool: 'audit_recheck' },
          { id: 'keep', label: 'Keep the pass (the finding does not apply)' },
        ],
        suggested: 'reaudit',
      });
    }
  }

  // Draft standards: their rules apply only once the user confirms them.
  for (const s of m.standards) {
    if (s.status !== 'draft') continue;
    items.push({
      ref: buildRef({ kind: 'standards', id: s.id }),
      kind: 'standard_draft',
      title: s.title,
      question: `Confirm the rules of draft standard "${s.title}" and make it active?`,
      options: [
        { id: 'activate', label: 'Confirm the rules and activate it', tool: 'status_set' },
        { id: 'keep_draft', label: 'Keep it as a draft (not in force)' },
      ],
    });
  }

  // Stale claims: no heartbeat for a while; another agent may take the work over.
  for (const w of open) {
    if (!w.claim || allSectionsFinished(w.sections) || !isClaimStale(w.claim, now)) continue; // all done: waiting for completion, nothing to release
    const age = now - Date.parse(w.claim.heartbeatAt);
    items.push({
      ref: buildRef({ kind: 'work-orders', id: w.id }),
      kind: 'stale_claim',
      title: `${w.id} ${w.title ?? ''}`.trim(),
      question: `${w.claim.agent} has not sent a heartbeat on ${w.id} for ${ago(w.claim.heartbeatAt, now)}: release the claim so another agent can continue?`,
      options: [
        { id: 'release', label: 'Release the claim', tool: 'work_order_release' },
        { id: 'wait', label: 'Wait for the agent' },
      ],
      ...(age > 2 * HOUR ? { suggested: 'release' } : {}),
      context: `claimed by ${w.claim.agent}; last heartbeat ${ago(w.claim.heartbeatAt, now)} ago`,
      subject: buildRef({ kind: 'specs', id: w.spec }),
      since: w.claim.heartbeatAt,
    });
  }

  // Done specs whose gate no longer holds (the "drifted" maturity overlay).
  if (want('spec_drifted')) {
    const derived = await deriveSpecs(m.specs, m, storage.verificationService);
    for (const s of m.specs) {
      const drift = derived[s.id]?.drift ?? [];
      if (s.status === 'archived' || !drift.length) continue;
      items.push({
        ref: buildRef({ kind: 'specs', id: s.id }),
        kind: 'spec_drifted',
        title: specTitle.get(s.id) ?? s.id,
        question: `"${s.title}" is done but its gate no longer holds (${one(drift.join('; '), 100)}): verify again or reopen it?`,
        options: [
          { id: 'verify', label: 'Verify the criteria again', tool: 'verification_record' },
          { id: 'reopen', label: 'Reopen the spec (done → ready)', tool: 'status_set' },
        ],
        suggested: 'verify',
      });
    }
  }

  const counts = Object.fromEntries(DECISION_KINDS.map((k) => [k, 0])) as Record<DecisionKind, number>;
  for (const d of items) counts[d.kind]++;
  const picked = items.filter((d) => want(d.kind)).sort((a, b) => ORDER.get(a.kind)! - ORDER.get(b.kind)! || (b.since ?? '').localeCompare(a.since ?? ''));
  return { items: picked.slice(0, limit), total: picked.length, counts: kinds ? (Object.fromEntries(DECISION_KINDS.map((k) => [k, want(k) ? counts[k] : 0])) as Record<DecisionKind, number>) : counts };
}

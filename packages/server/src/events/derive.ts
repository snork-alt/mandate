/**
 * Commit -> activity events. Types come from the commit's trailers and structured diffs: `diffDocs` for specs and
 * standards (section inserted / updated / moved / deleted, status changes), line-by-id diffs for work orders,
 * feedback and verifications. Pure over git reads, so the same commit always yields the same events (cacheable).
 */
import { diffDocs, type DocFormat } from '@mandate/doc';
import { buildRef, causesOfTrailers, userOfTrailers, type ActivityEvent, type ActivityType, type PreviewOp } from '@mandate/shared';
import type { GitStore } from '../git/GitStore.js';
import { auditFormat, componentFormat, specFormat, standardFormat, workOrderCodec } from '../storage/codecs.js';
import { parseCommitMessage } from '../storage/history.js';
import { MIGRATION_TRAILER, projectWorkOrder } from '../storage/work-order-docs.js';

// MW-10: components are documents too (component.* events instead of the generic commit event).
const DOC_DIRS = ['specs', 'standards', 'components', 'audits', 'work-orders'] as const;
const JSONL = ['work-orders.jsonl', 'queue.jsonl', 'feedback.jsonl', 'verifications.jsonl', 'comments.jsonl', 'questions.jsonl'] as const;
const PREVIEW_CHARS = 240;

type Draft = Omit<ActivityEvent, 'id' | 'commit' | 'at' | 'agent' | 'branch' | 'source' | 'user'>;

const trailer = (t: Record<string, string>, key: string) => Object.entries(t).find(([k]) => k.toLowerCase() === key.toLowerCase())?.[1];

/** A short word diff around the changes (equal runs shortened to their edges). */
export function preview(ops: { op: 'equal' | 'insert' | 'delete'; text: string }[]): PreviewOp[] {
  const out: PreviewOp[] = [];
  let len = 0;
  for (let i = 0; i < ops.length && len < PREVIEW_CHARS; i++) {
    const o = ops[i]!;
    let text = o.text;
    if (o.op === 'equal') {
      if (!ops.slice(i + 1).some((x) => x.op !== 'equal')) text = text.length > 40 ? `${text.slice(0, 40)}…` : text;
      else if (i === 0 || out.length === 0) text = text.length > 40 ? `…${text.slice(-40)}` : text;
      else if (text.length > 80) text = `${text.slice(0, 35)} … ${text.slice(-35)}`;
    } else if (text.length > 160) text = `${text.slice(0, 160)}…`;
    out.push({ op: o.op, text });
    len += text.length;
  }
  return out;
}

function parseJsonl(text: string | null): Map<string, Record<string, any>> {
  const out = new Map<string, Record<string, any>>();
  for (const line of (text ?? '').split('\n')) {
    if (!line.trim()) continue;
    try {
      const v = JSON.parse(line);
      if (v && typeof v.id === 'string') out.set(v.id, v);
    } catch {
      // a hand-edited bad line: ignored by the feed
    }
  }
  return out;
}

const changedKeys = (a: Record<string, any>, b: Record<string, any>, ignore: string[] = ['updatedAt']) =>
  [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => !ignore.includes(k) && JSON.stringify(a[k]) !== JSON.stringify(b[k]));

function docEvents(kind: 'specs' | 'standards' | 'components', id: string, before: string | null, after: string | null, who: string): Draft[] {
  const k = kind === 'specs' ? 'spec' : kind === 'standards' ? 'standard' : 'component';
  const uri = buildRef({ kind, id });
  const format = (kind === 'specs' ? specFormat : kind === 'standards' ? standardFormat : componentFormat) as DocFormat<unknown, unknown>;
  let d;
  try {
    d = diffDocs(format, before, after);
  } catch {
    return [{ type: `${k}.updated` as ActivityType, refs: [uri], summary: `${who} edited ${kind}/${id} (file does not parse)` }];
  }
  const fm = (d.after ?? d.before)?.frontmatter as { title?: string; status?: string } | undefined;
  const title = fm?.title ?? id;
  if (d.status === 'added') return [{ type: `${k}.created` as ActivityType, refs: [uri], summary: `${who} created ${k} "${title}"`, details: { title } }];
  if (d.status === 'removed') return [{ type: `${k}.deleted` as ActivityType, refs: [uri], summary: `${who} deleted ${k} "${title}"`, details: { title } }];
  const out: Draft[] = [];
  const status = d.frontmatter.find((c) => c.key === 'status');
  if (status && kind !== 'standards') {
    out.push({
      type: `${k}.status_changed` as ActivityType,
      refs: [uri],
      summary: `${who} moved "${title}" from ${status.before ?? '–'} to ${status.after ?? '–'}`,
      details: { title, status: { from: (status.before as string) ?? null, to: (status.after as string) ?? null } },
    });
  }
  const other = d.frontmatter.filter((c) => c !== status || kind === 'standards').map((c) => c.key);
  if (other.length) out.push({ type: `${k}.updated` as ActivityType, refs: [uri], summary: `${who} updated ${other.join(', ')} of "${title}"`, details: { title, fields: other } });
  for (const s of d.sections) {
    const action = s.status === 'added' ? 'inserted' : s.status === 'removed' ? 'deleted' : s.status === 'modified' ? 'updated' : s.moved ? 'moved' : null;
    if (!action) continue;
    const sec = s.after ?? s.before!;
    const verb = { inserted: 'added', deleted: 'removed', updated: 'edited', moved: 'moved' }[action];
    out.push({
      type: `${k}.section.${action}` as ActivityType,
      refs: [buildRef({ kind, id, sectionId: s.id }), uri],
      summary: `${who} ${verb} section "${sec.title}" in "${title}"`,
      details: {
        title,
        sectionTitle: sec.title,
        ...(s.body ? { preview: preview(s.body.ops) } : {}),
        ...(s.meta.length ? { fields: s.meta.map((m) => m.key) } : {}),
      },
    });
  }
  if (!out.length) out.push({ type: `${k}.updated` as ActivityType, refs: [uri], summary: `${who} touched "${title}" (formatting only)`, details: { title } });
  return out;
}

type AuditSec = { id: string; title: string; type: string; ref?: string; level?: string; result?: string; findings?: { id: string; title: string; severity: string; resolution?: { status?: string; workOrder?: string; feedback?: string }; rechecks?: unknown[] }[] };

/** Audit report commits -> audit.started / item_recorded / completed / abandoned / finding_resolved. */
function auditEvents(id: string, before: string | null, after: string | null, who: string): Draft[] {
  const uri = buildRef({ kind: 'audits', id });
  const parse = (t: string | null) => {
    if (!t) return null;
    try {
      return auditFormat.parse(t) as unknown as { frontmatter: { title?: string; target?: string; status?: string; summary?: string }; sections: AuditSec[] };
    } catch {
      return null;
    }
  };
  const b = parse(before);
  const a = parse(after);
  if (!a) return [];
  const target = a.frontmatter.target ?? '';
  const title = a.frontmatter.title ?? id;
  const base = [uri, ...(target ? [target] : [])];
  if (!b) {
    const items = a.sections.filter((s) => s.type === 'audit-item').length;
    return [{ type: 'audit.started', refs: base, summary: `${who} started ${title} (${items} items)`, details: { title, status: { from: null, to: 'in_progress' }, items } }];
  }
  const out: Draft[] = [];
  for (const s of a.sections) {
    if (s.type !== 'audit-item') continue;
    const was = b.sections.find((x) => x.id === s.id);
    const fids = (x?: AuditSec) => JSON.stringify((x?.findings ?? []).map((f) => [f.id, f.title, f.severity]));
    if (s.result !== 'pending' && (was?.result !== s.result || fids(was) !== fids(s) || (was as { body?: string } | undefined)?.body !== (s as { body?: string }).body)) {
      const n = (s.findings ?? []).length;
      out.push({
        type: 'audit.item_recorded',
        refs: [buildRef({ kind: 'audits', id, sectionId: s.id }), ...base, ...(s.ref ? [s.ref] : [])],
        summary: `${who} recorded ${s.result} for "${s.title}"${n ? ` with ${n} finding${n > 1 ? 's' : ''}` : ''}`,
        details: { title, sectionTitle: s.title, result: s.result, level: s.level, findings: n },
      });
    }
    for (const f of s.findings ?? []) {
      const old = was?.findings?.find((x) => x.id === f.id);
      const st = f.resolution?.status ?? 'open';
      const oldSt = old?.resolution?.status ?? 'open';
      if (old && (st !== oldSt || (f.rechecks?.length ?? 0) > (old.rechecks?.length ?? 0))) {
        out.push({
          type: 'audit.finding_resolved',
          refs: [`${uri}/findings/${f.id}`, ...base],
          summary: st === 'open' ? `${who} re-checked finding "${f.title}": still open` : `${who} marked finding "${f.title}" ${st === 'resolved' ? 'resolved' : "won't fix"}`,
          details: { title, sectionTitle: s.title, severity: f.severity, status: { from: oldSt, to: st } },
        });
      }
    }
  }
  const st = a.frontmatter.status;
  if (st !== b.frontmatter.status && (st === 'completed' || st === 'abandoned')) {
    out.push({
      type: st === 'completed' ? 'audit.completed' : 'audit.abandoned',
      refs: base,
      summary: st === 'completed' ? `${who} completed ${title}${a.frontmatter.summary ? `: ${a.frontmatter.summary}` : ''}` : `${who} abandoned ${title}`,
      details: { title, status: { from: b.frontmatter.status ?? null, to: st } },
    });
  }
  return out;
}

function workOrderEvents(before: Map<string, Record<string, any>>, after: Map<string, Record<string, any>>, who: string): Draft[] {
  const out: Draft[] = [];
  const refsOf = (w: Record<string, any>) => [
    buildRef({ kind: 'work-orders', id: w.id }),
    ...(typeof w.spec === 'string' ? [buildRef({ kind: 'specs', id: w.spec })] : []),
    ...((w.sections ?? []) as { id: string }[]).map((s) => buildRef({ kind: 'specs', id: w.spec, sectionId: s.id })),
  ];
  const progress = (w: Record<string, any>) => {
    const secs = (w.sections ?? []) as { status?: string }[];
    return { done: secs.filter((s) => s.status === 'done').length, total: secs.length };
  };
  const label = (w: Record<string, any>) => `${w.kind ?? 'work order'} ${w.id} on ${w.spec}`;
  for (const [id, a] of after) {
    const b = before.get(id);
    const refs = refsOf(a);
    if (!b) {
      out.push({ type: 'work_order.created', refs, summary: `${who} created ${label(a)}`, details: { kind: a.kind, progress: progress(a), status: { from: null, to: a.status } } });
      continue;
    }
    const keys = changedKeys(b, a);
    if (!keys.length) continue;
    const claimer = a.claim?.agent ?? b.claim?.agent ?? who;
    if (keys.length === 1 && keys[0] === 'claim' && a.claim && b.claim && a.claim.agent === b.claim.agent && changedKeys(b.claim, a.claim, ['heartbeatAt']).length === 0) {
      out.push({ type: 'work_order.heartbeat', heartbeat: true, refs, summary: `${claimer} is still working on ${label(a)}`, details: { kind: a.kind, progress: progress(a) } });
      continue;
    }
    let specific = false;
    if (!b.claim && a.claim) {
      out.push({ type: 'work_order.claimed', refs, summary: `${a.claim.agent} claimed ${label(a)}`, details: { kind: a.kind, progress: progress(a), agent: a.claim.agent, branch: a.claim.branch } });
      specific = true;
    }
    const doneNow = ((a.sections ?? []) as { id: string; status?: string }[]).filter((s) => s.status === 'done' && (b.sections ?? []).find((x: { id: string }) => x.id === s.id)?.status !== 'done');
    for (const s of doneNow) {
      out.push({
        type: 'work_order.section_done',
        refs: [buildRef({ kind: 'specs', id: a.spec, sectionId: s.id }), ...refs.filter((r) => !r.endsWith(`/sections/${s.id}`))],
        summary: `${claimer} finished section ${s.id} of ${label(a)}`,
        details: { kind: a.kind, progress: progress(a), sectionTitle: s.id },
      });
      specific = true;
    }
    if (a.status !== b.status) {
      out.push({
        type: a.status === 'done' ? 'work_order.completed' : 'work_order.status_changed',
        refs,
        summary: a.status === 'done' ? `${claimer} completed ${label(a)}` : `${who} moved ${label(a)} from ${b.status} to ${a.status}`,
        details: { kind: a.kind, progress: progress(a), status: { from: b.status, to: a.status } },
      });
      specific = true;
    }
    if (b.claim && !a.claim && a.status !== 'done') {
      out.push({ type: 'work_order.released', refs, summary: `${b.claim.agent} released ${label(a)}`, details: { kind: a.kind, progress: progress(a) } });
      specific = true;
    }
    // Document fields with their own events (plan, touched, git) or derived ones (claims, completedAt, hasPlan).
    const own = ['claim', 'sections', 'status', 'claims', 'completedAt', 'hasPlan', 'touched', 'git', 'plan'];
    if (a.plan !== b.plan) {
      out.push({ type: 'work_order.plan_set', refs, summary: `${who} ${b.plan ? 'updated' : 'wrote'} the plan of ${label(a)}`, details: { kind: a.kind, progress: progress(a), ...(a.plan ? { preview: [{ op: 'insert' as const, text: String(a.plan).slice(0, 200) }] } : {}) } });
      specific = true;
    }
    if (JSON.stringify(a.touched ?? []) !== JSON.stringify(b.touched ?? [])) {
      const files = ((a.touched ?? []) as { repo: string; path: string }[]).map((t) => `${t.repo}:${t.path}`);
      const before = new Set(((b.touched ?? []) as { repo: string; path: string }[]).map((t) => `${t.repo}:${t.path}`));
      const added = files.filter((f) => !before.has(f));
      out.push({ type: 'work_order.touched', refs, summary: `${who} recorded ${added.length ? `${added.length} new file(s)` : 'changes'} touched by ${label(a)}`, details: { kind: a.kind, files: added.length ? added.slice(0, 20) : files.slice(0, 20) } });
      specific = true;
    }
    if (JSON.stringify(a.git ?? []) !== JSON.stringify(b.git ?? [])) {
      const prs = ((a.git ?? []) as { repo: string; pr?: { number: number; status: string } }[]).filter((g) => g.pr).map((g) => `${g.repo}#${g.pr!.number} ${g.pr!.status}`);
      out.push({ type: 'work_order.git_updated', refs, summary: `${who} updated the git context of ${label(a)}${prs.length ? ` (${prs.join(', ')})` : ''}`, details: { kind: a.kind, git: a.git } });
      specific = true;
    }
    const rest = keys.filter((k) => !own.includes(k));
    if (!specific || rest.length) out.push({ type: 'work_order.updated', refs, summary: `${who} updated ${rest.length ? rest.join(', ') : 'the claim'} of ${label(a)}`, details: { kind: a.kind, progress: progress(a), fields: keys } });
  }
  for (const [id, b] of before) {
    if (!after.has(id)) out.push({ type: 'work_order.deleted', refs: refsOf(b), summary: `${who} deleted ${label(b)}`, details: { kind: b.kind } });
  }
  return out;
}

/** A work-order document as the flat record the work-order events compare (plus its plan text). */
function woFlat(id: string, text: string | null): Record<string, any> | null {
  if (!text) return null;
  try {
    const d = workOrderCodec.decode(text, id);
    const { hasPlan: _h, ...flat } = projectWorkOrder(d);
    // The claim's startedAt is its heartbeat in git (heartbeats are runtime state).
    return { ...flat, ...(flat.claim ? { claim: { ...flat.claim, heartbeatAt: undefined } } : {}), plan: d.sections.find((s) => s.id === 'plan')?.body ?? '' };
  } catch {
    return null;
  }
}

/** comments.jsonl: new comment records -> comment.added; resolve / reopen records -> comment.resolved / reopened. */
function commentEvents(before: Map<string, Record<string, any>>, after: Map<string, Record<string, any>>, who: string): Draft[] {
  const out: Draft[] = [];
  const docOf = (t: string) => t.replace(/\/sections\/.*$/, '');
  for (const [id, c] of after) {
    if (before.has(id)) continue;
    if (c.type === 'resolve' || c.type === 'reopen') {
      const root = after.get(c.commentId) ?? before.get(c.commentId);
      const target = String(root?.target ?? '');
      out.push({
        type: c.type === 'resolve' ? 'comment.resolved' : 'comment.reopened',
        refs: [`mandate://comments/${c.commentId}`, ...(target ? [target, docOf(target)] : [])].filter((x, i, all) => all.indexOf(x) === i),
        summary: `${c.by ?? who} ${c.type === 'resolve' ? 'resolved' : 'reopened'} a comment thread${target ? ` on ${target.replace('mandate://', '')}` : ''}${c.note ? `: ${String(c.note).slice(0, 120)}` : ''}`,
        details: { status: { from: c.type === 'resolve' ? 'open' : 'resolved', to: c.type === 'resolve' ? 'resolved' : 'open' }, ...(c.note ? { note: c.note } : {}) },
      });
      continue;
    }
    const target = String(c.target ?? '');
    out.push({
      type: 'comment.added',
      refs: [`mandate://comments/${id}`, target, docOf(target)].filter((x, i, all) => x && all.indexOf(x) === i),
      summary: `${c.author?.agent ?? who} ${c.parent ? 'replied' : c.blocking ? 'left a blocking comment' : 'commented'} on ${target.replace('mandate://', '')}`,
      details: { preview: [{ op: 'insert' as const, text: String(c.body ?? '').slice(0, 200) }], ...(c.blocking ? { blocking: true } : {}), ...(c.parent ? { parent: c.parent } : {}) },
    });
  }
  return out;
}

/** questions.jsonl: question records -> question.asked; answered / cancelled / superseded events. */
function questionEvents(before: Map<string, Record<string, any>>, after: Map<string, Record<string, any>>, who: string): Draft[] {
  const out: Draft[] = [];
  const header = (q: Record<string, any> | undefined) => String(q?.questions?.[0]?.header ?? 'question');
  for (const [id, r] of after) {
    if (before.has(id)) continue;
    if (typeof r.questionId === 'string') {
      const q = after.get(r.questionId) ?? before.get(r.questionId);
      const refs = [`mandate://questions/${r.questionId}`, ...((q?.context ?? []) as string[])];
      const by = r.by?.user ?? r.by?.agent ?? who;
      if (r.type === 'answered') {
        const text = Object.entries((r.answers ?? {}) as Record<string, unknown>).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : String(v)}`).join('; ');
        out.push({ type: 'question.answered', refs, summary: `${by} answered ${r.questionId} (${header(q)}): ${text.slice(0, 160)}`, details: { header: header(q), answers: r.answers ?? {}, ...(r.notes ? { note: r.notes } : {}), ...(r.via ? { via: r.via } : {}), status: { from: 'open', to: 'answered' } } });
      } else {
        out.push({ type: 'question.cancelled', refs, summary: `${by} ${r.type === 'superseded' ? `superseded ${r.questionId} with ${r.supersededBy}` : `cancelled ${r.questionId}`} (${header(q)})${r.reason ? `: ${String(r.reason).slice(0, 120)}` : ''}`, details: { header: header(q), status: { from: 'open', to: r.type } } });
      }
      continue;
    }
    out.push({
      type: 'question.asked',
      refs: [`mandate://questions/${id}`, ...((r.context ?? []) as string[])],
      summary: `${r.asker?.agent ?? who} asked ${id}${r.blocking ? ' (blocking)' : ''}: ${String(r.questions?.[0]?.question ?? '').slice(0, 140)}`,
      details: { kind: r.purpose, header: header(r), question: String(r.questions?.[0]?.question ?? '').slice(0, 200), ...(r.blocking ? { blocking: true } : {}), status: { from: null, to: 'open' } },
    });
  }
  return out;
}

function feedbackEvents(before: Map<string, Record<string, any>>, after: Map<string, Record<string, any>>, who: string): Draft[] {
  const out: Draft[] = [];
  const refsOf = (f: Record<string, any>) => [buildRef({ kind: 'feedback', id: f.id }), ...((f.targets ?? []) as string[])];
  for (const [id, a] of after) {
    const b = before.get(id);
    if (!b) {
      out.push({ type: 'feedback.created', refs: refsOf(a), summary: `${who} raised ${a.kind ?? 'feedback'} ${id}`, details: { kind: a.kind, status: { from: null, to: a.status ?? 'open' } } });
      continue;
    }
    const keys = changedKeys(b, a);
    if (!keys.length) continue;
    if (a.status === 'closed' && b.status !== 'closed') {
      out.push({ type: 'feedback.closed', refs: refsOf(a), summary: `${who} closed ${id} (${a.resolution ?? 'closed'})`, details: { kind: a.kind, resolution: a.resolution, status: { from: b.status, to: 'closed' } } });
    } else {
      out.push({
        type: 'feedback.updated',
        refs: refsOf(a),
        summary: `${who} updated ${id}${a.status !== b.status ? ` (${b.status} → ${a.status})` : ''}`,
        details: { kind: a.kind, fields: keys, ...(a.status !== b.status ? { status: { from: b.status, to: a.status } } : {}) },
      });
    }
  }
  for (const [id, b] of before) if (!after.has(id)) out.push({ type: 'feedback.deleted', refs: refsOf(b), summary: `${who} deleted feedback ${id}`, details: { kind: b.kind } });
  return out;
}

function verificationEvents(before: Map<string, Record<string, any>>, after: Map<string, Record<string, any>>, who: string): Draft[] {
  const out: Draft[] = [];
  for (const [id, v] of after) {
    if (before.has(id)) continue;
    out.push({
      type: 'verification.recorded',
      refs: [v.criterion, v.appliedTo, `mandate://verifications/${id}`].filter((x): x is string => typeof x === 'string'),
      summary: `${v.by ?? who} recorded ${v.result} for ${String(v.criterion ?? '').replace(/^mandate:\/\//, '')}`,
      details: { result: v.result, kind: v.method, code: v.code },
    });
  }
  return out;
}

/** Every activity event of one commit (diffed against its first parent), in a stable order. */
export async function deriveCommitEvents(git: GitStore, sha: string): Promise<ActivityEvent[]> {
  const info = await git.commitInfo(sha);
  const { subject, trailers } = parseCommitMessage(info.message);
  const agent = trailer(trailers, 'Agent');
  const branch = trailer(trailers, 'Branch');
  const source = trailer(trailers, 'Agent-Key');
  const user = userOfTrailers(trailers);
  const causes = causesOfTrailers(trailers);
  const who = agent ?? info.authorName;
  const diff = await git.commitDiff(sha, [...DOC_DIRS]);
  const drafts: Draft[] = [];
  // The one-time migration (jsonl -> documents) changes no work order: one plain commit event.
  const migration = !!trailer(trailers, MIGRATION_TRAILER);
  const woBefore = new Map<string, Record<string, any>>();
  const woAfter = new Map<string, Record<string, any>>();
  for (const f of diff.files) {
    const w = /^work-orders\/([a-z0-9-]+)\.md$/.exec(f.path);
    if (w) {
      if (migration) continue;
      const before = diff.parent ? await git.readFileAt(diff.parent, f.path) : null;
      const after = await git.readFileAt(sha, f.path);
      const b = woFlat(w[1]!, before);
      const a = woFlat(w[1]!, after);
      if (b) woBefore.set(w[1]!, b);
      if (a) woAfter.set(w[1]!, a);
      continue;
    }
    const m = /^(specs|standards|components|audits)\/([a-z0-9-]+)\.md$/.exec(f.path);
    if (!m) continue;
    const before = diff.parent ? await git.readFileAt(diff.parent, f.path) : null;
    const after = await git.readFileAt(sha, f.path);
    if (m[1] === 'audits') drafts.push(...auditEvents(m[2]!, before, after, who));
    else drafts.push(...docEvents(m[1] as 'specs' | 'standards' | 'components', m[2]!, before, after, who));
  }
  const now = await git.blobsAt(sha, [], [...JSONL]);
  const prev = diff.parent ? await git.blobsAt(diff.parent, [], [...JSONL]) : new Map<string, string>();
  const read = async (blobs: Map<string, string>, commit: string | null, files: string[]) => {
    const f = files.find((x) => blobs.has(x));
    return parseJsonl(f && commit ? await git.readFileAt(commit, f) : null);
  };
  // Work orders: `queue.jsonl` is the pre-rename file (the rename commit itself yields no events).
  const wo = ['work-orders.jsonl', 'queue.jsonl'];
  if (!migration && wo.some((f) => now.get(f) !== prev.get(f))) {
    drafts.push(...workOrderEvents(await read(prev, diff.parent, wo), await read(now, sha, wo), who));
  }
  if (woBefore.size || woAfter.size) drafts.push(...workOrderEvents(woBefore, woAfter, who));
  for (const file of ['feedback.jsonl', 'verifications.jsonl', 'comments.jsonl', 'questions.jsonl']) {
    if (now.get(file) === prev.get(file)) continue;
    const b = await read(prev, diff.parent, [file]);
    const a = await read(now, sha, [file]);
    drafts.push(...(file === 'feedback.jsonl' ? feedbackEvents(b, a, who) : file === 'comments.jsonl' ? commentEvents(b, a, who) : file === 'questions.jsonl' ? questionEvents(b, a, who) : verificationEvents(b, a, who)));
  }
  // An approval override (feedback_accept override: true): recorded prominently as its own event.
  const override = trailer(trailers, 'Approval-Override');
  if (override) {
    const fb = trailer(trailers, 'Feedback-Item');
    drafts.push({ type: 'approval.override', refs: fb ? [buildRef({ kind: 'feedback', id: fb })] : [`mandate://commits/${sha}`], summary: `${who} self-approved${fb ? ` ${fb}` : ''} (override): ${override}`, details: { reason: override } });
  }
  if (!drafts.length) drafts.push({ type: 'commit', refs: [`mandate://commits/${sha}`], summary: `${who}: ${subject}` });
  return drafts.map((d, i) => ({
    id: `${sha}:${i}`,
    commit: sha,
    at: info.date,
    ...(agent ? { agent } : {}),
    ...(branch ? { branch } : {}),
    ...(source ? { source } : {}),
    ...(user ? { user } : {}),
    ...(causes.length ? { causes } : {}),
    ...d,
    details: { ...(d.details ?? {}), subject },
  }));
}

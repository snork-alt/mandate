/**
 * Commit -> activity events. Types come from the commit's trailers and structured diffs: `diffDocs` for specs and
 * standards (section inserted / updated / moved / deleted, status changes), line-by-id diffs for work orders,
 * feedback and verifications. Pure over git reads, so the same commit always yields the same events (cacheable).
 */
import { diffDocs, type DocFormat } from '@mandate/doc';
import { buildRef, type ActivityEvent, type ActivityType, type PreviewOp } from '@mandate/shared';
import type { GitStore } from '../git/GitStore.js';
import { specFormat, standardFormat } from '../storage/codecs.js';
import { parseCommitMessage } from '../storage/history.js';

const DOC_DIRS = ['specs', 'standards'] as const;
const JSONL = ['work-orders.jsonl', 'queue.jsonl', 'feedback.jsonl', 'verifications.jsonl'] as const;
const PREVIEW_CHARS = 240;

type Draft = Omit<ActivityEvent, 'id' | 'commit' | 'at' | 'agent' | 'branch' | 'source'>;

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

function docEvents(kind: 'specs' | 'standards', id: string, before: string | null, after: string | null, who: string): Draft[] {
  const k = kind === 'specs' ? 'spec' : 'standard';
  const uri = buildRef({ kind, id });
  const format = (kind === 'specs' ? specFormat : standardFormat) as DocFormat<unknown, unknown>;
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
  if (status && kind === 'specs') {
    out.push({
      type: 'spec.status_changed',
      refs: [uri],
      summary: `${who} moved "${title}" from ${status.before ?? '–'} to ${status.after ?? '–'}`,
      details: { title, status: { from: (status.before as string) ?? null, to: (status.after as string) ?? null } },
    });
  }
  const other = d.frontmatter.filter((c) => c !== status || kind !== 'specs').map((c) => c.key);
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
    const rest = keys.filter((k) => !['claim', 'sections', 'status'].includes(k));
    if (!specific || rest.length) out.push({ type: 'work_order.updated', refs, summary: `${who} updated ${rest.length ? rest.join(', ') : 'the claim'} of ${label(a)}`, details: { kind: a.kind, progress: progress(a), fields: keys } });
  }
  for (const [id, b] of before) {
    if (!after.has(id)) out.push({ type: 'work_order.deleted', refs: refsOf(b), summary: `${who} deleted ${label(b)}`, details: { kind: b.kind } });
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
  const who = agent ?? info.authorName;
  const diff = await git.commitDiff(sha, [...DOC_DIRS]);
  const drafts: Draft[] = [];
  for (const f of diff.files) {
    const m = /^(specs|standards)\/([a-z0-9-]+)\.md$/.exec(f.path);
    if (!m) continue;
    const before = diff.parent ? await git.readFileAt(diff.parent, f.path) : null;
    const after = await git.readFileAt(sha, f.path);
    drafts.push(...docEvents(m[1] as 'specs' | 'standards', m[2]!, before, after, who));
  }
  const now = await git.blobsAt(sha, [], [...JSONL]);
  const prev = diff.parent ? await git.blobsAt(diff.parent, [], [...JSONL]) : new Map<string, string>();
  const read = async (blobs: Map<string, string>, commit: string | null, files: string[]) => {
    const f = files.find((x) => blobs.has(x));
    return parseJsonl(f && commit ? await git.readFileAt(commit, f) : null);
  };
  // Work orders: `queue.jsonl` is the pre-rename file (the rename commit itself yields no events).
  const wo = ['work-orders.jsonl', 'queue.jsonl'];
  if (wo.some((f) => now.get(f) !== prev.get(f))) {
    drafts.push(...workOrderEvents(await read(prev, diff.parent, wo), await read(now, sha, wo), who));
  }
  for (const file of ['feedback.jsonl', 'verifications.jsonl']) {
    if (now.get(file) === prev.get(file)) continue;
    const b = await read(prev, diff.parent, [file]);
    const a = await read(now, sha, [file]);
    drafts.push(...(file === 'feedback.jsonl' ? feedbackEvents(b, a, who) : verificationEvents(b, a, who)));
  }
  if (!drafts.length) drafts.push({ type: 'commit', refs: [`mandate://commits/${sha}`], summary: `${who}: ${subject}` });
  return drafts.map((d, i) => ({
    id: `${sha}:${i}`,
    commit: sha,
    at: info.date,
    ...(agent ? { agent } : {}),
    ...(branch ? { branch } : {}),
    ...(source ? { source } : {}),
    ...d,
    details: { ...(d.details ?? {}), subject },
  }));
}

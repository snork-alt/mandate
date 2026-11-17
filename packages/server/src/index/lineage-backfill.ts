/**
 * Lineage backfill (one-off): propose lineage annotations for past data-repo commits that changed content without a
 * recorded cause, from evidence in the index and the stored records. Each proposal has a confidence (high / low) and
 * the evidence. Only proposals are computed here; `scripts/lineage-backfill.ts` applies them through the write path
 * (`lineage_annotate` / `LineageAnnotationService`). Also measures cause coverage.
 */
import { buildRef, type StoredFeedback, type WorkOrder } from '@mandate/shared';
import { parseJson, type DB } from './db.js';
import { isMigrationCommit } from './lineage.js';

export interface BackfillProposal {
  /** Full sha of the commit to annotate. */
  commit: string;
  subject: string;
  causes: string[];
  confidence: 'high' | 'low';
  /** Why (one line per piece of evidence). */
  evidence: string[];
  /** What the commit changed (documents). */
  changed: string[];
}

export interface CoverageReport {
  commits: number;
  commitsWithCause: number;
  /** Spec / standard / component content edits (a text change of an existing document). */
  contentEdits: number;
  contentEditsWithCause: number;
  /** Content edits that are not initial authoring (`add <section>`, edits while still a draft, ...) or migrations. */
  contentEditsNeedingCause: number;
  contentEditsNeedingCauseWithCause: number;
}

interface CommitRow {
  sha: string;
  seq: number;
  date: string;
  subject: string;
  body: string;
  trailers: Record<string, string>;
  agent: string | null;
}

interface Changed {
  uri: string;
  action: string;
  kinds: string[];
}

const CONTENT_DOC = /^mandate:\/\/(specs|standards|components)\/[a-z0-9-]+$/;
const CONTENT_ANY = /^mandate:\/\/(specs|standards|components)\//;
/** Initial authoring: legitimately cause-less. */
const AUTHORING = /: (add|draft|create)\b|initial|checklist|acceptance criteria$/i;
const MIGRATION = /migrat|record gate snapshot|rules as rule sections|section-level/i;

function commitsOf(db: DB): CommitRow[] {
  return (db.prepare('SELECT sha, seq, date, subject, body, trailers, agent FROM commits WHERE seq > 0 ORDER BY seq').all() as (Omit<CommitRow, 'trailers'> & { trailers: string })[]).map((r) => ({
    ...r,
    body: r.body ?? '',
    trailers: parseJson<Record<string, string>>(r.trailers, {}),
  }));
}

function changedOf(db: DB): Map<string, Changed[]> {
  const out = new Map<string, Changed[]>();
  const rows = db.prepare("SELECT from_uri, to_uri, props FROM edges WHERE kind = 'changed' AND from_uri LIKE 'mandate://commits/%'").all() as { from_uri: string; to_uri: string; props: string | null }[];
  for (const r of rows) {
    const sha = r.from_uri.slice('mandate://commits/'.length);
    const p = parseJson<{ action?: string; changeKinds?: string[]; merge?: boolean }>(r.props, {});
    if (p.merge) continue;
    const list = out.get(sha) ?? [];
    if (!list.some((x) => x.uri === r.to_uri)) list.push({ uri: r.to_uri, action: p.action ?? 'modified', kinds: p.changeKinds ?? [] });
    out.set(sha, list);
  }
  return out;
}

function causedSet(db: DB): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const rows = db.prepare("SELECT from_uri, to_uri FROM edges WHERE kind = 'caused_by' AND from_uri LIKE 'mandate://commits/%'").all() as { from_uri: string; to_uri: string }[];
  for (const r of rows) {
    const sha = r.from_uri.slice('mandate://commits/'.length);
    out.set(sha, [...(out.get(sha) ?? []), r.to_uri]);
  }
  return out;
}

/** A content edit: a text change of an existing spec / standard / component (not its creation). */
export function isContentEdit(changed: Changed[]): boolean {
  return changed.some((c) => CONTENT_DOC.test(c.uri) && c.action === 'modified' && c.kinds.includes('text'));
}

/** Cause coverage of the indexed history (mainline commits). */
export function lineageCoverage(db: DB): CoverageReport {
  const commits = commitsOf(db);
  const changed = changedOf(db);
  const caused = causedSet(db);
  const r: CoverageReport = { commits: commits.length, commitsWithCause: 0, contentEdits: 0, contentEditsWithCause: 0, contentEditsNeedingCause: 0, contentEditsNeedingCauseWithCause: 0 };
  for (const c of commits) {
    const has = (caused.get(c.sha) ?? []).length > 0;
    if (has) r.commitsWithCause++;
    if (!isContentEdit(changed.get(c.sha) ?? [])) continue;
    r.contentEdits++;
    if (has) r.contentEditsWithCause++;
    if (AUTHORING.test(c.subject) || MIGRATION.test(c.subject) || isMigrationCommit(c.trailers)) continue;
    if (docsOfContent(changed.get(c.sha) ?? []).every((d) => drafting(db, d, c.seq))) continue;
    r.contentEditsNeedingCause++;
    if (has) r.contentEditsNeedingCauseWithCause++;
  }
  return r;
}

const ms = (s: string | undefined | null) => (s ? Date.parse(s) : NaN);
const HOUR = 3600_000;
const docOf = (u: string) => u.split('/sections/')[0]!;

/**
 * Proposals for commits without a recorded cause that edited content (or reopened a spec), plus work orders without
 * an origin. Evidence, strongest first:
 * - the commit message names an existing feedback item / work order created before it (high);
 * - a neighbouring commit (±3, same document, same agent, within an hour) records a cause (high; low otherwise);
 * - a feedback item targeting the changed section was accepted before the commit and closed applied after it, or its
 *   resolution note names the commit (high); targets only the document, or is still open (low);
 * - a work order covering the changed sections was claimed at the time by the commit's agent (high; low otherwise);
 * - work-order creation: feedback targeting a covered section, settled within 3 days before (low).
 */
export function proposeAnnotations(db: DB, data: { feedback: StoredFeedback[]; workOrders: WorkOrder[]; annotated?: Set<string> }): BackfillProposal[] {
  const commits = commitsOf(db);
  const changed = changedOf(db);
  const caused = causedSet(db);
  const fbById = new Map(data.feedback.map((f) => [f.id, f]));
  const woById = new Map(data.workOrders.map((w) => [w.id, w]));
  const out: BackfillProposal[] = [];
  const index = new Map(commits.map((c, i) => [c.sha, i]));
  const statusAt = feedbackTimeline(db);

  for (const c of commits) {
    if ((caused.get(c.sha) ?? []).length || data.annotated?.has(c.sha)) continue;
    const ch = changed.get(c.sha) ?? [];
    const reopen = /reopen/i.test(c.subject) && ch.some((x) => CONTENT_DOC.test(x.uri));
    if (!isContentEdit(ch) && !reopen) continue;
    if (AUTHORING.test(c.subject) || MIGRATION.test(c.subject)) continue;
    if (!reopen && docsOfContent(ch).every((d) => drafting(db, d, c.seq))) continue; // authoring while still a draft
    const when = ms(c.date);
    const docs = [...new Set(ch.filter((x) => CONTENT_ANY.test(x.uri)).map((x) => docOf(x.uri)))];
    const sections = new Set(ch.filter((x) => x.uri.includes('/sections/') && x.action !== 'deleted').map((x) => x.uri));
    const cands = new Map<string, { score: 'high' | 'low'; evidence: string[]; kinds: Set<string> }>();
    // `kind`: independent evidence families; two agreeing families corroborate a cause (high).
    const add = (cause: string, score: 'high' | 'low', ev: string, kind: string) => {
      const cur = cands.get(cause) ?? { score, evidence: [], kinds: new Set<string>() };
      cands.set(cause, cur);
      cur.evidence.push(ev);
      cur.kinds.add(kind);
      if (score === 'high' || cur.kinds.size >= 2) cur.score = 'high';
    };
    const words = stems(`${c.subject} ${c.body}`);

    // 1. The message names a record.
    for (const m of `${c.subject}\n${c.body}`.matchAll(/\b(fb-[0-9a-z]{4,})\b|\b(q-\d{4}|wo-[0-9a-z]{10,})\b/g)) {
      if (m[1] && fbById.has(m[1]) && ms(fbById.get(m[1])!.createdAt) <= when + 1000) add(buildRef({ kind: 'feedback', id: m[1] }), 'high', `commit message names ${m[1]}`, 'message');
      if (m[2] && woById.has(m[2]) && ms(woById.get(m[2])!.createdAt) <= when + 1000) add(buildRef({ kind: 'work-orders', id: m[2] }), 'high', `commit message names ${m[2]}`, 'message');
    }

    // 2. Neighbouring commits on the same document record a cause.
    const i = index.get(c.sha)!;
    for (let j = Math.max(0, i - 3); j <= Math.min(commits.length - 1, i + 3); j++) {
      if (j === i) continue;
      const n = commits[j]!;
      const nch = changed.get(n.sha) ?? [];
      if (!nch.some((x) => docs.includes(docOf(x.uri)))) continue;
      for (const cause of caused.get(n.sha) ?? []) {
        if (docs.includes(docOf(cause))) continue;
        const close = Math.abs(ms(n.date) - when) <= HOUR && !!n.agent && n.agent === c.agent;
        if (Math.abs(ms(n.date) - when) > 3 * 24 * HOUR) continue;
        add(cause, close ? 'high' : 'low', `neighbour ${n.sha.slice(0, 7)} ("${n.subject}") on the same document records it${close ? ' (same agent, within an hour)' : ''}`, 'neighbour');
      }
    }

    // 3. Feedback targeting what changed.
    for (const f of data.feedback) {
      const created = ms(f.createdAt);
      if (!(created <= when + 1000)) continue; // commit dates have second precision
      const targets = (f.targets ?? []) as string[];
      const onSection = targets.some((t) => sections.has(t));
      const onDoc = targets.some((t) => docs.includes(docOf(t)));
      if (!onSection && !onDoc) continue;
      const tl = statusAt.get(f.id) ?? [];
      const closedAt = tl.find((t) => t.status === 'closed')?.at ?? (f.status === 'closed' ? ms(f.updatedAt) : NaN);
      const applied = f.status === 'closed' && (f.resolution ?? 'applied') === 'applied';
      if (f.status === 'closed' && !applied) continue; // rejected / duplicate changed nothing
      const settledBefore = Number.isFinite(closedAt) && closedAt < when;
      if (settledBefore && when - closedAt > 24 * HOUR) continue;
      const accepted = tl.some((t) => t.status === 'accepted' && t.at <= when);
      const note = String((f as { resolutionNote?: string }).resolutionNote ?? '');
      const ref = buildRef({ kind: 'feedback', id: f.id });
      const where = onSection ? [...sections].filter((x) => targets.includes(x)).map((x) => x.replace('mandate://', '')).join(', ') : 'the document';
      if (note.includes(c.sha.slice(0, 7))) add(ref, 'high', `${f.id} resolution note names the commit`, 'resolution');
      if (settledBefore) add(ref, 'low', `${f.id} targets ${where} and was closed applied ${Math.round((when - closedAt) / 60000)} min before the edit`, 'target');
      else add(ref, 'low', `${f.id} targets ${where}, filed before the edit and ${applied ? 'closed applied after it' : `still ${f.status}`}${accepted ? ' (accepted before it)' : ''}`, 'target');
      const shared = sharedStems(words, stems(`${f.body} ${f.quote ?? ''} ${note}`));
      if (shared.length >= 3) add(ref, 'low', `the commit message and ${f.id} share ${shared.join(', ')}`, 'text');
    }
    // Reopen: the feedback that reopened the spec (closed applied right after, on the same document).
    // (covered by 3: a reopen counts like an edit of the targeted section's document)

    // 4. Work orders covering the change, claimed at the time.
    for (const w of data.workOrders) {
      if (!docs.includes(buildRef({ kind: 'specs', id: w.spec }))) continue;
      const covered = w.sections.some((s) => sections.has(buildRef({ kind: 'specs', id: w.spec, sectionId: s.id })));
      const claims = [...((w as { claims?: { agent: string; startedAt?: string; endedAt?: string }[] }).claims ?? []), ...(w.claim ? [{ agent: w.claim.agent, startedAt: (w.claim as { claimedAt?: string }).claimedAt, endedAt: undefined }] : [])];
      const during = claims.find((k) => ms(k.startedAt) <= when && (!k.endedAt || ms(k.endedAt) >= when));
      if (!during || !covered) continue;
      const ref = buildRef({ kind: 'work-orders', id: w.id });
      add(ref, during.agent === c.agent ? 'high' : 'low', `${w.id} covers the changed section and was claimed by ${during.agent} at the time${during.agent === c.agent ? " (the commit's agent)" : ''}`, 'claim');
    }

    if (!cands.size) continue;
    // One proposal per commit: the high causes (if any), else the low ones.
    const high = [...cands].filter(([, v]) => v.score === 'high');
    const pick = high.length ? high : [...cands];
    out.push({
      commit: c.sha,
      subject: c.subject,
      causes: pick.map(([k]) => k),
      confidence: high.length ? 'high' : 'low',
      evidence: pick.flatMap(([k, v]) => v.evidence.map((e) => `${k.replace('mandate://', '')}: ${e}`)),
      changed: docs,
    });
  }

  // 5. Work orders without an origin (no reason / findings / recorded cause).
  for (const w of data.workOrders) {
    const uri = buildRef({ kind: 'work-orders', id: w.id });
    if ((w.reason ?? []).length || ((w as { findings?: string[] }).findings ?? []).length) continue;
    const hasCause = db.prepare("SELECT 1 FROM edges WHERE from_uri = ? AND kind IN ('caused_by', 'acts_on') LIMIT 1").get(uri);
    if (hasCause) continue;
    const createdCommit = db
      .prepare("SELECT c.sha, c.subject, c.date FROM edges e JOIN commits c ON e.from_uri = 'mandate://commits/' || c.sha WHERE e.kind = 'changed' AND e.to_uri = ? AND e.props LIKE '%\"action\":\"created\"%' ORDER BY c.seq LIMIT 1")
      .get(uri) as { sha: string; subject: string; date: string } | undefined;
    if (!createdCommit || data.annotated?.has(createdCommit.sha)) continue;
    const created = ms(w.createdAt);
    const covered = new Set(w.sections.map((s) => buildRef({ kind: 'specs', id: w.spec, sectionId: s.id })));
    for (const f of data.feedback) {
      if (!(f.targets ?? []).some((t: string) => covered.has(t))) continue;
      if (!(ms(f.createdAt) <= created)) continue;
      if (f.status === 'closed' && (f.resolution ?? 'applied') !== 'applied') continue;
      const tl = statusAt.get(f.id) ?? [];
      const settled = tl.filter((t) => t.status === 'accepted' || t.status === 'closed').map((t) => t.at);
      const near = settled.some((t) => Math.abs(created - t) <= 3 * 24 * HOUR) || f.status !== 'closed';
      if (!near) continue;
      const ev: string[] = [`${w.id} covers ${[...covered].filter((x) => (f.targets ?? []).includes(x)).map((x) => x.replace('mandate://', '')).join(', ')} targeted by ${f.id} (${f.status}${f.resolution ? ` ${f.resolution}` : ''}) when it was created`];
      const fbRef = buildRef({ kind: 'feedback', id: f.id });
      const names = `${w.note ?? ''} ${w.title ?? ''}`.includes(f.id);
      if (names) ev.push('the work order names it');
      const shared = sharedStems(stems(`${w.note ?? ''} ${w.title ?? ''}`), stems(`${f.body} ${f.quote ?? ''}`));
      if (shared.length >= 2) ev.push(`its note and ${f.id} share ${shared.join(', ')}${w.note ? ` (note: "${w.note}")` : ''}`);
      const sc = w.specCommit ? commits.find((x) => x.sha === w.specCommit) : undefined;
      const scCauses = sc ? [...(caused.get(sc.sha) ?? []), ...out.filter((p) => p.commit === sc.sha && p.confidence === 'high').flatMap((p) => p.causes)] : [];
      if (sc && scCauses.includes(fbRef)) ev.push(`it targets spec version ${sc.sha.slice(0, 7)} ("${sc.subject}"), whose cause is ${f.id}`);
      out.push({
        commit: createdCommit.sha,
        subject: createdCommit.subject,
        causes: [fbRef],
        confidence: names || ev.length >= 3 ? 'high' : 'low',
        evidence: ev,
        changed: [uri],
      });
    }
  }
  return out;
}

const STOP = new Set(['that', 'this', 'with', 'from', 'must', 'should', 'have', 'when', 'then', 'they', 'their', 'only', 'every', 'spec', 'into', 'were', 'will', 'what', 'which', 'also', 'line', 'after', 'before', 'same', 'other']);
/** Crude stems (first 5 letters of words of 4+ letters) for evidence by shared vocabulary. */
function stems(text: string): Set<string> {
  return new Set((text.toLowerCase().match(/[a-z]{4,}/g) ?? []).filter((w) => !STOP.has(w)).map((w) => w.slice(0, 5)));
}
const sharedStems = (a: Set<string>, b: Set<string>) => [...a].filter((x) => b.has(x));
const docsOfContent = (ch: Changed[]) => [...new Set(ch.filter((x) => CONTENT_ANY.test(x.uri)).map((x) => docOf(x.uri)))];

/** Whether a document was still a draft (never ready / done) at `seq`. */
function drafting(db: DB, doc: string, seq: number): boolean {
  const first = db.prepare("SELECT min(valid_from) AS s FROM nodes WHERE uri = ? AND valid_from > 0 AND json_extract(props, '$.status') IS NOT NULL AND json_extract(props, '$.status') NOT IN ('draft')").get(doc) as { s: number | null } | undefined;
  if (first?.s != null) return seq < first.s;
  // Never left draft: drafting; no status at all (components): not a draft.
  return !!db.prepare("SELECT 1 FROM nodes WHERE uri = ? AND json_extract(props, '$.status') = 'draft' LIMIT 1").get(doc);
}

/** Status changes of each feedback item over history (from the feedback nodes' temporal props). */
function feedbackTimeline(db: DB): Map<string, { status: string; at: number }[]> {
  const out = new Map<string, { status: string; at: number }[]>();
  const rows = db
    .prepare("SELECT n.uri, n.props, c.date FROM nodes n JOIN commits c ON c.seq = n.valid_from WHERE n.kind = 'feedback' AND n.valid_from > 0 ORDER BY n.valid_from")
    .all() as { uri: string; props: string; date: string }[];
  for (const r of rows) {
    const id = r.uri.slice('mandate://requests/'.length);
    const status = parseJson<{ status?: string }>(r.props, {}).status;
    if (!status) continue;
    const list = out.get(id) ?? [];
    if (list.at(-1)?.status !== status) list.push({ status, at: Date.parse(r.date) });
    out.set(id, list);
  }
  return out;
}

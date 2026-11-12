/**
 * Contributors of an element: users from `Mandate-User` / `Agent-User` trailers, else the agent identity
 * (`userRecorded: false`: older agent-only commits).
 * Direct: commits that changed the element or its sections, its comments and its verifications (roles from what the
 * commit did). Indirect ("via"): the direct contributors of its recorded causes (`caused_by`, `depth` hops; a
 * document's causes include its sections' causes), with the cause chain. A user who is both is direct, `alsoVia`.
 */
import { contributorsInputSchema, foldIdentity, userOfTrailers, type Contributor, type ContributorsInput, type ContributorsResponse, type GraphNodeKind } from '@mandate/shared';
import { parseJson } from './db.js';
import { edgesOf, expandCode, labelOf, nodeRow, resolveRef, valid, type GraphContext } from './resolve.js';

interface Acc {
  roles: Set<string>;
  shas: Set<string>;
  lastAt: string;
  /** Commit point of the last contribution (orders same-second commits). */
  lastSeq: number;
  agents: Set<string>;
  /** A user recorded on the commits (false: the agent identity stands in, older agent-only commits). */
  recorded: boolean;
  /** The user login, or the agent name when no user was recorded. */
  name: string;
}

const docOf = (uri: string) => uri.split('/sections/')[0]!;

/** Role of one commit for an element: what it did (created / status change / claim / ...), else edited. */
function roleOf(subject: string, action: string | undefined, kinds: string[], elementKind: string): string {
  const s = subject.toLowerCase();
  if (elementKind === 'comment') return 'commented';
  if (elementKind === 'question') return /\banswered\b/.test(s) ? 'answered' : /\b(cancelled|superseded)\b/.test(s) ? 'closed' : 'asked';
  if (elementKind === 'verification') return 'verified';
  if (/\bclaim/.test(s)) return 'claimed';
  if (/\b(recheck|re-check)/.test(s)) return 'rechecked';
  if (/\bclose|closed\b/.test(s)) return 'closed';
  if (/\baccept/.test(s)) return 'accepted';
  if (/\b(complete|section done|section_done)/.test(s)) return elementKind === 'audit' ? 'audited' : 'completed';
  if (action === 'created') return elementKind === 'feedback' ? 'filed' : elementKind === 'audit' ? 'audited' : 'created';
  if (kinds.length && !kinds.includes('text')) return 'updated';
  return 'edited';
}

type Row = { to_uri: string; props: string | null; sha: string; seq: number; date: string; subject: string; agent: string | null; author: string; trailers: string };
const COLS = 'e.to_uri, e.props, c.sha, c.seq, c.date, c.subject, c.agent, c.author, c.trailers';

/** Commits that changed these nodes (`changed` edges, temporal). */
function changedRows(ctx: GraphContext, uris: string[], seq: number | null): Row[] {
  const out: Row[] = [];
  const v = valid('e', seq);
  for (let i = 0; i < uris.length; i += 400) {
    const chunk = uris.slice(i, i + 400);
    out.push(
      ...(ctx.db
        .prepare(`SELECT ${COLS} FROM edges e JOIN commits c ON e.from_uri = 'mandate://commits/' || c.sha WHERE e.kind = 'changed' AND e.to_uri IN (${chunk.map(() => '?').join(', ')}) AND ${v.sql}`)
        .all(...chunk, ...v.params) as Row[]),
    );
  }
  return out;
}

/** Commit rows by sha (commits, branches, agents). */
function commitRows(ctx: GraphContext, shas: string[], to: string): Row[] {
  const out: Row[] = [];
  for (let i = 0; i < shas.length; i += 400) {
    const chunk = shas.slice(i, i + 400);
    out.push(
      ...(ctx.db.prepare(`SELECT ? AS to_uri, NULL AS props, c.sha, c.seq, c.date, c.subject, c.agent, c.author, c.trailers FROM commits c WHERE c.sha IN (${chunk.map(() => '?').join(', ')})`).all(to, ...chunk) as Row[]),
    );
  }
  return out;
}

const shaOf = (commitUri: string) => commitUri.slice('mandate://commits/'.length);

/**
 * Where an element's contributions are recorded, per node kind: [node uri, role override (null: from the commit),
 * element kind for role naming]. Every node kind resolves (contract test: test/contributors-contract.test.ts).
 */
function sources(ctx: GraphContext, uri: string, kind: string, seq: number | null): { rows: Row[]; role: Map<string, string | null>; kindOf: Map<string, string> } {
  const role = new Map<string, string | null>();
  const kindOf = new Map<string, string>();
  const add = (u: string, k: string, r: string | null = null) => {
    if (!role.has(u)) {
      role.set(u, r);
      kindOf.set(u, k);
    }
  };
  const extraRows: Row[] = [];
  const workOrder = (wo: string, r: string | null) => {
    add(wo, 'work_order', r);
    for (const s of edgesOf(ctx, [wo], 'out', seq, ['has_section'])) add(s.to_uri, 'work_order', r);
  };
  switch (kind) {
    case 'commit':
      extraRows.push(...commitRows(ctx, [shaOf(uri)], uri).map((r) => ({ ...r, subject: `commit ${r.subject}` })));
      role.set(uri, 'committed');
      break;
    case 'branch':
    case 'agent':
    case 'user': {
      const shas = edgesOf(ctx, [uri], 'in', seq, [kind === 'branch' ? 'on_branch' : 'authored_by']).filter((e) => e.from_uri.startsWith('mandate://commits/')).map((e) => shaOf(e.from_uri));
      extraRows.push(...commitRows(ctx, shas.slice(-500), uri));
      role.set(uri, kind === 'branch' || kind === 'user' ? 'committed' : 'used');
      if (kind === 'branch') for (const e of edgesOf(ctx, [uri], 'in', seq, ['on_branch'])) if (e.from_uri.startsWith('mandate://work-orders/')) workOrder(e.from_uri, 'claimed');
      break;
    }
    case 'finding': {
      const item = labelOf(ctx, uri, seq).props.item;
      if (typeof item === 'string') add(item, 'audit', null);
      break;
    }
    case 'code_file':
    case 'code_range':
    case 'repo': {
      const code = (kind === 'repo' ? edgesOf(ctx, [uri], 'in', seq, ['in_repo']).map((e) => e.from_uri).filter((u) => u.startsWith('mandate://code/')).slice(0, 300) : [uri]).flatMap((u) => expandCode(ctx.db, u));
      for (const e of edgesOf(ctx, code, 'in', seq, ['touches'])) workOrder(docOf(e.from_uri), 'touched');
      break;
    }
    case 'pull_request': {
      const wo = labelOf(ctx, uri, seq).props.workOrder;
      if (typeof wo === 'string') workOrder(wo, null);
      break;
    }
    case 'code_commit':
      for (const e of edgesOf(ctx, [uri], 'out', seq, ['implements'])) workOrder(e.to_uri, 'implemented');
      break;
    case 'symbol':
      for (const e of edgesOf(ctx, [uri], 'in', seq, ['mentions_symbol'])) add(e.from_uri, 'section', 'mentioned');
      break;
    case 'architecture':
      for (const e of edgesOf(ctx, [uri], 'out', seq, ['includes'])) add(e.to_uri, 'component', null);
      break;
    default: {
      // Documents and records: the element, its sections, comments on them and verifications of them.
      const own = [uri, ...(uri.includes('/sections/') ? [] : edgesOf(ctx, [uri], 'out', seq, ['has_section']).map((e) => e.to_uri))];
      for (const u of own) add(u, kind, null);
      for (const e of edgesOf(ctx, own, 'in', seq, ['comments_on'])) add(e.from_uri, 'comment', null);
      for (const e of edgesOf(ctx, own, 'in', seq, ['verifies', 'applied_to'])) add(e.from_uri, 'verification', null);
    }
  }
  return { rows: [...changedRows(ctx, [...role.keys()], seq), ...extraRows], role, kindOf };
}

/**
 * Direct contributors of an element, keyed by user; commits without a recorded user fall back to the agent
 * (`userRecorded: false`).
 */
function direct(ctx: GraphContext, uri: string, seq: number | null): Map<string, Acc> {
  const kind = labelOf(ctx, uri, seq).kind;
  const { rows, role: roleFor, kindOf } = sources(ctx, uri, kind, seq);
  const out = new Map<string, Acc>();
  for (const r of rows) {
    const recorded = userOfTrailers(parseJson<Record<string, string>>(r.trailers, {}));
    const who = recorded ?? r.agent ?? r.author;
    if (!who) continue;
    // G-9 / P6: identities compare case-folded, the same key as the user / agent node (`mandate://users/<login>`).
    const key = recorded ? foldIdentity(recorded) : `agent:${foldIdentity(who)}`;
    const p = parseJson<{ action?: string; changeKinds?: string[] }>(r.props, {});
    let a = out.get(key);
    if (!a) out.set(key, (a = { roles: new Set(), shas: new Set(), lastAt: r.date, lastSeq: Math.abs(r.seq), agents: new Set(), recorded: !!recorded, name: who }));
    let role = roleFor.get(r.to_uri) ?? roleOf(r.subject, p.action, p.changeKinds ?? [], kindOf.get(r.to_uri) ?? kind);
    // A status change: name it by the status it set (accepted, closed, done, resolved, ...).
    if (role === 'updated' && p.changeKinds?.includes('status')) {
      const st = parseJson<{ status?: string }>(nodeRow(ctx.db, r.to_uri, Math.abs(r.seq))?.props ?? null, {}).status;
      if (st) role = st;
    }
    a.roles.add(role);
    a.shas.add(r.sha);
    if (r.date > a.lastAt) a.lastAt = r.date;
    if (Math.abs(r.seq) > a.lastSeq) a.lastSeq = Math.abs(r.seq);
    if (r.agent) a.agents.add(r.agent);
  }
  return out;
}

const toContributor = (_key: string, a: Acc, kind: 'direct' | 'via'): Contributor => ({ user: a.name, kind, userRecorded: a.recorded, roles: [...a.roles], count: a.shas.size, lastAt: a.lastAt, agents: [...a.agents] });

/** Contributors of one element. */
export function contributorsOf(ctx: GraphContext, uri: string, seq: number | null, depth: number): Contributor[] {
  const out = new Map<string, Contributor>();
  const order = new Map<Contributor, number>();
  for (const [user, a] of direct(ctx, uri, seq)) {
    const c = toContributor(user, a, 'direct');
    out.set(user, c);
    order.set(c, a.lastSeq);
  }
  // Causes, breadth first: the element (and its sections) -> caused_by -> causes (and their sections) ...
  type Hop = { uri: string; chain: { uri: string; kind: GraphNodeKind; label: string }[] };
  const seen = new Set([uri]);
  let frontier: Hop[] = [{ uri, chain: [] }];
  for (let d = 1; d <= depth && frontier.length; d++) {
    const next: Hop[] = [];
    for (const h of frontier) {
      const from = [h.uri, ...(h.uri.includes('/sections/') ? [] : edgesOf(ctx, [h.uri], 'out', seq, ['has_section']).map((e) => e.to_uri))];
      for (const e of edgesOf(ctx, from, 'out', seq, ['caused_by', 'acts_on'])) {
        const cause = e.to_uri;
        if (seen.has(cause) || seen.has(docOf(cause))) continue;
        seen.add(cause);
        const n = labelOf(ctx, cause, seq);
        const chain = [...h.chain, { uri: cause, kind: n.kind, label: n.label }];
        next.push({ uri: cause, chain });
        for (const [user, a] of direct(ctx, cause, seq)) {
          const have = out.get(user);
          if (have?.kind === 'direct') {
            have.alsoVia = [...(have.alsoVia ?? []), ...chain.slice(-1)];
            continue;
          }
          if (have) {
            // Already indirect through a nearer cause: count the contributions, keep the nearest chain.
            have.count += a.shas.size;
            for (const r of a.roles) if (!have.roles.includes(r)) have.roles.push(r);
            if (a.lastAt > have.lastAt) have.lastAt = a.lastAt;
            continue;
          }
          const c = { ...toContributor(user, a, 'via'), via: chain };
          out.set(user, c);
          order.set(c, a.lastSeq);
        }
      }
    }
    frontier = next;
  }
  return [...out.values()].sort((x, y) => (x.kind === y.kind ? y.lastAt.localeCompare(x.lastAt) || (order.get(y) ?? 0) - (order.get(x) ?? 0) : x.kind === 'direct' ? -1 : 1));
}

export async function contributors(ctx: GraphContext, input: ContributorsInput): Promise<ContributorsResponse> {
  const inp = contributorsInputSchema.parse(input);
  const res: ContributorsResponse['contributors'] = {};
  for (const ref of inp.refs) {
    const r = await resolveRef(ctx, ref, inp.at);
    const uri = r.live[0] ?? r.node.uri;
    res[r.node.uri] = contributorsOf(ctx, uri, r.seq, inp.depth);
  }
  return { contributors: res };
}

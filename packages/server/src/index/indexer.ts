import { diffDocs, diffText, type DocFormat } from '@mandate/doc';
import { buildNodeUri, buildRef, matchingAppliesTo, parseRef, type ChangeKind, type IndexStatus, type StoredComponent, type StoredSpec, type StoredStandard } from '@mandate/shared';
import type { GitStore } from '../git/GitStore.js';
import { parseCommitMessage } from '../storage/history.js';
import { clearDerived, json, parseJson, type DB } from './db.js';
import { enqueueHashes, forgetHashes, PRIORITY, type EmbedTarget } from './embed/jobs.js';
import { componentEdges, ruleEdges } from './rules.js';
import { specComponents, standardInForce, type Model } from '../storage/model.js';
import { componentCodec, specCodec, standardCodec } from '../storage/codecs.js';
import { DOC_FILE_RE, extractFile, type DocDir, type EdgeRow, type ExtractContext, type FileRecords, type NodeRow } from './extract.js';

/** Repo content the index reads. */
export const INDEX_DIRS = ['specs', 'standards', 'components'];
export const INDEX_FILES = ['work-orders.jsonl', 'queue.jsonl', 'feedback.jsonl', 'verifications.jsonl'];
/** Older names of indexed files: the same logical file (work orders were the "queue" before). */
const FILE_ALIASES: Record<string, string> = { 'queue.jsonl': 'work-orders.jsonl' };
const logicalPath = (p: string) => FILE_ALIASES[p] ?? p;
/** Physical paths that may hold a logical file. */
const physicalPaths = (p: string) => [p, ...Object.entries(FILE_ALIASES).filter(([, v]) => v === p).map(([k]) => k)];

/** Blob ids keyed by logical path (a renamed file keeps its key, so `git mv` is not a change). */
async function logicalBlobs(git: GitStore, commit: string): Promise<Map<string, string>> {
  const raw = await git.blobsAt(commit, INDEX_DIRS, INDEX_FILES);
  const out = new Map<string, string>();
  for (const [p, b] of raw) if (!FILE_ALIASES[p] || !raw.has(FILE_ALIASES[p]!)) out.set(logicalPath(p), b);
  return out;
}

async function readLogical(git: GitStore, commit: string, p: string): Promise<string | null> {
  for (const phys of physicalPaths(p)) {
    const t = await git.readFileAt(commit, phys);
    if (t !== null) return t;
  }
  return null;
}

export interface ChangeEvent {
  uri: string;
  action: 'created' | 'modified' | 'deleted' | 'renamed';
  changeKinds: ChangeKind[];
  linesAdded: number;
  linesRemoved: number;
  props?: Record<string, unknown>;
}

export interface SyncResult {
  head: string | null;
  headSeq: number;
  commitsIndexed: number;
  filesReindexed: number;
  rebuilt: boolean;
  errors: string[];
}


const countLines = (ops: { op: string; text: string }[], op: 'insert' | 'delete') =>
  ops.filter((o) => o.op === op).reduce((n, o) => n + o.text.split('\n').filter((l, i, a) => l !== '' || i < a.length - 1).length, 0);

function lineStats(before: string, after: string) {
  const ops = diffText(before, after, 'lines');
  return { linesAdded: countLines(ops, 'insert'), linesRemoved: countLines(ops, 'delete') };
}

/**
 * Builds and incrementally updates the index from git. History is replayed commit by commit along the
 * first-parent chain: nodes and edges get `valid_from` / `valid_to` commit seqs (closed, never deleted),
 * commits become nodes with `changed` edges. Current-state tables (docs, sections, chunks, FTS) mirror HEAD.
 */
export class Indexer {
  private readonly graphCtx: ExtractContext;
  constructor(
    private readonly db: DB,
    private readonly git: GitStore,
    private readonly ctx: ExtractContext,
    /** Embedding outbox: chunk writes enqueue jobs for this model in the same transaction (null: semantic search off). */
    private readonly embed: EmbedTarget | null = null,
  ) {
    this.graphCtx = { ...ctx, graphOnly: true };
  }

  state(): { head: string | null; seq: number; lastSyncAt: string | null; lastError: string | null } {
    const r = this.db.prepare('SELECT head_commit, head_seq, last_sync_at, last_error FROM index_state WHERE id = 1').get() as {
      head_commit: string | null;
      head_seq: number;
      last_sync_at: string | null;
      last_error: string | null;
    };
    return { head: r.head_commit, seq: r.head_seq, lastSyncAt: r.last_sync_at, lastError: r.last_error };
  }

  /** The last detected history rewrite (kept across rebuilds), with the pins that no longer resolve. */
  historyRewrite(): IndexStatus['historyRewrite'] {
    const r = this.db.prepare('SELECT history_rewrite AS h FROM index_state WHERE id = 1').get() as { h: string | null };
    return r.h ? parseJson(r.h, null) : null;
  }

  /** Wipe derived tables and replay all of history (the embedding cache is kept). */
  async rebuild(): Promise<SyncResult> {
    clearDerived(this.db);
    return this.sync();
  }

  /** All parents of a commit (first parent first), recovered from first-parent diffs and reachability. */
  private readonly parentCache = new Map<string, string[]>();
  async parentsOf(c: string): Promise<string[]> {
    const hit = this.parentCache.get(c);
    if (hit) return hit;
    const fp = (await this.git.commitDiff(c, [])).parent;
    let out: string[] = [];
    if (fp) {
      // Commits brought in by the other parents: reachable from c, not from its first parent.
      const merged = (await this.git.reachable(c, fp)).filter((x) => x !== c);
      const inner = new Set<string>();
      for (const m of merged) for (const p of await this.parentsOf(m)) inner.add(p);
      out = [fp, ...merged.filter((m) => !inner.has(m))];
    }
    this.parentCache.set(c, out);
    return out;
  }

  /** Is `a` an ancestor of (or equal to) `b`? */
  private async isAncestor(a: string, b: string): Promise<boolean> {
    return (await this.git.reachable(a, b)).length === 0;
  }

  /**
   * Index commits since the last indexed HEAD. New first-parent commits extend the interval tables; the commits a merge brings
   * in are indexed one by one (own changes, trailers and a snapshot of their state). A HEAD whose first-parent chain no longer
   * contains the indexed head is replayed from scratch (internal points renumber; shas are the only public coordinate).
   * A HEAD that does not descend from the indexed head at all is a history rewrite: rebuilt, recorded, pins to dropped commits lost.
   * `priority`: of the embedding jobs for new chunk texts (PRIORITY.write for fresh writes; a full replay uses backfill).
   */
  async sync(opts: { priority?: number } = {}): Promise<SyncResult> {
    const errors: string[] = [];
    let state = this.state();
    const head = await this.git.head();
    const result: SyncResult = { head, headSeq: state.seq, commitsIndexed: 0, filesReindexed: 0, rebuilt: false, errors };
    if (!head || head === state.head) return result;

    let rewrite: { oldHead: string; newHead: string; detectedAt: string; oldCommits: string[] } | null = null;
    if (state.head && !(await this.git.resolveCommit(state.head).catch(() => null)) ) {
      rewrite = { oldHead: state.head, newHead: head, detectedAt: new Date().toISOString(), oldCommits: [] };
    } else if (state.head && !(await this.isAncestor(state.head, head))) {
      rewrite = { oldHead: state.head, newHead: head, detectedAt: new Date().toISOString(), oldCommits: [] };
    }
    let { commits, reachedStop } = await this.git.firstParentChain(state.head);
    if (rewrite || !reachedStop) {
      if (rewrite) rewrite.oldCommits = (this.db.prepare('SELECT sha FROM commits').all() as { sha: string }[]).map((r) => r.sha);
      clearDerived(this.db);
      state = this.state();
      result.rebuilt = true;
      ({ commits } = await this.git.firstParentChain(null));
    }
    commits.reverse();

    let prev = state.head;
    let ord = state.seq;
    let prevBlobs = prev ? await logicalBlobs(this.git, prev) : new Map<string, string>();
    const texts = new Map<string, string>(); // path -> text at `prev`
    const textAt = async (commit: string | null, p: string, blobs: Map<string, string>) => {
      if (!commit || !blobs.has(p)) return null;
      return readLogical(this.git, commit, p);
    };
    // Decoded specs and standards at the current point (rule edges need the whole model).
    const model = this.loadModel();

    for (const sha of commits) {
      // Commits merged in by this one, oldest first (topological).
      const side = prev ? (await this.git.reachable(sha, prev)).filter((c) => c !== sha) : [];
      const ordered = await this.topoSort(side);
      const mergePoint = ord + ordered.length + 1; // this commit's point: side facts become visible there
      for (const c of ordered) {
        ord++;
        await this.indexSideCommit(c, -ord, mergePoint, errors);
        result.commitsIndexed++;
      }
      const seq = ++ord;
      const blobs = await logicalBlobs(this.git, sha);
      const changed = [...new Set([...blobs.keys(), ...prevBlobs.keys()])].filter((p) => blobs.get(p) !== prevBlobs.get(p)).sort();
      const before = new Map<string, string | null>();
      const after = new Map<string, string | null>();
      for (const p of changed) {
        before.set(p, texts.has(p) ? texts.get(p)! : await textAt(prev, p, prevBlobs));
        after.set(p, await textAt(sha, p, blobs));
      }
      const info = await this.git.commitInfo(sha);
      const parents = prev ? await this.parentsOf(sha) : [];
      const renames = detectRenames(changed, prevBlobs, blobs);

      const records = new Map<string, FileRecords | null>();
      const events: ChangeEvent[] = [];
      for (const p of changed) {
        const a = after.get(p) ?? null;
        const rec = a === null ? null : extractFile(p, a, this.graphCtx);
        records.set(p, rec);
        if (rec) errors.push(...rec.errors.map((e) => `${sha.slice(0, 7)} ${e}`));
        events.push(...this.changeEvents(p, before.get(p) ?? null, a, renames.get(p)));
      }
      // A merge's own diff repeats what its side branch did: mark those events.
      if (parents.length > 1) for (const e of events) e.props = { ...e.props, merge: true };

      this.db.transaction(() => {
        this.writeCommit(info, seq, parents, true, events);
        for (const [p, rec] of records) {
          this.applyTemporal(p, rec?.nodes ?? [], (rec?.edges ?? []).map((e) => this.resolveCommitEdge(e)), seq);
        }
        if (changed.some((p) => DOC_FILE_RE.test(p))) {
          for (const p of changed) updateModel(model, p, after.get(p) ?? null);
          const m = modelOf(model);
          this.applyTemporal('applies', [], appliesEdges(m), seq);
          this.applyTemporal('rules', [], [...ruleEdges(m), ...componentEdges(m)], seq);
        }
        this.writeVersions(events, sha, seq, parents[0] ?? null);
        this.db.prepare('UPDATE index_state SET head_commit = ?, head_seq = ? WHERE id = 1').run(sha, seq);
      })();

      for (const p of changed) texts.set(p, after.get(p) ?? '');
      for (const p of changed) if (after.get(p) === null) texts.delete(p);
      prev = sha;
      prevBlobs = blobs;
      result.commitsIndexed++;
    }

    result.filesReindexed = await this.updateCurrent(head, prevBlobs, texts, result.rebuilt ? PRIORITY.backfill : (opts.priority ?? PRIORITY.backfill));
    if (rewrite) this.recordRewrite(rewrite, errors);
    this.db
      .prepare('UPDATE index_state SET head_commit = ?, head_seq = ?, last_sync_at = ?, last_error = ? WHERE id = 1')
      .run(head, ord, new Date().toISOString(), errors.length ? errors.slice(-5).join('\n') : null);
    result.headSeq = ord;
    return result;
  }

  /** Order commits so that parents come before children (within the set); ties keep git's order reversed. */
  private async topoSort(commits: string[]): Promise<string[]> {
    const set = new Set(commits);
    const parents = new Map<string, string[]>();
    for (const c of commits) parents.set(c, (await this.parentsOf(c)).filter((p) => set.has(p)));
    const out: string[] = [];
    const done = new Set<string>();
    const visit = (c: string) => {
      if (done.has(c)) return;
      done.add(c);
      for (const p of parents.get(c) ?? []) visit(p);
      out.push(c);
    };
    for (const c of [...commits].reverse()) visit(c);
    return out;
  }

  /**
   * A commit that is not on the first-parent chain: its own changes (against its first parent), trailers and versions,
   * plus a snapshot of the whole graph at its tree, valid only at its own point.
   */
  private async indexSideCommit(sha: string, point: number, book: number, errors: string[]): Promise<void> {
    const parents = await this.parentsOf(sha);
    const fp = parents[0] ?? null;
    const blobs = await logicalBlobs(this.git, sha);
    const fpBlobs = fp ? await logicalBlobs(this.git, fp) : new Map<string, string>();
    const changed = [...new Set([...blobs.keys(), ...fpBlobs.keys()])].filter((p) => blobs.get(p) !== fpBlobs.get(p)).sort();
    const renames = detectRenames(changed, fpBlobs, blobs);
    const events: ChangeEvent[] = [];
    for (const p of changed) {
      const before = fp && fpBlobs.has(p) ? await readLogical(this.git, fp, p) : null;
      const after = blobs.has(p) ? await readLogical(this.git, sha, p) : null;
      events.push(...this.changeEvents(p, before, after, renames.get(p)));
    }
    // Snapshot: every file at this commit.
    const nodes: NodeRow[] = [];
    const edges: EdgeRow[] = [];
    const snapModel: DocModel = { specs: new Map(), standards: new Map(), components: new Map() };
    for (const p of blobs.keys()) {
      const text = await readLogical(this.git, sha, p);
      if (text === null) continue;
      const rec = extractFile(p, text, this.graphCtx);
      errors.push(...rec.errors.map((e) => `${sha.slice(0, 7)} ${e}`));
      nodes.push(...rec.nodes);
      edges.push(...rec.edges.map((e) => this.resolveCommitEdge(e)));
      updateModel(snapModel, p, text);
    }
    const sm = modelOf(snapModel);
    edges.push(...appliesEdges(sm), ...ruleEdges(sm), ...componentEdges(sm));
    const info = await this.git.commitInfo(sha);
    this.db.transaction(() => {
      this.writeCommit(info, point, parents, false, events, book);
      const insNode = this.db.prepare("INSERT OR IGNORE INTO nodes (uri, kind, label, props, source, valid_from, valid_to) VALUES (?, ?, ?, ?, 'snapshot', ?, ?)");
      for (const n of nodes) insNode.run(n.uri, n.kind, n.label, json(n.props), point, point + 1);
      const insEdge = this.db.prepare("INSERT INTO edges (from_uri, to_uri, kind, props, source, valid_from, valid_to) VALUES (?, ?, ?, ?, 'snapshot', ?, ?)");
      const seen = new Set<string>();
      for (const e of edges) {
        const k = `${e.from}|${e.to}|${e.kind}|${e.props ? json(e.props) : ''}`;
        if (seen.has(k)) continue;
        seen.add(k);
        insEdge.run(e.from, e.to, e.kind, e.props ? json(e.props) : null, point, point + 1);
      }
      this.writeVersions(events, sha, point, fp, book);
    })();
  }

  /** Record a detected rewrite: which commits disappeared and which stored pins no longer resolve. */
  private recordRewrite(r: { oldHead: string; newHead: string; detectedAt: string; oldCommits: string[] }, errors: string[]): void {
    const now = new Set((this.db.prepare('SELECT sha FROM commits').all() as { sha: string }[]).map((x) => x.sha));
    const lost = r.oldCommits.filter((c) => !now.has(c));
    const ins = this.db.prepare('INSERT OR REPLACE INTO lost_commits (sha, lost_at, rewrite_new_head) VALUES (?, ?, ?)');
    this.db.transaction(() => {
      for (const c of lost) ins.run(c, r.detectedAt, r.newHead);
      this.db.prepare('DELETE FROM lost_commits WHERE sha IN (SELECT sha FROM commits)').run();
    })();
    const info = { detectedAt: r.detectedAt, oldHead: r.oldHead, newHead: r.newHead, lostCommits: lost.length, lostPins: lostPins(this.db) };
    this.db.prepare('UPDATE index_state SET history_rewrite = ? WHERE id = 1').run(json(info));
    errors.push(`history rewritten: ${r.oldHead.slice(0, 7)} is not an ancestor of ${r.newHead.slice(0, 7)}; ${lost.length} commit(s) dropped, ${info.lostPins.length} pin(s) lost; index rebuilt`);
  }

  /** `verified_at` edges name short shas; point them at the full commit node when known. */
  private resolveCommitEdge(e: EdgeRow): EdgeRow {
    if (e.kind !== 'verified_at') return e;
    const short = e.to.slice('mandate://commits/'.length);
    if (short.length === 40) return e;
    const row = this.db.prepare("SELECT sha FROM commits WHERE sha LIKE ? || '%' LIMIT 2").all(short) as { sha: string }[];
    return row.length === 1 ? { ...e, to: buildNodeUri({ kind: 'commits', sha: row[0]!.sha }) } : e;
  }

  /** Decoded specs and standards of the current projection (the files table holds the indexed head's texts). */
  private loadModel(): DocModel {
    const m: DocModel = { specs: new Map(), standards: new Map(), components: new Map() };
    for (const r of this.db.prepare("SELECT path, text FROM files WHERE path LIKE 'specs/%' OR path LIKE 'standards/%' OR path LIKE 'components/%'").all() as { path: string; text: string }[]) updateModel(m, r.path, r.text);
    return m;
  }

  /** Close rows of `source` that are gone or changed and open new ones (nodes and edges). */
  private applyTemporal(source: string, nodes: NodeRow[], edges: EdgeRow[], seq: number): void {
    const db = this.db;
    // Owned nodes.
    const owned = new Map(nodes.filter((n) => n.owned).map((n) => [n.uri, n]));
    const open = db.prepare('SELECT uri, label, props FROM nodes WHERE source = ? AND valid_to IS NULL').all(source) as { uri: string; label: string; props: string }[];
    const close = db.prepare('UPDATE nodes SET valid_to = ? WHERE uri = ? AND source = ? AND valid_to IS NULL');
    const insert = db.prepare('INSERT OR REPLACE INTO nodes (uri, kind, label, props, source, valid_from, valid_to) VALUES (?, ?, ?, ?, ?, ?, NULL)');
    const keep = new Set<string>();
    for (const o of open) {
      const n = owned.get(o.uri);
      if (n && n.label === o.label && json(n.props) === o.props) keep.add(o.uri);
      else close.run(seq, o.uri, source);
    }
    for (const n of owned.values()) if (!keep.has(n.uri)) insert.run(n.uri, n.kind, n.label, json(n.props), source, seq);
    // Shared nodes (symbols, code, repos): created once, kept.
    const shared = db.prepare('INSERT INTO nodes (uri, kind, label, props, source, valid_from, valid_to) SELECT ?, ?, ?, ?, NULL, ?, NULL WHERE NOT EXISTS (SELECT 1 FROM nodes WHERE uri = ?)');
    for (const n of nodes) if (!n.owned) shared.run(n.uri, n.kind, n.label, json(n.props), seq, n.uri);

    // Edges, identified by from/to/kind/props.
    const key = (e: { from: string; to: string; kind: string; props?: unknown }) => `${e.from}\u0000${e.to}\u0000${e.kind}\u0000${e.props ? json(e.props) : ''}`;
    const want = new Map(edges.map((e) => [key(e), e]));
    const openEdges = db.prepare('SELECT id, from_uri, to_uri, kind, props FROM edges WHERE source = ? AND valid_to IS NULL').all(source) as {
      id: number;
      from_uri: string;
      to_uri: string;
      kind: string;
      props: string | null;
    }[];
    const closeEdge = db.prepare('UPDATE edges SET valid_to = ? WHERE id = ?');
    for (const e of openEdges) {
      const k = `${e.from_uri}\u0000${e.to_uri}\u0000${e.kind}\u0000${e.props ?? ''}`;
      if (want.has(k)) want.delete(k);
      else closeEdge.run(seq, e.id);
    }
    const insEdge = db.prepare('INSERT INTO edges (from_uri, to_uri, kind, props, source, valid_from) VALUES (?, ?, ?, ?, ?, ?)');
    for (const e of want.values()) insEdge.run(e.from, e.to, e.kind, e.props ? json(e.props) : null, source, seq);
  }

  /** What a commit changed in one file: doc + section events (via diffDocs) or queue / feedback items. */
  private changeEvents(path: string, before: string | null, after: string | null, renamedFrom?: string): ChangeEvent[] {
    const m = DOC_FILE_RE.exec(path);
    if (m) {
      const dir = m[1] as DocDir;
      const docUri = buildRef({ kind: dir, id: m[2]! });
      const action: ChangeEvent['action'] = renamedFrom ? 'renamed' : !before ? 'created' : !after ? 'deleted' : 'modified';
      const out: ChangeEvent[] = [];
      const kinds = new Set<ChangeKind>();
      try {
        const d = diffDocs(this.ctx.formats[dir] as DocFormat<unknown, unknown>, before, after);
        for (const s of d.sections) {
          const summaryChanged = (s.before?.summary ?? null) !== (s.after?.summary ?? null);
          if (s.status === 'unchanged' && !summaryChanged && !s.moved) continue;
          const sk = new Set<ChangeKind>();
          if (s.status === 'added' || s.status === 'removed' || s.title || s.body || summaryChanged) sk.add('text');
          if (s.meta.length || s.moved) sk.add('metadata');
          sk.forEach((k) => kinds.add(k));
          out.push({
            uri: buildRef({ kind: dir, id: m[2]!, sectionId: s.id }),
            action: s.status === 'added' ? 'created' : s.status === 'removed' ? 'deleted' : 'modified',
            changeKinds: [...sk],
            ...lineStats(s.before?.body ?? '', s.after?.body ?? ''),
          });
        }
        for (const c of d.frontmatter) kinds.add(c.key === 'status' ? 'status' : c.key === 'title' || c.key === 'summary' ? 'text' : 'metadata');
      } catch {
        kinds.add('text');
      }
      if (!before || !after) kinds.add('text');
      out.unshift({
        uri: docUri,
        action,
        changeKinds: [...kinds],
        ...lineStats(before ?? '', after ?? ''),
        ...(renamedFrom ? { props: { renamedFrom } } : {}),
      });
      return out;
    }
    if (path === 'work-orders.jsonl' || path === 'feedback.jsonl' || path === 'verifications.jsonl') {
      const kind = path === 'work-orders.jsonl' ? 'work-orders' : path === 'feedback.jsonl' ? 'feedback' : 'verifications';
      const itemUri = (id: string) => (kind === 'verifications' ? buildNodeUri({ kind, id }) : buildRef({ kind, id }));
      const items = (t: string | null) => {
        const map = new Map<string, Record<string, unknown>>();
        for (const l of (t ?? '').split('\n')) {
          try {
            const o = JSON.parse(l) as Record<string, unknown>;
            if (typeof o.id === 'string') map.set(o.id, o);
          } catch {
            /* skip */
          }
        }
        return map;
      };
      const b = items(before);
      const a = items(after);
      const out: ChangeEvent[] = [];
      for (const id of new Set([...b.keys(), ...a.keys()])) {
        const x = b.get(id);
        const y = a.get(id);
        if (JSON.stringify(x) === JSON.stringify(y)) continue;
        const kinds = new Set<ChangeKind>();
        if (!x || !y) kinds.add('text');
        else {
          if (x.status !== y.status) kinds.add('status');
          for (const k of ['body', 'note', 'quote', 'resolutionNote']) if (JSON.stringify(x[k]) !== JSON.stringify(y[k])) kinds.add('text');
          const rest = (o: Record<string, unknown>) => JSON.stringify({ ...o, status: 0, body: 0, note: 0, quote: 0, resolutionNote: 0, updatedAt: 0 });
          if (rest(x) !== rest(y)) kinds.add('metadata');
        }
        out.push({ uri: itemUri(id), action: !x ? 'created' : !y ? 'deleted' : 'modified', changeKinds: [...kinds], linesAdded: y ? 1 : 0, linesRemoved: x ? 1 : 0 });
      }
      return out;
    }
    return [];
  }

  /**
   * Version nodes (`mandate://specs/x@sha`, `.../sections/y` at sha) for each doc or section a commit changed,
   * with `version_of` (-> live node), `created_in` (-> commit) and `previous_version` (-> the version current at the
   * commit's first parent). A version's other edges are not copied: they are the live node's edges at its point.
   * `book` is the point from which these facts are visible (a side-branch commit's merge).
   */
  private writeVersions(events: ChangeEvent[], sha: string, point: number, firstParent: string | null, book = point): void {
    const db = this.db;
    const label = db.prepare('SELECT label FROM nodes WHERE uri = ? ORDER BY valid_from DESC LIMIT 1');
    const node = db.prepare("INSERT OR IGNORE INTO nodes (uri, kind, label, props, source, valid_from) VALUES (?, 'version', ?, ?, 'versions', ?)");
    const edge = db.prepare("INSERT INTO edges (from_uri, to_uri, kind, props, source, valid_from) VALUES (?, ?, ?, NULL, 'versions', ?)");
    const ver = db.prepare('INSERT OR IGNORE INTO versions (of_uri, sha, uri, point) VALUES (?, ?, ?, ?)');
    const commitUri = buildNodeUri({ kind: 'commits', sha });
    for (const e of events) {
      const ref = parseRef(e.uri);
      if (!ref || (ref.kind !== 'specs' && ref.kind !== 'standards' && ref.kind !== 'components')) continue;
      const uri = buildRef({ kind: ref.kind, id: ref.id, sectionId: ref.sectionId, commit: sha });
      // The version current at this commit before it: nearest among all parents' ancestry (merges see their side branch).
      const prev = firstParent ? versionBefore(db, e.uri, sha) : null;
      const l = (label.get(e.uri) as { label: string } | undefined)?.label ?? e.uri;
      node.run(uri, `${l} @ ${sha.slice(0, 7)}`, json({ of: e.uri, sha, action: e.action, changeKinds: e.changeKinds }), book);
      ver.run(e.uri, sha, uri, point);
      edge.run(uri, e.uri, 'version_of', book);
      edge.run(uri, commitUri, 'created_in', book);
      if (prev) edge.run(uri, prev, 'previous_version', book);
    }
  }

  /** Commit row, node and edges; every parent is recorded. `book`: point from which the facts are visible. */
  private writeCommit(
    info: { id: string; message: string; authorName: string; authorEmail: string; date: string },
    point: number,
    parents: string[],
    mainline: boolean,
    events: ChangeEvent[],
    book = point,
  ): void {
    const db = this.db;
    if (db.prepare('SELECT 1 FROM commits WHERE sha = ?').get(info.id)) return;
    const { subject, body, trailers } = parseCommitMessage(info.message);
    const find = (k: string) => Object.entries(trailers).find(([key]) => key.toLowerCase() === k)?.[1];
    const agent = find('agent');
    const branch = find('branch');
    const kinds = [...new Set(events.flatMap((e) => e.changeKinds))];
    const uris = events.map((e) => e.uri);
    db.prepare(
      'INSERT INTO commits (sha, seq, parent_sha, mainline, subject, body, author, email, date, trailers, agent, branch, kinds, uris) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(info.id, point, parents[0] ?? null, mainline ? 1 : 0, subject, body, info.authorName, info.authorEmail, info.date, json(trailers), agent ?? null, branch ?? null, json(kinds), json(uris));
    const cp = db.prepare('INSERT OR IGNORE INTO commit_parents (sha, parent, idx) VALUES (?, ?, ?)');
    parents.forEach((p, i) => cp.run(info.id, p, i));
    db.prepare('INSERT INTO fts_commits (sha, subject, body, trailers) VALUES (?, ?, ?, ?)').run(
      info.id,
      subject,
      body,
      Object.entries(trailers)
        .map(([k, v]) => `${k}: ${v}`)
        .join('\n'),
    );
    const cu = db.prepare('INSERT OR IGNORE INTO commit_uris (sha, uri) VALUES (?, ?)');
    for (const u of uris) cu.run(info.id, u);

    const uri = buildNodeUri({ kind: 'commits', sha: info.id });
    const node = db.prepare('INSERT OR IGNORE INTO nodes (uri, kind, label, props, source, valid_from) VALUES (?, ?, ?, ?, ?, ?)');
    const edge = db.prepare("INSERT INTO edges (from_uri, to_uri, kind, props, source, valid_from) VALUES (?, ?, ?, ?, 'commit', ?)");
    node.run(
      uri,
      'commit',
      `${info.id.slice(0, 7)} ${subject}`,
      json({ sha: info.id, date: info.date, author: info.authorName, email: info.authorEmail, subject, agent, branch, trailers, merge: parents.length > 1, changeKinds: kinds }),
      'commit',
      book,
    );
    parents.forEach((p, i) => edge.run(uri, buildNodeUri({ kind: 'commits', sha: p }), 'parent', json({ idx: i }), book));
    const seq = book;
    const who = agent ?? info.authorName;
    const agentUri = buildNodeUri({ kind: 'agents', name: who });
    node.run(agentUri, 'agent', who, json({ name: who }), null, seq);
    edge.run(uri, agentUri, 'authored_by', agent ? json({ trailer: true }) : null, seq);
    if (branch) {
      const b = buildNodeUri({ kind: 'branches', name: branch });
      node.run(b, 'branch', branch, json({ name: branch }), null, seq);
      edge.run(uri, b, 'on_branch', null, seq);
    }
    // Only real trailers (the last paragraph), and only well-formed ids.
    for (const [k, v] of Object.entries(trailers)) {
      if (k.toLowerCase() !== 'feedback') continue;
      for (const id of v.split(/[\s,]+/).filter((x) => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(x))) edge.run(uri, buildRef({ kind: 'feedback', id }), 'resolves', null, seq);
    }
    for (const e of events) {
      edge.run(uri, e.uri, 'changed', json({ action: e.action, changeKinds: e.changeKinds, linesAdded: e.linesAdded, linesRemoved: e.linesRemoved, ...e.props }), seq);
    }
  }

  /** Bring current-state tables (docs, sections, FTS, chunks, symbols, code refs) in line with HEAD. */
  private async updateCurrent(head: string, blobs: Map<string, string>, texts: Map<string, string>, priority: number): Promise<number> {
    const db = this.db;
    const stored = new Map((db.prepare('SELECT path, blob FROM files').all() as { path: string; blob: string }[]).map((r) => [r.path, r.blob]));
    const paths = [...new Set([...stored.keys(), ...blobs.keys()])].filter((p) => stored.get(p) !== blobs.get(p));
    const updates: { path: string; blob?: string; rec: FileRecords | null; text: string }[] = [];
    for (const p of paths) {
      const blob = blobs.get(p);
      if (!blob) {
        updates.push({ path: p, rec: null, text: '' });
        continue;
      }
      const text = texts.get(p) ?? (await readLogical(this.git, head, p)) ?? '';
      updates.push({ path: p, blob, rec: extractFile(p, text, this.ctx), text });
    }
    if (!updates.length) return 0;
    const embed = this.embed;
    db.transaction(() => {
      // Chunk texts before / after: new texts become embedding jobs, vanished ones lose theirs (same transaction).
      const oldHashes = new Set<string>();
      const newHashes = new Set<string>();
      const hashesOf = db.prepare('SELECT DISTINCT content_hash AS h FROM chunks WHERE source = ?');
      for (const u of updates) {
        for (const r of hashesOf.all(u.path) as { h: string }[]) oldHashes.add(r.h);
        for (const t of ['docs', 'sections', 'symbols', 'code_refs', 'fts_sections', 'fts_raw', 'chunks']) db.prepare(`DELETE FROM ${t} WHERE source = ?`).run(u.path);
        db.prepare('DELETE FROM files WHERE path = ?').run(u.path);
        if (!u.rec || !u.blob) continue;
        db.prepare('INSERT INTO files (path, blob, text) VALUES (?, ?, ?)').run(u.path, u.blob, u.text);
        writeCurrent(db, u.rec);
        for (const c of u.rec.chunks) newHashes.add(c.contentHash);
      }
      if (embed) enqueueHashes(db, embed, [...newHashes].filter((h) => !oldHashes.has(h)), priority);
      forgetHashes(db, [...oldHashes].filter((h) => !newHashes.has(h)));
      db.exec('DELETE FROM symbols_trgm; INSERT INTO symbols_trgm (name) SELECT DISTINCT name FROM symbols;');
      db.exec(`UPDATE docs SET (updated_commit, updated_at) = (
        SELECT c.sha, c.date FROM commit_uris cu JOIN commits c ON c.sha = cu.sha WHERE cu.uri = docs.uri ORDER BY c.seq DESC, c.mainline DESC LIMIT 1)`);
    })();
    return updates.length;
  }
}

/**
 * Standard `appliesTo` rules resolved to concrete targets (same as storage): specs (repo / tag / category / path / lang,
 * and component / componentKind through the components the spec touches; draft standards never apply), and components
 * (component:<id> / componentKind:<kind>, standards in force).
 */
function appliesEdges(m: Model): EdgeRow[] {
  const out: EdgeRow[] = [];
  for (const std of m.standards) {
    if (!std.appliesTo.length) continue;
    const stdUri = buildRef({ kind: 'standards', id: std.id });
    if (std.status !== 'draft') {
      for (const spec of m.specs) {
        const rules = matchingAppliesTo(std.appliesTo, spec, specComponents(spec, m));
        if (!rules.length) continue;
        const specUri = buildRef({ kind: 'specs', id: spec.id });
        out.push({ from: stdUri, to: specUri, kind: 'applies_to', props: { rules } });
        out.push({ from: specUri, to: stdUri, kind: 'uses_standard', props: { derived: true, via: 'appliesTo' } });
      }
    }
    if (!standardInForce(std)) continue;
    for (const c of m.components ?? []) {
      const rules = matchingAppliesTo(std.appliesTo.filter((a) => a.startsWith('component')), { repo: undefined, tags: [], category: undefined }, [{ id: c.id, kind: c.kind }]);
      if (!rules.length) continue;
      const cUri = buildRef({ kind: 'components', id: c.id });
      out.push({ from: stdUri, to: cUri, kind: 'applies_to', props: { rules } });
      out.push({ from: cUri, to: stdUri, kind: 'uses_standard', props: { derived: true, via: 'appliesTo' } });
    }
  }
  return out;
}

function writeCurrent(db: DB, rec: FileRecords): void {
  const src = rec.path;
  const doc = db.prepare(
    `INSERT OR REPLACE INTO docs (uri, kind, id, title, summary, status, category, repo, tags, standards, owner, priority, props, path, line_start, line_end, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const d of rec.docs) {
    doc.run(d.uri, d.kind, d.id, d.title, d.summary, d.status, d.category, d.repo, json(d.tags), json(d.standards), d.owner, d.priority, json(d.props), src, d.lineStart, d.lineEnd, src);
  }
  const sec = db.prepare(
    'INSERT OR REPLACE INTO sections (uri, doc_uri, id, ord, title, type, summary, line_start, line_end, standards, tokens, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  );
  for (const s of rec.sections) sec.run(s.uri, s.docUri, s.id, s.ord, s.title, s.type, s.summary, s.lineStart, s.lineEnd, json(s.standards), s.tokens, src);
  const sym = db.prepare('INSERT INTO symbols (name, normalized, parts, section_uri, source) VALUES (?, ?, ?, ?, ?)');
  for (const s of rec.symbols) {
    const node = rec.nodes.find((n) => n.kind === 'symbol' && n.label === s.name);
    const props = (node?.props ?? {}) as { normalized?: string; parts?: string[] };
    sym.run(s.name, props.normalized ?? s.name.toLowerCase(), (props.parts ?? []).join(' '), s.sectionUri, src);
  }
  const ref = db.prepare('INSERT INTO code_refs (repo, path, line_start, line_end, commit_sha, section_uri, source) VALUES (?, ?, ?, ?, ?, ?, ?)');
  for (const r of rec.codeRefs) ref.run(r.repo, r.path, r.lineStart, r.lineEnd, r.commit, r.sectionUri, src);
  const fts = db.prepare('INSERT INTO fts_sections (uri, source, title, summary, body, symbols) VALUES (?, ?, ?, ?, ?, ?)');
  const raw = db.prepare('INSERT INTO fts_raw (uri, source, body) VALUES (?, ?, ?)');
  for (const f of rec.fts) {
    fts.run(f.uri, src, f.title, f.summary, f.body, f.symbols);
    raw.run(f.uri, src, f.raw);
  }
  const ch = db.prepare(
    'INSERT INTO chunks (uri, doc_uri, chunk_index, kind, line_start, line_end, content_hash, text, prefix, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  );
  for (const c of rec.chunks) ch.run(c.uri, c.docUri, c.chunkIndex, c.kind, c.lineStart, c.lineEnd, c.contentHash, c.text, c.contextPrefix, src);
}

/** Renames: a doc file removed and another added with the same blob in one commit (new path -> old path). */
function detectRenames(changed: string[], before: Map<string, string>, after: Map<string, string>): Map<string, string> {
  const removed = changed.filter((p) => !after.has(p));
  const renames = new Map<string, string>();
  for (const p of changed.filter((x) => !before.has(x))) {
    const old = removed.find((r) => before.get(r) === after.get(p) && r.split('/')[0] === p.split('/')[0]);
    if (old) renames.set(p, old);
  }
  return renames;
}

/**
 * The version of `live` current at commit `sha` (sha included): the nearest version among its ancestors, all parents
 * followed (a merge sees what its side branch did); ties prefer the first-parent line, then the latest version.
 */
export function versionBefore(db: DB, live: string, sha: string): string | null {
  const r = db
    .prepare(
      `WITH RECURSIVE anc(sha, n, fp) AS (
         SELECT ?, 0, 1
         UNION
         SELECT p.parent, anc.n + 1, anc.fp AND p.idx = 0 FROM commit_parents p JOIN anc ON p.sha = anc.sha WHERE anc.n < 100000)
       SELECT v.uri FROM anc JOIN versions v ON v.of_uri = ? AND v.sha = anc.sha ORDER BY anc.n, anc.fp DESC, abs(v.point) DESC LIMIT 1`,
    )
    .get(sha, live) as { uri: string } | undefined;
  return r?.uri ?? null;
}

/** Stored pins (implementedCommit, specCommit) that no longer resolve to an indexed commit. */
export function lostPins(db: DB): { uri: string; field: string; sha: string }[] {
  const rows = db
    .prepare(
      `SELECT uri, 'implementedCommit' AS field, json_extract(props, '$.implementedCommit') AS sha FROM nodes
        WHERE valid_to IS NULL AND kind IN ('spec', 'standard', 'section') AND json_extract(props, '$.implementedCommit') IS NOT NULL
       UNION ALL
       SELECT uri, 'specCommit', json_extract(props, '$.specCommit') FROM nodes
        WHERE valid_to IS NULL AND kind IN ('work_order', 'verification') AND json_extract(props, '$.specCommit') IS NOT NULL`,
    )
    .all() as { uri: string; field: string; sha: string }[];
  const known = db.prepare("SELECT 1 FROM commits WHERE sha LIKE ? || '%' LIMIT 1");
  return rows.filter((r) => typeof r.sha === 'string' && !known.get(r.sha));
}

/** Decoded specs, standards and components by id (input of the derived edges). */
interface DocModel {
  specs: Map<string, StoredSpec>;
  standards: Map<string, StoredStandard>;
  components: Map<string, StoredComponent>;
}

function updateModel(m: DocModel, path: string, text: string | null): void {
  const r = DOC_FILE_RE.exec(path);
  if (!r) return;
  const dir = r[1] as DocDir;
  const map = m[dir] as Map<string, unknown>;
  if (text === null) {
    map.delete(r[2]!);
    return;
  }
  try {
    map.set(r[2]!, (dir === 'specs' ? specCodec : dir === 'standards' ? standardCodec : componentCodec).decode(text, r[2]!));
  } catch {
    map.delete(r[2]!); // unparsable version: no derived edges from it
  }
}

const modelOf = (m: DocModel): Model => ({ specs: [...m.specs.values()], standards: [...m.standards.values()], components: [...m.components.values()] });

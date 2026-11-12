import { parseLinkTarget, parseSectionUri } from '@mandate/doc';
import {
  type DependencyEdge,
  type DependencyNode,
  type DependencyRel,
  type DependencyTree,
  type Section,
  type StoredComponent,
  type StoredSpec,
  type StoredStandard,
  type WorkOrder,
} from '@mandate/shared';
import { buildRef } from '@mandate/shared/refs';
import type { GitStore } from '../git/GitStore.js';
import { specCodec, standardCodec } from './codecs.js';
import { workOrdersAt } from './work-order-docs.js';
import type { MarkdownDirRepository } from './MarkdownDirRepository.js';
import { specComponents } from './model.js';

type Kind = 'specs' | 'standards';
type Doc = StoredSpec | StoredStandard;

export interface DependencyData {
  specs: StoredSpec[];
  standards: StoredStandard[];
  components?: StoredComponent[];
  workOrders: WorkOrder[];
}

/** Target section at a commit (for "upstream changed"); null when it did not exist then. */
export type SectionAt = (kind: Kind, docId: string, sectionId: string, commit: string) => Promise<Section | null>;

const HARD: DependencyRel[] = ['depends_on'];
const SOFT_RELS = new Set(['extends', 'follows']);
const sectionKey = (kind: Kind, id: string, sid: string) => buildRef({ kind, id, sectionId: sid });
const specKey = (id: string) => buildRef({ kind: 'specs', id });
const sameSection = (a?: Section | null, b?: Section | null) => !!a && !!b && a.title === b.title && a.body === b.body && a.type === b.type;

/**
 * Upstream / downstream dependency graph of a work order, derived from section links:
 * upstream follows `depends_on` (plus the spec-level `dependsOn`, and soft `extends` / `follows`)
 * from the sections it covers; downstream is the reverse of `depends_on`. Breadth-first up to
 * `depth` levels per side, cycle-safe, every node once (a DAG: repeated targets add edges, not nodes).
 */
export async function computeDependencyTree(
  item: WorkOrder,
  data: DependencyData,
  opts: { depth?: number; commit?: string | null; sectionAt?: SectionAt } = {},
): Promise<DependencyTree> {
  const maxDepth = opts.depth ?? 4;
  const specById = new Map(data.specs.map((s) => [s.id, s]));
  const stdById = new Map(data.standards.map((s) => [s.id, s]));
  const docOf = (kind: Kind, id: string): Doc | undefined => (kind === 'specs' ? specById.get(id) : stdById.get(id));
  const root = buildRef({ kind: 'work-orders', id: item.id });
  const own = new Set(item.sections.map((s) => sectionKey('specs', item.spec, s.id)));

  // Reverse depends_on index: target section key -> dependents; target spec id -> specs depending on it.
  const dependents = new Map<string, { key: string; kind: Kind; doc: Doc; section: Section }[]>();
  for (const [kind, docs] of [['specs', data.specs], ['standards', data.standards]] as const) {
    for (const doc of docs) {
      for (const section of doc.sections) {
        for (const l of section.links) {
          if (l.rel !== 'depends_on') continue;
          const list = dependents.get(l.to) ?? [];
          list.push({ key: sectionKey(kind, doc.id, section.id), kind, doc, section });
          dependents.set(l.to, list);
        }
      }
    }
  }
  // Spec-level dependencies are derived from section links, so spec nodes are not needed.
  const specDependents = (_id: string): StoredSpec[] => [];
  const openClaim = (specId: string, sectionId?: string) =>
    data.workOrders.find((w) => w.claim && (w.status === 'pending' || w.status === 'in_progress') && w.spec === specId && (!sectionId || w.sections.some((s) => s.id === sectionId)))?.claim;

  const ordersOn = (specId: string, sectionId?: string) =>
    data.workOrders
      .filter((w) => w.id !== item.id && w.status !== 'cancelled' && w.spec === specId && (!sectionId || w.sections.some((s) => s.id === sectionId)))
      .map((w) => ({ id: w.id, kind: w.kind, status: w.status }));

  const sectionImplemented = (kind: string, id: string, sid: string) => !!specById.get(id)?.sections.find((x) => x.id === sid)?.implementedCommit && kind === 'specs';

  const nodes = new Map<string, DependencyNode>();
  const edges: DependencyEdge[] = [];
  const edgeKeys = new Set<string>();
  const addEdge = (e: DependencyEdge) => {
    const k = `${e.from}|${e.to}|${e.rel}|${e.via ?? ''}`;
    if (e.from === e.to || edgeKeys.has(k)) return;
    edgeKeys.add(k);
    edges.push(e);
  };

  const makeSectionNode = async (key: string, kind: Kind, docId: string, sid: string, side: 'upstream' | 'downstream', depth: number): Promise<DependencyNode> => {
    const doc = docOf(kind, docId);
    const section = doc?.sections.find((x) => x.id === sid);
    const spec = kind === 'specs' ? (doc as StoredSpec | undefined) : undefined;
    let upstreamChanged = false;
    if (section?.implementedCommit && opts.sectionAt) {
      for (const l of section.links) {
        const t = parseSectionUri(l.to);
        if (!t || (t.kind !== 'specs' && t.kind !== 'standards')) continue;
        const now = docOf(t.kind, t.id)?.sections.find((x) => x.id === t.sectionId);
        if (!now) continue;
        if (!sameSection(await opts.sectionAt(t.kind, t.id, t.sectionId, section.implementedCommit), now)) {
          upstreamChanged = true;
          break;
        }
      }
    }
    return {
      key,
      type: 'section',
      side,
      depth,
      docKind: kind,
      docId,
      docTitle: doc?.title ?? null,
      sectionId: sid,
      sectionTitle: section?.title ?? null,
      ...(section?.summary ? { summary: section.summary } : {}),
      state: !section ? 'missing' : section.archived || (spec?.status === 'archived') ? 'archived' : kind === 'standards' ? 'standard' : section.implementedCommit ? 'implemented' : 'not_implemented',
      ...(spec ? { specStatus: spec.status } : {}),
      blocked: !!section?.links.some((l) => {
        const t = parseSectionUri(l.to);
        return l.rel === 'depends_on' && t?.kind === 'specs' && !sectionImplemented('specs', t.id, t.sectionId);
      }),
      broken: !!section?.links.some((l) => {
        const t = parseSectionUri(l.to);
        if (l.rel !== 'depends_on' || t?.kind !== 'specs') return false;
        const d = specById.get(t.id);
        const ts = d?.sections.find((x) => x.id === t.sectionId);
        return !ts || !!ts.archived || d?.status === 'archived';
      }),
      upstreamChanged,
      ...(kind === 'specs' && openClaim(docId, sid) ? { claim: openClaim(docId, sid)! } : {}),
      ...(spec && data.components?.length ? { components: specComponents(spec, data, [sid]).map((c) => c.id) } : {}),
      workOrders: kind === 'specs' ? ordersOn(docId, sid) : [],
    };
  };
  const makeSpecNode = (id: string, side: 'upstream' | 'downstream', depth: number): DependencyNode => {
    const spec = specById.get(id);
    const done = !!spec && (spec.status === 'done' || !!spec.implementedCommit);
    return {
      key: specKey(id),
      type: 'spec',
      side,
      depth,
      docKind: 'specs',
      docId: id,
      docTitle: spec?.title ?? null,
      ...(spec?.summary ? { summary: spec.summary } : {}),
      state: !spec ? 'missing' : done ? 'implemented' : 'not_implemented',
      ...(spec ? { specStatus: spec.status } : {}),
      blocked: false,
      upstreamChanged: false,
      ...(openClaim(id) ? { claim: openClaim(id)! } : {}),
      workOrders: ordersOn(id),
    };
  };

  /* ---------- upstream ---------- */
  type Frontier = { key: string; kind: Kind | 'spec'; docId: string; sectionId?: string; via?: string };
  type Target = { kind: Kind | 'spec'; docId: string; sectionId?: string; rel: DependencyRel };
  const noSpecTargets: Target[] = [];
  const keyOf = (t: Target) => (t.kind === 'spec' ? specKey(t.docId) : t.sectionId ? sectionKey(t.kind, t.docId, t.sectionId) : buildRef({ kind: t.kind, id: t.docId }));
  const nodeOf = async (key: string, t: Target, side: 'upstream' | 'downstream', depth: number): Promise<DependencyNode> => {
    if (t.kind === 'spec') return makeSpecNode(t.docId, side, depth);
    if (t.sectionId) return makeSectionNode(key, t.kind, t.docId, t.sectionId, side, depth);
    const d = docOf(t.kind, t.docId);
    return { key, type: 'spec', side, depth, docKind: t.kind, docId: t.docId, docTitle: d?.title ?? null, state: d ? 'standard' : 'missing', blocked: false, upstreamChanged: false, workOrders: [] };
  };
  const rootSpec: Frontier = { key: root, kind: 'spec', docId: item.spec };
  const itemSpec = specById.get(item.spec);
  let frontier: Frontier[] = item.sections.map((s) => ({ key: root, kind: 'specs', docId: item.spec, sectionId: s.id, via: s.id }));
  const upstreamOf = (f: Frontier): Target[] => {
    if (f.kind === 'spec') return noSpecTargets;
    const section = docOf(f.kind, f.docId)?.sections.find((x) => x.id === f.sectionId);
    const out: Target[] = [];
    for (const l of section?.links ?? []) {
      if (l.rel !== 'depends_on' && !SOFT_RELS.has(l.rel)) continue;
      const t = parseLinkTarget(l.to); // a whole standard (follows) is a soft upstream node too
      if (!t || (t.kind !== 'specs' && t.kind !== 'standards')) continue;
      out.push({ kind: t.kind, docId: t.id, sectionId: t.sectionId, rel: l.rel as DependencyRel });
    }
    return out;
  };
  // The work order's spec-level dependsOn hangs off the center node.
  const rootSpecDeps: Target[] = noSpecTargets;

  for (let depth = 1; depth <= maxDepth && (frontier.length || (depth === 1 && rootSpecDeps.length)); depth++) {
    const next: Frontier[] = [];
    const expand = depth === 1 ? [...frontier.map((f) => ({ f, targets: upstreamOf(f) })), { f: rootSpec, targets: rootSpecDeps }] : frontier.map((f) => ({ f, targets: upstreamOf(f) }));
    for (const { f, targets } of expand) {
      for (const t of targets) {
        const key = keyOf(t);
        if (own.has(key)) continue; // links between the work order's own sections
        addEdge({ from: key, to: f.key, rel: t.rel, soft: !HARD.includes(t.rel), ...(f.key === root && f.via ? { via: f.via } : {}) });
        if (nodes.has(key)) continue;
        nodes.set(key, await nodeOf(key, t, 'upstream', depth));
        next.push({ key, kind: t.kind, docId: t.docId, sectionId: t.sectionId });
      }
    }
    frontier = next;
  }
  for (const f of frontier) if (upstreamOf(f).some((t) => !nodes.has(keyOf(t)))) nodes.get(f.key)!.truncated = true;

  /* ---------- downstream ---------- */
  const downstreamOf = (f: Frontier): Target[] => {
    if (f.kind === 'spec') return noSpecTargets;
    return (dependents.get(sectionKey(f.kind, f.docId, f.sectionId!)) ?? []).map((d) => ({ kind: d.kind, docId: d.doc.id, sectionId: d.section.id, rel: 'depends_on' as const }));
  };
  frontier = item.sections.map((s) => ({ key: root, kind: 'specs', docId: item.spec, sectionId: s.id, via: s.id }));
  const rootSpecDependents: Target[] = noSpecTargets;
  void specDependents;
  for (let depth = 1; depth <= maxDepth && (frontier.length || (depth === 1 && rootSpecDependents.length)); depth++) {
    const next: Frontier[] = [];
    const expand = depth === 1 ? [...frontier.map((f) => ({ f, targets: downstreamOf(f) })), { f: rootSpec, targets: rootSpecDependents }] : frontier.map((f) => ({ f, targets: downstreamOf(f) }));
    for (const { f, targets } of expand) {
      for (const t of targets) {
        const key = keyOf(t);
        if (own.has(key)) continue;
        addEdge({ from: f.key, to: key, rel: t.rel, soft: false, ...(f.key === root && f.via ? { via: f.via } : {}) });
        if (nodes.has(key)) continue; // already placed (upstream or earlier): the edge is enough
        nodes.set(key, await nodeOf(key, t, 'downstream', depth));
        next.push({ key, kind: t.kind, docId: t.docId, sectionId: t.sectionId });
      }
    }
    frontier = next;
  }
  for (const f of frontier) if (downstreamOf(f).some((t) => !nodes.has(keyOf(t)))) nodes.get(f.key)!.truncated = true;

  /* ---------- blockers: unfinished upstream reachable from the center over hard edges ---------- */
  const hardIn = new Map<string, string[]>();
  for (const e of edges) if (!e.soft) hardIn.set(e.to, [...(hardIn.get(e.to) ?? []), e.from]);
  const reach = new Set<string>();
  const stack = [root];
  while (stack.length) {
    for (const from of hardIn.get(stack.pop()!) ?? []) {
      if (reach.has(from) || nodes.get(from)?.side !== 'upstream') continue;
      reach.add(from);
      stack.push(from);
    }
  }
  const blockers = [...reach].map((k) => nodes.get(k)!).filter((n) => n.state === 'not_implemented' || n.state === 'missing');
  for (const n of blockers) n.blocker = true;

  const center: DependencyNode = {
    key: root,
    type: 'work_order',
    side: 'center',
    depth: 0,
    docKind: 'specs',
    docId: item.spec,
    docTitle: itemSpec?.title ?? null,
    ...(itemSpec?.summary ? { summary: itemSpec.summary } : {}),
    state: item.status === 'done' ? 'implemented' : 'not_implemented',
    ...(itemSpec ? { specStatus: itemSpec.status } : {}),
    blocked: blockers.length > 0,
    upstreamChanged: false,
    ...(item.claim ? { claim: item.claim } : {}),
    ...(itemSpec && data.components?.length ? { components: specComponents(itemSpec, data, item.sections.map((s) => s.id)).map((c) => c.id) } : {}),
    workOrders: [{ id: item.id, kind: item.kind, status: item.status }],
  };
  const all = [center, ...nodes.values()];
  const downstreamOrders = new Set([...nodes.values()].filter((n) => n.side === 'downstream').flatMap((n) => n.workOrders.map((w) => w.id)));
  return {
    root,
    commit: opts.commit ?? null,
    depth: maxDepth,
    nodes: all,
    edges,
    summary: {
      blockedBySections: blockers.length,
      blockedBySpecs: new Set(blockers.map((n) => n.docId)).size,
      dependentWorkOrders: downstreamOrders.size,
      upstream: all.filter((n) => n.side === 'upstream').length,
      downstream: all.filter((n) => n.side === 'downstream').length,
    },
  };
}

/** Loads the inputs at HEAD or at an older commit and computes the graph. */
export class DependencyService {
  private atCommit = new Map<string, Doc | null>();
  /** Components repository (wired by createStorage). */
  components?: MarkdownDirRepository<StoredComponent>;

  constructor(
    private readonly specs: MarkdownDirRepository<StoredSpec>,
    private readonly standards: MarkdownDirRepository<StoredStandard>,
    private readonly workOrders: { list(): Promise<WorkOrder[]> },
    private readonly git: GitStore,
  ) {}

  private async docAt(kind: Kind, id: string, commit: string): Promise<Doc | null> {
    const key = `${kind}/${id}@${commit}`;
    if (!this.atCommit.has(key)) {
      const raw = await this.git.readFileAt(commit, `${kind}/${id}.md`).catch(() => null);
      let doc: Doc | null = null;
      try {
        doc = raw === null ? null : kind === 'specs' ? specCodec.decode(raw, id) : standardCodec.decode(raw, id);
      } catch {
        doc = null;
      }
      this.atCommit.set(key, doc);
    }
    return this.atCommit.get(key)!;
  }

  /** Specs, standards and work orders as they were at `commit` (markdown documents, or the legacy jsonl before the migration). */
  async dataAt(commit: string): Promise<DependencyData> {
    // blobsAt lists paths (-> blob ids); contents come from readFileAt.
    const paths = [...(await this.git.blobsAt(commit, ['specs', 'standards'])).keys()].filter((p) => p.endsWith('.md'));
    const docs = await Promise.all(
      paths.map(async (p) => {
        const [dir, file] = p.split('/') as [Kind, string];
        return { dir, doc: await this.docAt(dir, file.slice(0, -3), commit) };
      }),
    );
    const decoded = <T extends Doc>(dir: Kind) => docs.flatMap((d) => (d.dir === dir && d.doc ? [d.doc as T] : []));
    const workOrders = await workOrdersAt(this.git, commit);
    return { specs: decoded<StoredSpec>('specs'), standards: decoded<StoredStandard>('standards'), workOrders };
  }

  async tree(item: WorkOrder, opts: { at?: string | null; depth?: number } = {}): Promise<DependencyTree> {
    const commit = opts.at ? await this.git.resolveCommit(opts.at) : null;
    if (opts.at && !commit) throw Object.assign(new Error(`unknown commit '${opts.at}'`), { statusCode: 404 });
    const data = commit ? await this.dataAt(commit) : { specs: await this.specs.list(), standards: await this.standards.list(), workOrders: await this.workOrders.list(), components: (await this.components?.list()) ?? [] };
    // The work order as it was then (if it existed), else its current form.
    const then = data.workOrders.find((w) => w.id === item.id) ?? item;
    const sectionAt: SectionAt = async (kind, id, sid, c) => (await this.docAt(kind, id, c))?.sections.find((x) => x.id === sid) ?? null;
    return computeDependencyTree(then, data, { depth: opts.depth, commit: commit ?? null, sectionAt });
  }
}

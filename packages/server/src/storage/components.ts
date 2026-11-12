import { parseLinkTarget } from '@mandate/doc';
import {
  architectureGetInputSchema,
  buildArchitectureRef,
  buildFindingRef,
  buildRef,
  componentAncestors,
  computeLayering,
  feedbackSchema,
  globMatch,
  inScope,
  matchingAppliesTo,
  OPEN_WORK_ORDER_STATUSES,
  ownerOf,
  parseAuditCodeRef,
  parseRef,
  type ArchitectureEdge,
  type ArchitectureGetInput,
  type ArchitectureGraph,
  type ArchitectureNode,
  type ComponentDerived,
  type ComponentGap,
  type StoredAudit,
  type StoredComponent,
  type StoredFeedback,
  type StoredSpec,
  type StoredStandard,
} from '@mandate/shared';
import type { GitStore } from '../git/GitStore.js';
import { componentCodec, specCodec, standardCodec } from './codecs.js';
import { workOrdersAt } from './work-order-docs.js';
import type { LinkService } from './links.js';
import { criteriaOf, dependencyState, docUri, finder, levelOf, sectionUri, specComponents, standardInForce, type Model } from './model.js';
import type { VerificationService } from './verification.js';

type KnownRef = { repo: string; path: string; uri: string };

/**
 * Code refs of every source (repo, path), for ownership coverage: spec and standard section refs, files work orders
 * touched (not deleted ones), and the code refs of audit findings (when the audits are given; abandoned ones skipped).
 */
export function knownRefs(m: Model, audits: StoredAudit[] = []): KnownRef[] {
  const out: KnownRef[] = [];
  for (const [kind, docs] of [['specs', m.specs], ['standards', m.standards]] as const)
    for (const d of docs) for (const sec of d.sections) for (const r of sec.refs ?? []) out.push({ repo: r.repo, path: r.path, uri: sectionUri(kind, d.id, sec.id) });
  for (const w of m.workOrders ?? []) for (const t of w.touched ?? []) if (t.change !== 'deleted') out.push({ repo: t.repo, path: t.path, uri: buildRef({ kind: 'work-orders', id: w.id }) });
  for (const a of audits) {
    if (a.status === 'abandoned') continue;
    for (const s of a.sections)
      for (const f of s.findings ?? [])
        for (const c of f.codeRefs ?? []) {
          const r = parseAuditCodeRef(c);
          if (r) out.push({ repo: r.repo, path: r.path, uri: buildFindingRef({ audit: a.id, id: f.id }) });
        }
  }
  return out;
}

/** Components a component depends on (section or whole-component depends_on targets). */
export function componentDeps(c: StoredComponent): { to: string; section?: string; from: string }[] {
  const out: { to: string; section?: string; from: string }[] = [];
  for (const s of c.sections) {
    if (s.archived) continue;
    for (const l of s.links) {
      const t = parseLinkTarget(l.to);
      if (l.rel === 'depends_on' && t?.kind === 'components' && t.id !== c.id) out.push({ to: t.id, ...(t.sectionId ? { section: t.sectionId } : {}), from: s.id });
    }
  }
  return out;
}

/**
 * Rules that apply to a component: its sections' `follows` links (whole standard or section),
 * standards whose appliesTo names it (`component:<id>`, `componentKind:<kind>`), and rules whose
 * scope covers code it owns (by the known code refs inside its `owns` globs).
 */
export function componentRules(c: StoredComponent, m: Model): ComponentDerived['rules'] {
  const f = finder(m);
  const out = new Map<string, ComponentDerived['rules'][number]>();
  const add = (std: StoredStandard, section: { id: string; title: string } & Parameters<typeof levelOf>[0], via: string) => {
    const uri = sectionUri('standards', std.id, section.id);
    if (!out.has(uri)) out.set(uri, { uri, title: section.title, level: levelOf(section), standard: std.id, via });
  };
  for (const s of c.sections) {
    if (s.archived) continue;
    for (const l of s.links) if (l.rel === 'follows') for (const cr of criteriaOf(l.to, f)) if (!cr.upcoming) add(cr.standard, cr.section, `${s.id} follows`);
  }
  const owned = knownRefs(m).filter((r) => ownerOf(r.repo, r.path, m.components ?? [])?.component.id === c.id);
  for (const std of m.standards) {
    if (!standardInForce(std)) continue;
    const rules = matchingAppliesTo(std.appliesTo.filter((a) => a.startsWith('component')), { repo: undefined, tags: [], category: undefined }, [{ id: c.id, kind: c.kind }]);
    if (rules.length) for (const cr of criteriaOf(docUri('standards', std.id), f)) add(cr.standard, cr.section, `appliesTo ${rules.join(', ')}`);
    for (const s of std.sections) {
      if (s.type !== 'rule' || s.archived || !s.scope || (!s.scope.paths?.length && !s.scope.languages?.length)) continue;
      if (owned.some((r) => inScope(s.scope, r.path))) add(std, s, 'scope of owned code');
    }
  }
  const order = { must: 0, should: 1, may: 2 };
  return [...out.values()].sort((a, b) => order[a.level] - order[b.level]);
}

/**
 * Reference gaps of the active components (integrity warnings, never auto-fixed): no spec section affects it
 * (directly, or through code refs to files it owns), no standard applies to it, or it declares no owned code
 * without being `kind: external`.
 */
export function componentGaps(m: Model): Map<string, ComponentGap[]> {
  const referenced = new Set(m.specs.filter((s) => s.status !== 'archived').flatMap((s) => specComponents(s, m).map((c) => c.id)));
  const out = new Map<string, ComponentGap[]>();
  for (const c of m.components ?? []) {
    if (c.status !== 'active') continue;
    const gaps: ComponentGap[] = [];
    const ref = `mandate://components/${c.id}`;
    if (!referenced.has(c.id)) gaps.push({ rule: 'component_unreferenced', message: `${c.id}: no spec section affects it`, hint: `Add an affects link to ${ref} on the spec sections that change it (or a code ref to a file it owns).` });
    if (c.kind !== 'external' && !followedStandards(c) && !componentRules(c, m).length) gaps.push({ rule: 'component_no_standards', message: `${c.id}: follows no standard`, hint: `Add follows links from ${ref} sections to the standards that apply (mandate://standards/<id>).` });
    if (c.kind !== 'external' && !c.owns.some((o) => o.paths.length)) gaps.push({ rule: 'component_no_code', message: `${c.id}: owns no code`, hint: `Declare owns globs (repo + paths) on ${ref}, or set kind: external for a third-party service.` });
    if (gaps.length) out.set(c.id, gaps);
  }
  return out;
}

/** Coverage lint: code refs no component owns, and owns globs that match no known code ref (refs of every source). */
export function coverage(m: Model, audits: StoredAudit[] = []): { unowned: KnownRef[]; emptyGlobs: { component: string; repo: string; glob: string }[] } {
  const refs = knownRefs(m, audits);
  const comps = (m.components ?? []).filter((c) => c.kind !== 'external');
  const unowned = refs.filter((r) => !ownerOf(r.repo, r.path, m.components ?? []));
  const emptyGlobs = comps.flatMap((c) => c.owns.flatMap((o) => o.paths.filter((g) => !refs.some((r) => r.repo === o.repo && globMatch(g, r.path))).map((glob) => ({ component: c.id, repo: o.repo, glob }))));
  return { unowned, emptyGlobs };
}

/** Derived facts of components (spec, work-order and feedback connections, rules, coverage). */
export async function deriveComponents(
  components: StoredComponent[],
  m: Model,
  deps: { verification?: VerificationService; links?: LinkService } = {},
): Promise<Record<string, ComponentDerived>> {
  const f = finder(m);
  const cov = coverage(m);
  const gaps = componentGaps(m);
  const touching = m.specs.filter((s) => s.status !== 'archived').map((s) => ({ spec: s, comps: specComponents(s, m) }));
  const specState = new Map<string, { drifted: boolean; blocked: boolean; failing: number }>();
  for (const { spec } of touching) {
    const v = deps.verification ? await deps.verification.forSpec(spec, undefined, m) : null;
    const drift = deps.verification ? await deps.verification.drift(spec, m) : [];
    const blocked = spec.sections.some((s) => !s.archived && s.links.some((l) => l.rel === 'depends_on' && dependencyState(l.to, f) !== 'ok'));
    specState.set(spec.id, { drifted: drift.length > 0, blocked, failing: v?.failing ?? 0 });
  }
  const out: Record<string, ComponentDerived> = {};
  for (const c of components) {
    const affectedBy = touching
      .map(({ spec, comps }) => ({ spec, hit: comps.find((x) => x.id === c.id) }))
      .filter((x) => x.hit)
      .map(({ spec, hit }) => ({ spec: spec.id, title: spec.title, sections: hit!.sections, via: hit!.via }));
    const workOrders = (m.workOrders ?? [])
      .filter((w) => OPEN_WORK_ORDER_STATUSES.includes(w.status) && affectedBy.some((a) => a.spec === w.spec && w.sections.some((s) => a.sections.includes(s.id))))
      .map((w) => ({ id: w.id, spec: w.spec, kind: w.kind, status: w.status, ...(w.claim ? { claim: w.claim } : {}) }));
    const openFeedback = (m.feedback ?? []).filter((x) => x.status !== 'closed' && x.targets.some((t) => parseRef(t)?.kind === 'components' && parseRef(t)?.id === c.id)).length;
    let upstreamChanged: string[] = [];
    if (deps.links) {
      const info = await deps.links.forDoc('components', c);
      upstreamChanged = Object.entries(info.sections).filter(([, v]) => v.upstreamChanged).map(([k]) => k);
    }
    const states = affectedBy.map((a) => specState.get(a.spec)).filter((x): x is NonNullable<typeof x> => !!x);
    const all = m.components ?? [];
    out[c.id] = {
      dependsOn: [...new Set(componentDeps(c).map((d) => d.to))],
      ancestors: componentAncestors(c.id, all).map((a) => ({ id: a.id, title: a.title })),
      children: all.filter((x) => x.parent === c.id).map((x) => ({ id: x.id, title: x.title, status: x.status })),
      dependents: (m.components ?? []).filter((o) => componentDeps(o).some((d) => d.to === c.id)).map((o) => o.id),
      affectedBy,
      workOrders,
      openFeedback,
      rules: componentRules(c, m),
      upstreamChanged,
      specStates: { drifted: states.filter((s) => s.drifted).length, blocked: states.filter((s) => s.blocked).length, failing: states.reduce((n, s) => n + s.failing, 0) },
      emptyGlobs: cov.emptyGlobs.filter((g) => g.component === c.id).map((g) => `${g.repo}:${g.glob}`),
      gaps: gaps.get(c.id) ?? [],
    };
  }
  return out;
}

/** Distinct standards a component's sections follow (whole standard or one of its sections). */
function followedStandards(c: StoredComponent): number {
  const ids = new Set<string>();
  for (const s of c.sections) {
    if (s.archived) continue;
    for (const l of s.links) {
      const t = parseLinkTarget(l.to);
      if (l.rel === 'follows' && t?.kind === 'standards') ids.add(t.id);
    }
  }
  return ids.size;
}

const mermaidId = (id: string) => id.replace(/[^a-zA-Z0-9_]/g, '_');
const q = (s: string) => `"${s.replace(/"/g, "'")}"`;

/**
 * The architecture as a top-to-bottom Mermaid flowchart: one subgraph per layer, and a nested subgraph per containing
 * component (its children inside; edges to the parent attach to its subgraph). Upward edges in red, dashed.
 */
export function toMermaid(g: Pick<ArchitectureGraph, 'layers' | 'nodes' | 'edges'>): string {
  const lines = ['flowchart TB'];
  const shown = new Set(g.nodes.map((n) => n.id));
  const kids = (id: string) => g.nodes.filter((n) => n.parent === id);
  const label = (n: ArchitectureNode) => q(`${n.title}${n.status !== 'active' ? ` (${n.status})` : ''}`);
  const emit = (n: ArchitectureNode, indent: string, seen: Set<string>) => {
    if (seen.has(n.id)) return;
    seen.add(n.id);
    const children = kids(n.id);
    if (!children.length) return void lines.push(`${indent}${mermaidId(n.id)}[${label(n)}]`);
    lines.push(`${indent}subgraph ${mermaidId(n.id)}[${label(n)}]`);
    for (const c of children) emit(c, `${indent}  `, seen);
    lines.push(`${indent}end`);
  };
  const seen = new Set<string>();
  for (const layer of g.layers) {
    const roots = g.nodes.filter((n) => n.layer === layer.id && !(n.parent && shown.has(n.parent)));
    if (!roots.length) continue;
    lines.push(`  subgraph ${mermaidId(`layer_${layer.id}`)}[${q(layer.label)}]`);
    for (const n of roots) emit(n, '    ', seen);
    lines.push('  end');
  }
  g.edges.forEach((e) => lines.push(`  ${mermaidId(e.from)} -->${e.label ? `|${q(e.label)}|` : ''} ${mermaidId(e.to)}`));
  g.edges.forEach((e, i) => {
    if (e.violation) lines.push(`  linkStyle ${i} stroke:#e03131,stroke-width:2px,stroke-dasharray:5 4`);
  });
  for (const n of g.nodes.filter((x) => x.status !== 'active' && (!x.diff || x.diff === 'unchanged'))) lines.push(`  style ${mermaidId(n.id)} stroke-dasharray:4 3,opacity:0.7`);
  for (const n of g.nodes.filter((x) => x.diff && x.diff !== 'unchanged')) {
    const color = n.diff === 'added' ? '#2f9e44' : n.diff === 'removed' ? '#e03131' : '#f08c00';
    lines.push(`  style ${mermaidId(n.id)} stroke:${color},stroke-width:2px`);
  }
  return `${lines.join('\n')}\n`;
}

/** The generated architecture view: components + depends_on, grouped, with overlays, focus, history and compare. */
export class ArchitectureService {
  constructor(
    private readonly git: GitStore,
    private readonly model: () => Promise<Model>,
    private readonly deps: { verification?: VerificationService; links?: LinkService } = {},
  ) {}

  /** Documents, work orders and feedback as they were at a commit. */
  async modelAt(commit: string): Promise<Model> {
    const paths = [...(await this.git.blobsAt(commit, ['specs', 'standards', 'components'])).keys()].filter((p) => p.endsWith('.md'));
    const out: Model = { specs: [], standards: [], components: [], workOrders: [], feedback: [] };
    for (const p of paths) {
      const [dir, file] = p.split('/') as [string, string];
      const raw = await this.git.readFileAt(commit, p).catch(() => null);
      if (!raw) continue;
      try {
        const id = file.slice(0, -3);
        if (dir === 'specs') out.specs.push(specCodec.decode(raw, id));
        else if (dir === 'standards') out.standards.push(standardCodec.decode(raw, id));
        else if (dir === 'components') out.components!.push(componentCodec.decode(raw, id));
      } catch {
        /* unparsable at that commit */
      }
    }
    out.workOrders!.push(...(await workOrdersAt(this.git, commit)));
    const jsonl = async (file: string) => ((await this.git.readFileAt(commit, file).catch(() => null)) ?? '').split('\n').filter(Boolean);
    for (const line of await jsonl('feedback.jsonl')) {
      try {
        const r = feedbackSchema.safeParse(JSON.parse(line));
        if (r.success) out.feedback!.push(r.data as StoredFeedback);
      } catch {
        /* skip */
      }
    }
    return out;
  }

  private async graph(m: Model, opts: { groupBy: 'repo' | 'kind'; focus?: string; head: boolean; includeArchived?: boolean }): Promise<Pick<ArchitectureGraph, 'groups' | 'layers' | 'nodes' | 'edges'>> {
    // Archived components are hidden unless asked for (they stay resolvable by reference).
    const comps = (m.components ?? []).filter((c) => opts.includeArchived || c.status !== 'archived');
    const derived = await deriveComponents(comps, m, opts.head ? this.deps : {});
    const groupOf = (c: StoredComponent) => (opts.groupBy === 'kind' ? c.kind : (c.owns[0]?.repo ?? (c.kind === 'external' ? 'external' : 'unowned')));
    const nodes: ArchitectureNode[] = comps.map((c) => {
      const d = derived[c.id]!;
      const resp = c.sections.find((s) => s.id === 'responsibility' || (s.type === 'responsibility' && !s.archived))?.body.split(/\n\s*\n/)[0]?.trim();
      return {
        id: c.id,
        uri: buildRef({ kind: 'components', id: c.id }),
        title: c.title,
        kind: c.kind,
        status: c.status,
        ...(c.summary ? { summary: c.summary } : {}),
        ...(resp ? { responsibility: resp } : {}),
        group: groupOf(c),
        repos: [...new Set(c.owns.map((o) => o.repo))],
        layer: '',
        layerSource: 'derived',
        ...(c.parent && comps.some((x) => x.id === c.parent) ? { parent: c.parent } : {}),
        children: comps.filter((x) => x.parent === c.id).map((x) => x.id),
        owns: c.owns.flatMap((o) => o.paths.map((p) => `${o.repo}:${p}`)),
        overlay: {
          workOrders: d.workOrders.length,
          claims: [...new Set(d.workOrders.map((w) => w.claim?.agent).filter((a): a is string => !!a))],
          specs: d.affectedBy.length,
          standards: followedStandards(c),
          openFeedback: d.openFeedback,
          drifted: d.specStates.drifted,
          blocked: d.specStates.blocked,
          upstreamChanged: d.upstreamChanged.length,
          failing: d.specStates.failing,
        },
      };
    });
    const edges: ArchitectureEdge[] = [];
    for (const c of comps) {
      for (const d of componentDeps(c)) {
        if (!comps.some((x) => x.id === d.to)) continue;
        const target = comps.find((x) => x.id === d.to)!;
        const label = d.section ? (target.sections.find((s) => s.id === d.section)?.title ?? d.section) : undefined;
        if (edges.some((e) => e.from === c.id && e.to === d.to && e.section === d.section)) continue;
        edges.push({ from: c.id, to: d.to, ...(label ? { label } : {}), ...(d.section ? { section: d.section } : {}) });
      }
    }
    const layering = computeLayering(comps, edges);
    for (const n of nodes) {
      const l = layering.layerOf.get(n.id)!;
      n.layer = l.layer;
      n.layerSource = l.source;
    }
    edges.forEach((e, i) => {
      if (layering.violations.has(i)) e.violation = true;
    });
    if (opts.focus && comps.some((c) => c.id === opts.focus)) {
      const reach = (start: string, next: (id: string) => string[]) => {
        const seen = new Set<string>();
        const stack = [start];
        while (stack.length) for (const n of next(stack.pop()!)) if (!seen.has(n)) (seen.add(n), stack.push(n));
        return seen;
      };
      const up = reach(opts.focus, (id) => edges.filter((e) => e.from === id).map((e) => e.to));
      const down = reach(opts.focus, (id) => edges.filter((e) => e.to === id).map((e) => e.from));
      for (const n of nodes) n.focus = n.id === opts.focus ? 'focus' : up.has(n.id) ? 'upstream' : down.has(n.id) ? 'downstream' : 'other';
      const inFocus = new Set([opts.focus, ...up, ...down]);
      for (const e of edges) e.focus = inFocus.has(e.from) && inFocus.has(e.to) && (up.has(e.to) || e.from === opts.focus || down.has(e.from) || e.to === opts.focus);
    }
    const groups = [...new Set(nodes.map((n) => n.group))].sort().map((id) => ({ id, label: id }));
    return { groups, layers: layering.layers, nodes, edges };
  }

  /** `architectureGet`: the graph (or a Mermaid flowchart) at HEAD or a commit, optionally focused and compared with another commit. */
  async get(input: ArchitectureGetInput = {}): Promise<ArchitectureGraph> {
    const { at, compare, focus, groupBy, format, includeArchived } = architectureGetInputSchema.parse(input);
    const commit = at ? await this.git.resolveCommit(at) : null;
    if (at && !commit) throw Object.assign(new Error(`unknown commit '${at}'`), { statusCode: 404 });
    const base = compare ? await this.git.resolveCommit(compare) : null;
    if (compare && !base) throw Object.assign(new Error(`unknown commit '${compare}'`), { statusCode: 404 });
    const m = commit ? await this.modelAt(commit) : await this.model();
    const g = await this.graph(m, { groupBy, focus, head: !commit, includeArchived });
    if (base) {
      const old = await this.modelAt(base);
      const og = await this.graph(old, { groupBy, head: false, includeArchived });
      const oldComps = new Map((old.components ?? []).map((c) => [c.id, JSON.stringify(c)]));
      const newComps = new Map((m.components ?? []).map((c) => [c.id, JSON.stringify(c)]));
      for (const n of g.nodes) n.diff = !oldComps.has(n.id) ? 'added' : oldComps.get(n.id) !== newComps.get(n.id) ? 'changed' : 'unchanged';
      for (const n of og.nodes) if (!newComps.has(n.id)) g.nodes.push({ ...n, diff: 'removed' });
      const key = (e: ArchitectureEdge) => `${e.from}|${e.to}|${e.section ?? ''}`;
      const oldEdges = new Set(og.edges.map(key));
      const newEdges = new Set(g.edges.map(key));
      for (const e of g.edges) e.diff = oldEdges.has(key(e)) ? 'unchanged' : 'added';
      for (const e of og.edges) if (!newEdges.has(key(e))) g.edges.push({ ...e, diff: 'removed' });
      for (const grp of og.groups) if (!g.groups.some((x) => x.id === grp.id)) g.groups.push(grp);
      // Layers only the removed nodes use: insert after the nearest preceding layer of the old order.
      og.layers.forEach((layer, i) => {
        if (g.layers.some((x) => x.id === layer.id) || !g.nodes.some((n) => n.layer === layer.id)) return;
        const prev = og.layers.slice(0, i).reverse().find((p) => g.layers.some((x) => x.id === p.id));
        g.layers.splice(prev ? g.layers.findIndex((x) => x.id === prev.id) + 1 : 0, 0, layer);
      });
    }
    const out: ArchitectureGraph = {
      ref: buildArchitectureRef({ ...(commit ? { commit } : {}), ...(focus ? { focus } : {}) }),
      commit,
      compare: base,
      groupBy,
      ...g,
    };
    if (format === 'mermaid') out.mermaid = toMermaid(out);
    return out;
  }
}

export type { StoredSpec };

import { findCycle, parseLinkTarget } from '@mandate/doc';
import {
  buildRef,
  inScope,
  matchingAppliesTo,
  OPEN_WORK_ORDER_STATUSES,
  type Exemption,
  ownerOf,
  componentAncestors,
  type Section,
  type StoredComponent,
  type StoredFeedback,
  type StoredSpec,
  type StoredStandard,
  type WaiverState,
  type WorkOrder,
  foldIdentity,
} from '@mandate/shared';
import { criteriaHash } from './ids.js';

/**
 * Pure rules over a snapshot of the repository (documents, work orders, feedback): link targets,
 * archive / supersede states, criteria inheritance with provenance, waivers and exemptions, derived
 * spec dependencies and the cycle checks. Services and the repo lint share them.
 */

export type Kind = 'specs' | 'standards' | 'components';
export type Doc = StoredSpec | StoredStandard | StoredComponent;

export interface Model {
  specs: StoredSpec[];
  standards: StoredStandard[];
  components?: StoredComponent[];
  workOrders?: WorkOrder[];
  feedback?: StoredFeedback[];
  /** Author of each feedback item (createdBy, else from history). */
  feedbackAuthor?: (id: string) => string | null;
  /** Who accepted a feedback item (principal of the accepting commit), null when unknown / not accepted. */
  feedbackAcceptor?: (id: string) => string | null;
}

export const ACCEPTANCE = 'acceptance';
/** Criteria: acceptance sections (specs) and rules (standards). */
export const isCriterion = (s: Section) => s.type === ACCEPTANCE || s.type === 'rule';
/** Level of a criterion: rules carry one; acceptance criteria are `must`. */
export const levelOf = (s: Section): 'must' | 'should' | 'may' => (s.type === 'rule' ? (s.level ?? 'should') : 'must');

/**
 * Is a standard in force? Drafts never are; `effectiveFrom` (ISO date) in the future means its rules
 * are announced but not required yet. A commit sha counts as reached (it is in this repository's history).
 */
export function standardInForce(std: Pick<StoredStandard, 'status' | 'effectiveFrom'>, now = Date.now()): boolean {
  if (std.status === 'draft') return false;
  if (std.effectiveFrom && /^\d{4}-\d{2}-\d{2}/.test(std.effectiveFrom)) return Date.parse(std.effectiveFrom) <= now;
  return true;
}
export const sectionUri = (kind: Kind, id: string, sid: string) => buildRef({ kind, id, sectionId: sid });
export const docUri = (kind: Kind, id: string) => buildRef({ kind, id });
/**
 * Relations whose target changing matters to the source ("upstream changed"): the source builds on / is bound by the target.
 * `affects` is NOT upstream: a spec section drives the component it affects (the component is downstream, so editing it
 * while delivering the spec never makes the spec outdated). `deviates_from` stays: a waiver is judged against the standard
 * as it was, so a changed standard needs a new look. `extends` stays: the extender inherits the extended section.
 */
export const UPSTREAM_RELS = new Set(['depends_on', 'extends', 'follows', 'deviates_from']);

/**
 * Is this commit part of a work order's own delivery: trailers Work-Order / Caused-By / Request / Feedback naming the work
 * order or one of the requests (`reason`) it acts on?
 */
export function isDeliveryCommit(message: string, wo: { id: string; reason?: string[] }): boolean {
  const lines = message.split('\n');
  const val = (k: string) => lines.filter((l) => l.toLowerCase().startsWith(`${k.toLowerCase()}:`)).flatMap((l) => l.slice(k.length + 1).split(/[\s,]+/).filter(Boolean));
  const reason = wo.reason ?? [];
  return (
    val('Work-Order').includes(wo.id) ||
    val('Caused-By').some((x) => x.replace(/^mandate:\/\//, '').replace(/^work-orders\//, '').split('#')[0] === wo.id || reason.includes(x.replace(/^mandate:\/\//, '').replace(/^(requests|feedback)\//, '').split('#')[0]!)) ||
    [...val('Request'), ...val('Feedback')].some((x) => reason.includes(x))
  );
}
/** Relations that may not point at a superseded section when added. */
export const NO_SUPERSEDED_RELS = new Set(['follows', 'extends', 'depends_on']);

export function finder(m: Pick<Model, 'specs' | 'standards' | 'components'>) {
  const specs = new Map(m.specs.map((d) => [d.id, d]));
  const stds = new Map(m.standards.map((d) => [d.id, d]));
  const comps = new Map((m.components ?? []).map((d) => [d.id, d]));
  const doc = (kind: string, id: string): Doc | undefined =>
    kind === 'specs' ? specs.get(id) : kind === 'standards' ? stds.get(id) : kind === 'components' ? comps.get(id) : undefined;
  /** Resolve a link target: the document and (for section targets) the section. */
  const target = (uri: string) => {
    const t = parseLinkTarget(uri);
    if (!t || (t.kind !== 'specs' && t.kind !== 'standards' && t.kind !== 'components')) return null;
    const d = doc(t.kind, t.id);
    const section = t.sectionId ? d?.sections.find((s) => s.id === t.sectionId) : undefined;
    return { kind: t.kind as Kind, id: t.id, sectionId: t.sectionId, doc: d, section };
  };
  return { specs, stds, comps, doc, target };
}

/** Components a spec touches: `affects` links of its sections and the owners of the code its sections reference. */
export function specComponents(spec: Pick<StoredSpec, 'sections'>, m: Pick<Model, 'components'>, sectionIds?: string[]): { id: string; kind: string; via: ('affects' | 'owns')[]; sections: string[] }[] {
  const out = new Map<string, { id: string; kind: string; via: ('affects' | 'owns')[]; sections: string[] }>();
  const comps = m.components ?? [];
  const add = (c: StoredComponent, via: 'affects' | 'owns', section: string) => {
    const e = out.get(c.id) ?? { id: c.id, kind: c.kind, via: [], sections: [] };
    if (!e.via.includes(via)) e.via.push(via);
    if (!e.sections.includes(section)) e.sections.push(section);
    out.set(c.id, e);
  };
  for (const s of spec.sections) {
    if (s.archived || (sectionIds && !sectionIds.includes(s.id))) continue;
    for (const l of s.links) {
      const t = parseLinkTarget(l.to);
      const c = l.rel === 'affects' && t?.kind === 'components' ? comps.find((x) => x.id === t.id) : undefined;
      if (c) add(c, 'affects', s.id);
    }
    for (const r of s.refs) {
      const o = ownerOf(r.repo, r.path, comps);
      if (!o) continue;
      add(o.component, 'owns', s.id);
      // Code a child owns rolls up to its containing components.
      for (const a of componentAncestors(o.component.id, comps)) if (a.status !== 'archived') add(a, 'owns', s.id);
    }
  }
  return [...out.values()];
}

/** Is the document archived (specs only have a status)? */
export const docArchived = (d: Doc | undefined) => !!d && 'status' in d && (d as StoredSpec).status === 'archived';

/** Live `supersedes` links: target section URI -> superseding section URIs (sources not archived). */
export function liveSuccessors(m: Pick<Model, 'specs' | 'standards' | 'components'>): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const [kind, docs] of [['specs', m.specs], ['standards', m.standards], ['components', m.components ?? []]] as const) {
    for (const d of docs) {
      // MW-8: a deprecated standard's sections are no longer live successors (its own successor replaces it).
      if (docArchived(d) || (kind === 'standards' && (d as StoredStandard).status === 'deprecated')) continue;
      for (const s of d.sections) {
        if (s.archived) continue;
        for (const l of s.links) if (l.rel === 'supersedes') out.set(l.to, [...(out.get(l.to) ?? []), sectionUri(kind, d.id, s.id)]);
      }
    }
  }
  return out;
}

/** Specs a spec depends on, derived from its sections' depends_on links (archived sections ignored). */
export function derivedDependsOn(spec: StoredSpec): string[] {
  const out = new Set<string>();
  for (const s of spec.sections) {
    if (s.archived) continue;
    for (const l of s.links) {
      const t = parseLinkTarget(l.to);
      if (l.rel === 'depends_on' && t?.kind === 'specs' && t.id !== spec.id) out.add(t.id);
    }
  }
  return [...out];
}

/** depends_on target state: blocked (not implemented yet) or broken (missing / archived). */
export function dependencyState(uri: string, f: ReturnType<typeof finder>): 'ok' | 'blocked' | 'broken' {
  const t = f.target(uri);
  // A whole component is a valid dependency target; an archived component (or section) is a broken one.
  if (!t || !t.doc || (!t.section && t.kind !== 'components') || t.section?.archived || docArchived(t.doc)) return 'broken';
  return t.kind === 'specs' && !t.section?.implementedCommit ? 'blocked' : 'ok';
}

/* ---------------------------------------------------------------- criteria inheritance */

export interface InheritedCriterion {
  standard: StoredStandard;
  section: Section;
  uri: string;
  /** The standard is not in force yet (effectiveFrom ahead): announced, never gating. */
  upcoming?: boolean;
  /** Provenance, e.g. ['follows mandate://standards/x', 'x/rules', 'extends', 'y/ac-1']. */
  path: string[];
}

/**
 * Criteria a link target brings: a whole standard brings all its criteria; a standard section brings
 * itself (when it is a criterion) plus the criteria listed in its `verifiedBy`; `extends` links of the
 * sections involved add their targets' criteria (cycle-safe). Archived sections and draft... ignored.
 */
export function criteriaOf(uri: string, f: ReturnType<typeof finder>, path: string[] = [], seen = new Set<string>()): InheritedCriterion[] {
  if (seen.has(uri)) return [];
  seen.add(uri);
  const t = f.target(uri);
  if (!t || t.kind !== 'standards' || !t.doc) return [];
  const std = t.doc as StoredStandard;
  if (std.status === 'draft') return []; // draft standards never apply
  const upcoming = !standardInForce(std);
  const out: InheritedCriterion[] = [];
  const sections = t.sectionId ? (t.section ? [t.section] : []) : std.sections;
  for (const s of sections) {
    if (s.archived) continue;
    const own = isCriterion(s) ? [s] : [];
    const listed = s.verifiedBy.map((id) => std.sections.find((x) => x.id === id)).filter((x): x is Section => !!x && !x.archived && isCriterion(x));
    for (const c of [...own, ...listed]) {
      const cu = sectionUri('standards', std.id, c.id);
      if (out.some((o) => o.uri === cu)) continue;
      out.push({ standard: std, section: c, uri: cu, path: [...path, `${std.id}/${c.id}`], ...(upcoming ? { upcoming } : {}) });
    }
    for (const l of s.links) {
      if (l.rel !== 'extends') continue;
      for (const c of criteriaOf(l.to, f, [...path, `${std.id}/${s.id}`, 'extends'], seen)) if (!out.some((o) => o.uri === c.uri)) out.push(c);
    }
  }
  return out;
}

export interface Approval {
  feedback?: string;
  by?: string;
}

/**
 * Approval policy (user decision): the feedback behind a waiver, exemption or criteria removal must be filed AND accepted
 * by someone other than its writer (`waiver_self_approved`), unless the acceptance carries an approval override
 * (feedback_accept override: true + overrideReason; only the sole active user or an admin). The switch
 * exists for tests only.
 */
export const waiverPolicy = { acceptorMustDiffer: true };

/** Normalised identity (trimmed, case-folded): `Giulia` and ` giulia ` are one person; the id of the user / agent node. */
export const principalKey = (who: string) => foldIdentity(who);
export const samePrincipal = (a: string, b: string) => principalKey(a) === principalKey(b);

/** Is a waiver / exemption approved: accepted (or applied) feedback by someone other than the author of the waiver. */
export function approval(a: Approval, m: Model): WaiverState {
  if (!a.feedback) return { effective: false, reason: 'no_feedback' };
  // The user's approval: an answered approval question (`ask-NNNN`), validated when the write was made.
  if (/^ask-/.test(a.feedback)) return { effective: true, feedback: a.feedback };
  const fb = m.feedback?.find((x) => x.id === a.feedback);
  if (!fb) return { effective: false, reason: 'feedback_missing', feedback: a.feedback };
  const ok = fb.status === 'accepted' || (fb.status === 'closed' && fb.resolution === 'applied');
  if (!ok) return { effective: false, reason: 'not_accepted', feedback: a.feedback };
  // An approval override (recorded, warned on by integrity) lets the accepter approve its own waiver.
  if (fb.approvalOverride && a.by) return { effective: true, feedback: a.feedback };
  // MW-2: principals, not client strings: the user else the agent identity, trimmed and case-folded.
  const author = m.feedbackAuthor?.(fb.id) ?? fb.createdByUser ?? fb.createdBy ?? null;
  if (!a.by || !author || samePrincipal(author, a.by)) return { effective: false, reason: 'same_author', feedback: a.feedback };
  // The acceptance must come from someone other than the writer of the waiver as well.
  const acceptor = waiverPolicy.acceptorMustDiffer ? (m.feedbackAcceptor?.(fb.id) ?? null) : null;
  if (acceptor && samePrincipal(acceptor, a.by)) return { effective: false, reason: 'self_approved', feedback: a.feedback };
  return { effective: true, feedback: a.feedback };
}

/** Effective exemptions of a spec (approved ones only). */
export function effectiveExemptions(spec: StoredSpec, m: Model): Exemption[] {
  return (spec.exemptFrom ?? []).filter((e) => approval({ feedback: e.feedback, by: e.by }, m).effective);
}

export interface SpecCriteria {
  /** Inherited criteria with the spec sections that follow them ([] = applies to the whole spec via appliesTo). */
  inherited: (InheritedCriterion & { sections: string[]; spec: boolean })[];
  /** Waivers: criterion uri -> waiver (deviating section, note, approval state). */
  waivers: Map<string, { section: string; note: string; feedback?: string; state: WaiverState; effectiveSections: string[] }>;
  /** Standards in force and how. */
  standards: { id: string; title: string | null; sections: { id: string; target: string }[]; appliesBy: string[]; exempt?: boolean }[];
}

/** Criteria a spec inherits (attached to the following sections, or spec-wide via appliesTo) and its waivers. */
export function specCriteria(spec: StoredSpec, m: Model): SpecCriteria {
  const f = finder(m);
  const byUri = new Map<string, InheritedCriterion & { sections: string[]; spec: boolean }>();
  const standards = new Map<string, SpecCriteria['standards'][number]>();
  const stdEntry = (id: string) => {
    if (!standards.has(id)) standards.set(id, { id, title: f.stds.get(id)?.title ?? null, sections: [], appliesBy: [] });
    return standards.get(id)!;
  };
  // A rule's scope narrows where it applies: it needs code (refs) of the following sections, or of the
  // spec for spec-wide criteria, inside its scope. Without any code refs there is nothing to narrow.
  const refPaths = (sections: string[] | null) =>
    spec.sections.filter((s) => !s.archived && (!sections || sections.includes(s.id))).flatMap((s) => s.refs.map((r) => r.path));
  const inScopeOf = (c: InheritedCriterion, section: string | null) => {
    const sc = c.section.scope;
    if (!sc || (!sc.paths?.length && !sc.languages?.length)) return true;
    const paths = refPaths(section ? [section] : null);
    return !paths.length || paths.some((p) => inScope(sc, p));
  };
  // G-8: an explicit `follows` brings all criteria of its target (a whole standard: all its rules); scope narrows
  // only what appliesTo brings (and `rulesForCode`), so the rule set, the gate and the audit plan agree.
  const add = (c: InheritedCriterion, section: string | null, explicit = false) => {
    if (!explicit && !inScopeOf(c, section)) return;
    const cur = byUri.get(c.uri) ?? { ...c, sections: [], spec: false };
    if (section) {
      if (!cur.sections.includes(section)) cur.sections.push(section);
    } else cur.spec = true;
    byUri.set(c.uri, cur);
  };
  for (const s of spec.sections) {
    if (s.archived) continue;
    for (const l of s.links) {
      if (l.rel !== 'follows') continue;
      const t = parseLinkTarget(l.to);
      if (t?.kind !== 'standards') continue;
      stdEntry(t.id).sections.push({ id: s.id, target: l.to });
      for (const c of criteriaOf(l.to, f, [`${s.id} follows ${t.sectionId ? `${t.id}/${t.sectionId}` : t.id}`])) add(c, s.id, true);
    }
  }
  const exempt = new Set(effectiveExemptions(spec, m).map((e) => e.standard));
  const touched = specComponents(spec, m);
  for (const std of m.standards) {
    if (std.status === 'draft') continue;
    const rules = matchingAppliesTo(std.appliesTo, spec, touched);
    if (!rules.length) continue;
    if (exempt.has(std.id)) {
      stdEntry(std.id).exempt = true;
      continue;
    }
    stdEntry(std.id).appliesBy.push(...rules);
    for (const c of criteriaOf(docUri('standards', std.id), f, [`appliesTo ${rules.join(', ')}`])) add(c, null);
  }
  // Waivers: a deviates_from link waives the criteria its target brings (C2.3), when approved and unchanged since.
  const waivers: SpecCriteria['waivers'] = new Map();
  for (const s of spec.sections) {
    if (s.archived) continue;
    for (const l of s.links) {
      if (l.rel !== 'deviates_from') continue;
      const waived = criteriaOf(l.to, f);
      let state = approval({ feedback: l.feedback, by: l.by }, m);
      if (state.effective && l.pin && l.pin !== criteriaHash(waived.map((c) => c.section))) state = { effective: false, reason: 'stale', feedback: l.feedback };
      for (const c of waived) {
        const prev = waivers.get(c.uri);
        const effectiveSections = [...(prev?.effectiveSections ?? []), ...(state.effective ? [s.id] : [])];
        if (!prev || (!prev.state.effective && state.effective)) waivers.set(c.uri, { section: s.id, note: l.note ?? '', ...(l.feedback ? { feedback: l.feedback } : {}), state, effectiveSections });
        else prev.effectiveSections = effectiveSections;
      }
    }
  }
  return { inherited: [...byUri.values()], waivers, standards: [...standards.values()].filter((x) => x.sections.length || x.appliesBy.length || x.exempt) };
}

/**
 * Live sections of a spec without any criterion: an acceptance section covers itself; another section is covered by a
 * live acceptance section it lists in `verifiedBy`, or by inherited criteria attached to it (it follows a standard /
 * rule). The ready gate requires none.
 */
export function sectionsWithoutCriteria(spec: StoredSpec, m: Model): string[] {
  const live = spec.sections.filter((s) => !s.archived);
  const criteria = new Set(live.filter((s) => s.type === ACCEPTANCE).map((s) => s.id));
  const inherited = new Set(specCriteria(spec, m).inherited.flatMap((c) => c.sections));
  return live.filter((s) => s.type !== ACCEPTANCE && !s.verifiedBy.some((v) => criteria.has(v)) && !inherited.has(s.id)).map((s) => s.id);
}

/** Pin of a waiver: hash of the criteria its target brings (stored on the link when approved). */
export const waiverPin = (to: string, m: Pick<Model, 'specs' | 'standards'>) => criteriaHash(criteriaOf(to, finder(m)).map((c) => c.section));

/* ---------------------------------------------------------------- cycles and graph integrity */

export interface GraphProblem {
  rule: string;
  uri: string;
  message: string;
  /** Every node involved (cycle members, the superseded target and its successors). */
  nodes?: string[];
}

/** A cycle through one of the `focus` nodes (MW-3: an unrelated cycle elsewhere never hides it). */
function cycleThrough(edges: Map<string, string[]>, focus: (uri: string) => boolean): string[] | null {
  for (const start of edges.keys()) {
    if (!focus(start)) continue;
    // DFS from start's successors back to start (paths recorded as parents).
    const parent = new Map<string, string>();
    const stack = [...(edges.get(start) ?? [])].map((n) => [n, start] as const);
    while (stack.length) {
      const [n, from] = stack.pop()!;
      if (parent.has(n)) continue;
      parent.set(n, from);
      if (n === start) {
        const path: string[] = [];
        for (let x = from; x !== start; x = parent.get(x)!) path.push(x);
        return [start, ...path.reverse(), start];
      }
      for (const m of edges.get(n) ?? []) if (!parent.has(m)) stack.push([m, n]);
    }
  }
  return null;
}

const short = (u: string) => u.replace('mandate://', '');

/**
 * Combined dependency graph check: section depends_on edges plus the derived spec -> spec edges
 * (a spec depends on a spec when one of its sections depends on one of the other's sections);
 * `extends` acyclic at document level among standards; `supersedes` acyclic with at most one live successor.
 */
export function graphProblems(m: Pick<Model, 'specs' | 'standards' | 'components'>, focus?: (uri: string) => boolean): GraphProblem[] {
  const out: GraphProblem[] = [];
  // With a focus (a write): every cycle through the focused nodes, each graph checked on its own (MW-3).
  const cycle = (edges: Map<string, string[]>) => (focus ? cycleThrough(edges, focus) : findCycle(edges));
  const sec = new Map<string, string[]>();
  const docs = new Map<string, string[]>();
  for (const spec of m.specs) {
    const specKey = docUri('specs', spec.id);
    for (const s of spec.sections) {
      if (s.archived) continue;
      const deps = s.links.filter((l) => l.rel === 'depends_on').map((l) => l.to);
      if (deps.length) sec.set(sectionUri('specs', spec.id, s.id), deps);
    }
    const d = derivedDependsOn(spec).map((id) => docUri('specs', id));
    if (d.length) docs.set(specKey, d);
  }
  const c1 = cycle(sec);
  if (c1) out.push({ rule: 'depends_on_cycle', uri: c1[0]!, message: `depends_on cycle: ${c1.map(short).join(' -> ')}`, nodes: c1 });
  if (!c1 || focus) {
    const c2 = cycle(docs);
    if (c2) out.push({ rule: 'depends_on_cycle', uri: c2[0]!, message: `spec dependency cycle (from section depends_on links): ${c2.map(short).join(' -> ')}`, nodes: c2 });
  }
  // Component dependencies: acyclic at section and component level (checked separately from specs).
  const csec = new Map<string, string[]>();
  const cdoc = new Map<string, string[]>();
  for (const c of m.components ?? []) {
    const targets = new Set<string>();
    for (const s of c.sections) {
      if (s.archived) continue;
      const deps = s.links.filter((l) => l.rel === 'depends_on').map((l) => l.to);
      if (deps.length) csec.set(sectionUri('components', c.id, s.id), deps.filter((d) => d.includes('/sections/')));
      for (const d of deps) {
        const t = parseLinkTarget(d);
        if (t?.kind === 'components' && t.id !== c.id) targets.add(docUri('components', t.id));
      }
    }
    if (targets.size) cdoc.set(docUri('components', c.id), [...targets]);
  }
  const c5 = cycle(csec) ?? cycle(cdoc);
  if (c5) out.push({ rule: 'component_cycle', uri: c5[0]!, message: `component depends_on cycle: ${c5.map(short).join(' -> ')}`, nodes: c5 });
  // Containment (parent): a tree, so the parent chain never comes back to the component.
  const parents = new Map<string, string[]>();
  for (const c of m.components ?? []) if (c.parent) parents.set(docUri('components', c.id), [docUri('components', c.parent)]);
  const c6 = cycle(parents);
  if (c6) out.push({ rule: 'contains_cycle', uri: c6[0]!, message: `component containment cycle (parent): ${c6.map(short).join(' -> ')}`, nodes: c6 });
  const ext = new Map<string, string[]>();
  for (const std of m.standards) {
    const targets = new Set<string>();
    for (const s of std.sections) for (const l of s.links) if (l.rel === 'extends') targets.add(docUri('standards', parseLinkTarget(l.to)?.id ?? ''));
    targets.delete(docUri('standards', std.id));
    if (targets.size) ext.set(docUri('standards', std.id), [...targets]);
  }
  const c3 = cycle(ext);
  if (c3) out.push({ rule: 'extends_cycle', uri: c3[0]!, message: `extends cycle between standards: ${c3.map(short).join(' -> ')}`, nodes: c3 });
  const sup = new Map<string, string[]>();
  for (const [kind, list] of [['specs', m.specs], ['standards', m.standards]] as const)
    for (const d of list) for (const s of d.sections) for (const l of s.links) if (l.rel === 'supersedes') sup.set(sectionUri(kind, d.id, s.id), [...(sup.get(sectionUri(kind, d.id, s.id)) ?? []), l.to]);
  const c4 = cycle(sup);
  if (c4) out.push({ rule: 'supersedes_cycle', uri: c4[0]!, message: `supersedes cycle: ${c4.map(short).join(' -> ')}`, nodes: c4 });
  for (const [target, sources] of liveSuccessors(m)) {
    if (sources.length > 1) out.push({ rule: 'supersedes_successors', uri: target, message: `${short(target)} has ${sources.length} live successors (${sources.map(short).join(', ')}); at most one is allowed`, nodes: [target, ...sources] });
  }
  return out;
}

/** Open work orders that change a section (implement / update) by "spec/section". */
export function openChangingOrders(orders: WorkOrder[]): Map<string, WorkOrder[]> {
  const out = new Map<string, WorkOrder[]>();
  for (const w of orders) {
    if (!OPEN_WORK_ORDER_STATUSES.includes(w.status) || (w.kind !== 'implement' && w.kind !== 'update')) continue;
    for (const s of w.sections) if (s.status === 'pending') out.set(`${w.spec}/${s.id}`, [...(out.get(`${w.spec}/${s.id}`) ?? []), w]);
  }
  return out;
}

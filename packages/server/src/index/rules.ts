/**
 * The rules side of the graph. Rule sections of standards are `Rule` nodes (section + type rule, with level, scope,
 * check, rationale, examples). Derived edges (temporal, recomputed whenever specs or standards change):
 *   - governs:        rule -> code file (and standard -> code file via appliesTo path:/lang:) for files known to the graph;
 *                     other paths are matched at query time with the same predicate;
 *   - inherits_rule:  spec section (or spec, spec-wide) -> rule, as the spec's criteria inherit it (follows, extends,
 *                     appliesTo; scope-narrowed), computed with the same `specCriteria` as verification and `rulesForCode`.
 * The predicates are shared with `storage/rules.ts`, so the graph and `rulesForCode` agree (tested for equivalence).
 */
import { buildNodeUri, buildRef, globMatch, inScope, languageOf, ownerOf, rulesForCodeInputSchema, type RulesForCodeInput, type Section, type StoredStandard } from '@mandate/shared';
import { levelOf, specCriteria, standardInForce, type Model } from '../storage/model.js';
import { standardScope } from '../storage/rules.js';
import { parseJson, type DB } from './db.js';
import type { EdgeRow } from './extract.js';

export interface CodeFile {
  repo: string;
  path: string;
}

type StdLike = Pick<StoredStandard, 'status' | 'effectiveFrom' | 'appliesTo'>;
type RuleLike = Pick<Section, 'type' | 'archived' | 'scope'>;

const norm = (p: string) => p.replace(/^\/+/, '');

/** Does a rule of an in-force standard govern `path` (in `repo`, when given)? Same predicate as `rulesForCode`. */
export function ruleGoverns(std: StdLike, rule: RuleLike, repo: string | undefined, path: string): boolean {
  if (!standardInForce(std) || rule.type !== 'rule' || rule.archived) return false;
  const scope = standardScope(std);
  if (repo && scope.repos.length && !scope.repos.includes(repo)) return false;
  const paths = rule.scope?.paths?.length ? rule.scope.paths : scope.paths.length ? scope.paths : undefined;
  const languages = rule.scope?.languages?.length ? rule.scope.languages : scope.languages.length ? scope.languages : undefined;
  if (!paths && !languages) return false; // unscoped rules apply through specs, not to every file
  return inScope({ paths, languages }, norm(path)) && (!languages || languages.includes(languageOf(path) ?? ''));
}

/** A standard's own code scope (appliesTo path: / lang:) covers the file. */
export function standardGoverns(std: StdLike, repo: string, path: string): boolean {
  if (!standardInForce(std)) return false;
  const scope = standardScope(std);
  if (scope.repos.length && !scope.repos.includes(repo)) return false;
  if (!scope.paths.length && !scope.languages.length) return false;
  return inScope({ paths: scope.paths.length ? scope.paths : undefined, languages: scope.languages.length ? scope.languages : undefined }, norm(path));
}

/** Code files known to the graph at this state: section refs and rule examples. */
export function knownFiles(m: Pick<Model, 'specs' | 'standards' | 'components'>): CodeFile[] {
  const out = new Map<string, CodeFile>();
  const add = (repo: string, path: string) => out.set(`${repo}\u0000${norm(path)}`, { repo, path: norm(path) });
  for (const d of [...m.specs, ...m.standards, ...(m.components ?? [])]) {
    for (const s of d.sections) {
      for (const r of s.refs) add(r.repo, r.path);
      for (const ex of s.examples ?? []) {
        const m2 = /^mandate:\/\/code\/([^/@#]+)(?:@[0-9a-f]+)?\/([^#]+)/.exec(ex);
        if (m2) add(decodeURIComponent(m2[1]!), m2[2]!.split('/').map(decodeURIComponent).join('/'));
      }
    }
  }
  return [...out.values()];
}

/** Derived rule edges of a whole-repository state (governs, inherits_rule). */
export function ruleEdges(m: Model): EdgeRow[] {
  const out: EdgeRow[] = [];
  const files = knownFiles(m);
  for (const std of m.standards) {
    const stdUri = buildRef({ kind: 'standards', id: std.id });
    for (const f of files) {
      const file = buildNodeUri({ kind: 'code', repo: f.repo, path: f.path });
      if (standardGoverns(std, f.repo, f.path)) out.push({ from: stdUri, to: file, kind: 'governs', props: { via: 'appliesTo' } });
      for (const s of std.sections) {
        if (ruleGoverns(std, s, f.repo, f.path)) out.push({ from: buildRef({ kind: 'standards', id: std.id, sectionId: s.id }), to: file, kind: 'governs', props: { level: levelOf(s) } });
      }
    }
  }
  for (const spec of m.specs) {
    if (spec.status === 'archived') continue;
    let crit;
    try {
      crit = specCriteria(spec, m);
    } catch {
      continue;
    }
    for (const c of crit.inherited) {
      if (c.upcoming || c.section.type !== 'rule') continue;
      const rule = buildRef({ kind: 'standards', id: c.standard.id, sectionId: c.section.id });
      const props = { level: levelOf(c.section), ...(c.path?.length ? { path: c.path } : {}) };
      if (c.spec) out.push({ from: buildRef({ kind: 'specs', id: spec.id }), to: rule, kind: 'inherits_rule', props: { ...props, specWide: true } });
      for (const sid of c.sections) out.push({ from: buildRef({ kind: 'specs', id: spec.id, sectionId: sid }), to: rule, kind: 'inherits_rule', props });
    }
  }
  return out;
}

/** Code ranges known to the graph (refs with lines, rule examples with lines). */
function knownRanges(m: Pick<Model, 'specs' | 'standards' | 'components'>): (CodeFile & { start: number; end: number })[] {
  const out = new Map<string, CodeFile & { start: number; end: number }>();
  for (const d of [...m.specs, ...m.standards, ...(m.components ?? [])]) {
    for (const s of d.sections) {
      for (const r of s.refs) {
        if (!r.lines) continue;
        const [a, b] = r.lines.split('-').map(Number) as [number, number?];
        out.set(`${r.repo}\u0000${norm(r.path)}#${a}-${b ?? a}`, { repo: r.repo, path: norm(r.path), start: a, end: b ?? a });
      }
      for (const ex of s.examples ?? []) {
        const x = /^mandate:\/\/code\/([^/@#]+)(?:@[0-9a-f]+)?\/([^#]+)#L(\d+)(?:-L(\d+))?$/.exec(ex);
        if (!x) continue;
        const path = x[2]!.split('/').map(decodeURIComponent).join('/');
        out.set(`${x[1]}\u0000${path}#${x[3]}-${x[4] ?? x[3]}`, { repo: decodeURIComponent(x[1]!), path, start: Number(x[3]), end: Number(x[4] ?? x[3]) });
      }
    }
  }
  return [...out.values()];
}

/**
 * Component edges of a whole-repository state: `contains` (parent -> child component), `owns` (component -> every known file one of its globs matches) and
 * `owned_by` (known file / code range -> the owning component: the most specific glob wins, as `ownerOf` in storage).
 */
export function componentEdges(m: Model): EdgeRow[] {
  const out: EdgeRow[] = [];
  // Containment: parent -> child (`contains`; reverse `contained_in`), archived ones included (they stay resolvable).
  const all = m.components ?? [];
  for (const c of all) if (c.parent && c.parent !== c.id && all.some((x) => x.id === c.parent)) out.push({ from: buildRef({ kind: 'components', id: c.parent }), to: buildRef({ kind: 'components', id: c.id }), kind: 'contains', props: {} });
  // Archived components own nothing (their owns globs no longer claim code).
  const comps = all.filter((c) => c.status !== 'archived');
  if (!comps.length) return out;
  for (const f of knownFiles(m)) {
    const file = buildNodeUri({ kind: 'code', repo: f.repo, path: f.path });
    for (const c of comps) {
      const globs = c.owns.filter((o) => o.repo === f.repo).flatMap((o) => o.paths).filter((g) => globMatch(g, f.path));
      if (globs.length) out.push({ from: buildRef({ kind: 'components', id: c.id }), to: file, kind: 'owns', props: { globs } });
    }
    const owner = ownerOf(f.repo, f.path, comps);
    if (owner) out.push({ from: file, to: buildRef({ kind: 'components', id: owner.component.id }), kind: 'owned_by', props: { glob: owner.glob } });
  }
  for (const r of knownRanges(m)) {
    const owner = ownerOf(r.repo, r.path, comps);
    if (!owner) continue;
    out.push({ from: buildNodeUri({ kind: 'code', repo: r.repo, path: r.path, lines: { start: r.start, end: r.end } }), to: buildRef({ kind: 'components', id: owner.component.id }), kind: 'owned_by', props: { glob: owner.glob } });
  }
  return out;
}

/** The owning component of a path from the graph: materialised `owned_by` for a known file, else the Component nodes' globs. */
export function graphOwnerOf(db: DB, repo: string | undefined, path: string): { component: string; glob: string } | null {
  const p = norm(path);
  if (repo) {
    const file = buildNodeUri({ kind: 'code', repo, path: p });
    const e = db.prepare("SELECT to_uri, props FROM edges WHERE kind = 'owned_by' AND from_uri = ? AND valid_to IS NULL").get(file) as { to_uri: string; props: string } | undefined;
    if (e) return { component: e.to_uri, glob: parseJson<{ glob: string }>(e.props, { glob: '' }).glob };
    if (db.prepare("SELECT 1 FROM nodes WHERE uri = ? AND kind = 'code_file'").get(file)) return null;
  }
  const comps = (db.prepare("SELECT uri, props FROM nodes WHERE kind = 'component' AND valid_to IS NULL").all() as { uri: string; props: string }[]).map((r) => {
    const p = parseJson<{ owns?: { repo: string; paths: string[] }[]; status?: string }>(r.props, {});
    return { id: r.uri, owns: p.owns ?? [], status: p.status };
  });
  const o = ownerOf(repo, p, comps);
  return o ? { component: o.component.id, glob: o.glob } : null;
}

/* ---------------------------------------------------------------- query: rules for a code range */

export interface GraphRuleHit {
  uri: string;
  level: 'must' | 'should' | 'may';
  why: ('scope' | 'section')[];
  /** Spec sections that reference this code and inherit the rule. */
  sections: string[];
}

const overlaps = (a?: string | null, b?: string | null) => {
  if (!a || !b) return true;
  const [a1, a2 = a1] = a.split('-').map(Number) as [number, number?];
  const [b1, b2 = b1] = b.split('-').map(Number) as [number, number?];
  return a1! <= b2! && b1! <= a2!;
};

/**
 * Rules for a code range, answered from the graph at HEAD: `governs` edges for files the graph knows (glob matching
 * on Rule node props for other paths, or when no repo is given), plus `inherits_rule` from the spec sections whose
 * `references_code` edges overlap the range. Equivalent to `rulesForCode` (storage).
 */
export function graphRulesForCode(db: DB, input: RulesForCodeInput): GraphRuleHit[] {
  const { repo, path, lines } = rulesForCodeInputSchema.parse(input);
  const p = norm(path);
  const hits = new Map<string, GraphRuleHit>();
  const add = (uri: string, level: GraphRuleHit['level'], why: 'scope' | 'section', section?: string) => {
    const h = hits.get(uri) ?? { uri, level, why: [], sections: [] };
    if (!h.why.includes(why)) h.why.push(why);
    if (section && !h.sections.includes(section)) h.sections.push(section);
    hits.set(uri, h);
  };
  const ruleNode = db.prepare("SELECT props FROM nodes WHERE uri = ? AND valid_to IS NULL AND kind = 'section'");
  const levelOfUri = (uri: string) => (parseJson<{ level?: 'must' | 'should' | 'may' }>((ruleNode.get(uri) as { props: string } | undefined)?.props, {}).level ?? 'should');

  // Scope: materialised edges for a known file in a given repo; otherwise evaluate the rules' scopes now.
  const file = repo ? buildNodeUri({ kind: 'code', repo, path: p }) : null;
  const known = file && db.prepare("SELECT 1 FROM nodes WHERE uri = ? AND kind = 'code_file'").get(file);
  if (known) {
    const rows = db
      .prepare("SELECT from_uri FROM edges WHERE kind = 'governs' AND to_uri = ? AND valid_to IS NULL AND from_uri LIKE 'mandate://standards/%/sections/%'")
      .all(file) as { from_uri: string }[];
    for (const r of rows) add(r.from_uri, levelOfUri(r.from_uri), 'scope');
  } else {
    const stds = db.prepare("SELECT uri, props FROM nodes WHERE kind = 'standard' AND valid_to IS NULL").all() as { uri: string; props: string }[];
    const sections = db.prepare("SELECT n.uri, n.props FROM edges e JOIN nodes n ON n.uri = e.to_uri AND n.valid_to IS NULL WHERE e.kind = 'has_section' AND e.from_uri = ? AND e.valid_to IS NULL");
    for (const s of stds) {
      const std = parseJson<StdLike>(s.props, { status: 'active', appliesTo: [] } as never);
      for (const sec of sections.all(s.uri) as { uri: string; props: string }[]) {
        const rule = parseJson<RuleLike & { level?: 'must' | 'should' | 'may' }>(sec.props, {} as never);
        if (ruleGoverns({ ...std, appliesTo: std.appliesTo ?? [] }, rule, repo, p)) add(sec.uri, rule.level ?? 'should', 'scope');
      }
    }
  }

  // Inherited: spec sections whose code references overlap the range.
  const refs = db
    .prepare(
      `SELECT e.from_uri AS section, json_extract(c.props, '$.repo') AS repo, json_extract(c.props, '$.path') AS path,
              json_extract(c.props, '$.lineStart') AS a, json_extract(c.props, '$.lineEnd') AS b
         FROM edges e JOIN nodes c ON c.uri = e.to_uri AND c.valid_to IS NULL
        WHERE e.kind = 'references_code' AND e.valid_to IS NULL AND e.from_uri LIKE 'mandate://specs/%'`,
    )
    .all() as { section: string; repo: string; path: string; a: number | null; b: number | null }[];
  const sectionNode = db.prepare('SELECT props FROM nodes WHERE uri = ? AND valid_to IS NULL');
  const inherited = db.prepare("SELECT to_uri, props FROM edges WHERE kind = 'inherits_rule' AND from_uri = ? AND valid_to IS NULL");
  const referencing = new Set<string>();
  for (const r of refs) {
    if ((repo && r.repo !== repo) || norm(String(r.path)) !== p) continue;
    if (!overlaps(r.a ? `${r.a}-${r.b ?? r.a}` : null, lines)) continue;
    if (parseJson<{ archived?: boolean }>((sectionNode.get(r.section) as { props: string } | undefined)?.props, {}).archived) continue;
    const doc = r.section.replace(/\/sections\/.*$/, '');
    if (parseJson<{ status?: string }>((sectionNode.get(doc) as { props: string } | undefined)?.props, {}).status === 'archived') continue;
    referencing.add(r.section);
  }
  for (const section of referencing) {
    const doc = section.replace(/\/sections\/.*$/, '');
    for (const from of [section, doc]) {
      for (const e of inherited.all(from) as { to_uri: string; props: string }[]) {
        add(e.to_uri, parseJson<{ level?: GraphRuleHit['level'] }>(e.props, {}).level ?? levelOfUri(e.to_uri), 'section', section);
      }
    }
  }
  const order = { must: 0, should: 1, may: 2 };
  return [...hits.values()].sort((a, b) => order[a.level] - order[b.level] || a.uri.localeCompare(b.uri));
}

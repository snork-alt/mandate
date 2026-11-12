import { buildRef, inScope, languageOf, rulesForCodeInputSchema, type RuleHit, type RulesForCodeInput, type StoredStandard } from '@mandate/shared';
import { levelOf, sectionUri, specCriteria, standardInForce, type Model } from './model.js';

const overlaps = (a?: string, b?: string) => {
  if (!a || !b) return true;
  const [a1, a2 = a1] = a.split('-').map(Number) as [number, number?];
  const [b1, b2 = b1] = b.split('-').map(Number) as [number, number?];
  return a1! <= b2! && b1! <= a2!;
};

/** The standard's own code scope: `path:` / `lang:` appliesTo selectors (repo: restricts, tag/category do not apply to code). */
export function standardScope(std: Pick<StoredStandard, 'appliesTo'>) {
  const sel = (k: string) => std.appliesTo.filter((a) => a.startsWith(`${k}:`)).map((a) => a.slice(k.length + 1));
  return { paths: sel('path'), languages: sel('lang'), repos: sel('repo') };
}

/**
 * Which rules apply to the code an agent is editing: active rules whose scope (the rule's `scope`,
 * narrowing its standard's `path:` / `lang:` appliesTo) matches the file, plus the rules inherited by
 * spec sections whose code refs point at this code. Draft standards and rules not in force are left out.
 */
export function rulesForCode(input: RulesForCodeInput, m: Model): RuleHit[] {
  const { repo, path, lines } = rulesForCodeInputSchema.parse(input);
  const hits = new Map<string, RuleHit>();
  const add = (std: StoredStandard, sid: string, why: 'scope' | 'section', section?: string) => {
    const sec = std.sections.find((s) => s.id === sid);
    if (!sec || sec.archived) return;
    const uri = sectionUri('standards', std.id, sid);
    const hit =
      hits.get(uri) ??
      ({
        uri,
        standard: buildRef({ kind: 'standards', id: std.id }),
        standardTitle: std.title,
        title: sec.title,
        level: levelOf(sec),
        ...(sec.rationale ? { rationale: sec.rationale } : {}),
        ...(sec.check ? { check: sec.check } : {}),
        why: [],
        sections: [],
        ...(std.status === 'deprecated' ? { deprecated: { supersededBy: std.supersededBy } } : {}),
      } satisfies RuleHit);
    if (!hit.why.includes(why)) hit.why.push(why);
    if (section && !hit.sections.includes(section)) hit.sections.push(section);
    hits.set(uri, hit);
  };
  const lang = languageOf(path);
  for (const std of m.standards) {
    if (!standardInForce(std)) continue;
    const scope = standardScope(std);
    if (repo && scope.repos.length && !scope.repos.includes(repo)) continue;
    const stdPaths = scope.paths.length ? scope.paths : undefined;
    const stdLangs = scope.languages.length ? scope.languages : undefined;
    for (const s of std.sections) {
      if (s.type !== 'rule' || s.archived) continue;
      const paths = s.scope?.paths?.length ? s.scope.paths : stdPaths;
      const languages = s.scope?.languages?.length ? s.scope.languages : stdLangs;
      if (!paths && !languages) continue; // unscoped rules apply through specs, not to every file
      if (inScope({ paths, languages }, path) && (!languages || languages.includes(lang ?? ''))) add(std, s.id, 'scope');
    }
  }
  // Rules inherited by spec sections that reference this code.
  for (const spec of m.specs) {
    if (spec.status === 'archived') continue;
    const referencing = spec.sections.filter((s) => !s.archived && s.refs.some((r) => (!repo || r.repo === repo) && r.path.replace(/^\/+/, '') === path.replace(/^\/+/, '') && overlaps(r.lines, lines))).map((s) => s.id);
    if (!referencing.length) continue;
    for (const c of specCriteria(spec, m).inherited) {
      if (c.upcoming || c.section.type !== 'rule') continue;
      const via = c.spec ? referencing : c.sections.filter((x) => referencing.includes(x));
      for (const sid of via) add(c.standard, c.section.id, 'section', buildRef({ kind: 'specs', id: spec.id, sectionId: sid }));
    }
  }
  const order = { must: 0, should: 1, may: 2 };
  return [...hits.values()].sort((a, b) => order[a.level] - order[b.level] || a.title.localeCompare(b.title));
}

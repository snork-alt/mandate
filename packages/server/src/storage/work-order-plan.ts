/**
 * The full plan of a work order, criteria coverage and the implementation <-> spec links (pure helpers):
 * - `renderPlan`: the structured plan (steps, files, tests mapped to criteria, risks) as markdown for the plan section;
 * - `coveredCriteria` / `checkPlanTests`: the acceptance criteria a work order covers and the tests->criteria mapping;
 * - `applyCodeToSection`: copy the code a work order touched into a spec section's refs / symbols.
 */
import type { CodeRef, PlanTest, Section, StoredSpec, TouchedFile, WorkOrderPlanInput } from '@mandate/shared';

/** The plan as markdown (bold labels, no headings: the plan is one section of the work-order document). */
export function renderPlan(plan: WorkOrderPlanInput): string {
  const out: string[] = ['**Steps**', ...plan.steps.map((s) => `- [ ] ${s}`)];
  if (plan.files?.length) out.push('', '**Files to change**', ...plan.files.map((f) => `- ${f}`));
  if (plan.tests?.length) out.push('', '**Tests**', ...plan.tests.map((t) => `- ${t.name}${t.ref ? ` (\`${t.ref}\`)` : ''} proves: ${t.proves.join(', ')}`));
  if (plan.risks?.length) out.push('', '**Risks**', ...plan.risks.map((r) => `- ${r}`));
  return out.join('\n');
}

/** Acceptance criteria (own, live) a work order covers: targeted acceptance sections and the criteria listed in `verifiedBy` of the other targeted sections. */
export function coveredCriteria(spec: Pick<StoredSpec, 'sections'> | null | undefined, targets: string[]): { id: string; title: string; method?: string }[] {
  if (!spec) return [];
  const live = spec.sections.filter((s) => !s.archived);
  const ids = new Set<string>();
  for (const t of targets) {
    const s = live.find((x) => x.id === t);
    if (!s) continue;
    if (s.type === 'acceptance') ids.add(s.id);
    for (const v of s.verifiedBy ?? []) if (live.some((x) => x.id === v && x.type === 'acceptance')) ids.add(v);
  }
  return [...ids].map((id) => live.find((x) => x.id === id)!).map((s) => ({ id: s.id, title: s.title, ...(s.method ? { method: s.method } : {}) }));
}

/** Problems of a plan's tests against the criteria the work order covers: unknown ids, uncovered criteria. */
export function checkPlanTests(tests: PlanTest[], criteria: { id: string; title: string }[]): string[] {
  const known = new Set(criteria.map((c) => c.id));
  const problems: string[] = [];
  const list = criteria.map((c) => c.id).join(', ') || 'none: the targeted sections have no acceptance criteria';
  for (const t of tests) {
    const unknown = t.proves.filter((p) => !known.has(p));
    if (unknown.length) problems.push(`test "${t.name}" proves ${unknown.join(', ')}: not an acceptance criterion of the targeted sections (criteria: ${list})`);
  }
  const proved = new Set(tests.flatMap((t) => t.proves));
  const missing = criteria.filter((c) => !proved.has(c.id));
  if (missing.length) problems.push(`no planned test proves ${missing.map((c) => c.id).join(', ')}: add a test for each acceptance criterion (plan.tests[].proves)`);
  return problems;
}

const sameRef = (a: CodeRef, b: { repo: string; path: string }) => a.repo === b.repo && a.path === b.path;

/**
 * Merge touched code into a spec section's `refs` / `symbols`: the same path updates its lines, deleted files drop their refs,
 * renamed files move to the new path, symbols are deduplicated. Pure: returns the new arrays.
 */
export function applyCodeToSection(section: Pick<Section, 'refs' | 'symbols'>, code: TouchedFile[]): { refs: CodeRef[]; symbols: string[] } {
  let refs = [...(section.refs ?? [])];
  const symbols = new Set(section.symbols ?? []);
  for (const t of code) {
    if (t.change === 'deleted') {
      refs = refs.filter((r) => !sameRef(r, t));
      for (const s of t.symbols ?? []) symbols.delete(s);
      continue;
    }
    if (t.change === 'renamed' && t.from) refs = refs.map((r) => (sameRef(r, { repo: t.repo, path: t.from! }) ? { ...r, path: t.path } : r));
    const ranges = t.lines?.length ? t.lines : [undefined];
    const hasLines = ranges[0] !== undefined;
    // New lines replace the old lines of that path; without lines an existing ref stays (a path-only ref is added when none exists).
    const existing = refs.filter((r) => sameRef(r, t));
    if (hasLines) refs = refs.filter((r) => !sameRef(r, t));
    else if (existing.length) {
      for (const s of t.symbols ?? []) symbols.add(s);
      continue;
    }
    const commit = t.commits?.at(-1) ?? existing.find((r) => r.commit)?.commit;
    for (const lines of ranges) refs.push({ repo: t.repo, path: t.path, ...(lines ? { lines } : {}), ...(commit ? { commit } : {}) } as CodeRef);
    for (const s of t.symbols ?? []) symbols.add(s);
  }
  refs.sort((a, b) => a.repo.localeCompare(b.repo) || a.path.localeCompare(b.path) || String(a.lines ?? '').localeCompare(String(b.lines ?? ''), undefined, { numeric: true }));
  return { refs, symbols: [...symbols].sort() };
}

/**
 * The three matches of the flow and whether the request acted on them (pure). Order: spec_match -> update the matched
 * spec sections (a new spec only with the decision "no existing spec covers ...") -> standard_match -> `follows` links on
 * the changed sections -> component_match -> update the matched component (a new one only with the decision "no existing
 * component covers ..."). flow_next walks the gaps in this order; work_order_create refuses (flow_out_of_order) while one is open.
 */
import type { Feedback, StoredSpec } from '@mandate/shared';

export type GapStage = 'spec_match' | 'new_spec_decision' | 'standard_match' | 'follows' | 'component_match' | 'component_update';
export interface MatchGap {
  stage: GapStage;
  /** What is missing, as a phrase for the refusal / flow_next. */
  need: string;
}

type Specs = Map<string, Pick<StoredSpec, 'id' | 'sections'>>;

const NEW_SPEC = /no existing spec covers/i;
const decisionAfter = (f: Feedback, re: RegExp, at?: string) => (f.decisions ?? []).some((d) => re.test(d.text) && (!at || d.at >= at));

/** Section ids of specs a request changed (live, from its commits). */
function changedSpecSections(f: Feedback): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const c of f.changes) {
    if (c.kind !== 'specs' || c.action === 'deleted') continue;
    const set = out.get(c.id) ?? new Set<string>();
    for (const s of c.sections) if (s.action !== 'removed') set.add(s.id);
    out.set(c.id, set);
  }
  return out;
}

/** Does a changed spec section follow one of the matched standards? */
export function followsMatched(f: Feedback, specs: Specs): boolean {
  const refs = f.standardMatch?.refs ?? [];
  if (!refs.length) return true;
  for (const [spec, ids] of changedSpecSections(f)) {
    const s = specs.get(spec);
    for (const sec of s?.sections ?? []) {
      if (!ids.has(sec.id)) continue;
      if ((sec.links ?? []).some((l) => l.rel === 'follows' && refs.some((r) => l.to === r || l.to.startsWith(`${r}/`)))) return true;
    }
  }
  return false;
}

/** The first match / decision / update the request still needs before a work order, in flow order. */
export function matchGaps(f: Feedback, specs: Specs): MatchGap[] {
  const gaps: MatchGap[] = [];
  if (!f.specMatch) return [{ stage: 'spec_match', need: `spec_match recorded on it (spec_match { request, for: "${f.id}" })` }];
  if (f.changes.some((c) => c.kind === 'specs' && c.action === 'created') && !decisionAfter(f, NEW_SPEC)) {
    gaps.push({ stage: 'new_spec_decision', need: `a decision for the new spec (request_decision_add { ref: "${f.id}", text: "no existing spec covers ...", reason }); otherwise extend the matched spec sections` });
  }
  if (!f.standardMatch) return [...gaps, { stage: 'standard_match', need: `standard_match recorded on it (standard_match { request, files, for: "${f.id}" })` }];
  if (!followsMatched(f, specs) && !decisionAfter(f, /standard/i, f.standardMatch.at)) {
    gaps.push({ stage: 'follows', need: `a follows link from a changed spec section to a matched standard (${f.standardMatch.refs.slice(0, 3).join(', ')}) or a decision why none applies` });
  }
  if (!f.componentMatch) return [...gaps, { stage: 'component_match', need: `component_match recorded on it (component_match { request, files, for: "${f.id}" })` }];
  if (!f.changes.some((c) => c.kind === 'components') && !decisionAfter(f, /component/i, f.componentMatch.at)) {
    gaps.push({ stage: 'component_update', need: `the matched component updated (owns / interfaces, affects links; addresses: [${f.id}]) or a new one with the decision "no existing component covers ..."` });
  }
  return gaps;
}

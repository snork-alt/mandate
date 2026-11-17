import { MATURITY_OVERLAYS, OVERLAY_TONE, STEP_TONE, MATURITY_LABELS, type MaturityOverlayKind, type MaturityStep, type Spec, type SpecMaturity } from '@mandate/shared';
import { parseRef } from '@mandate/shared/refs';

/** Overlay severity for sorting / aggregation (lower = worse). */
const OVERLAY_RANK: Record<MaturityOverlayKind, number> = { failing: 0, outdated: 1, blocked: 2, archived: 3 };

/** Filter values: a step or an overlay kind. */
export function matchesMaturityFilter(s: { maturity?: SpecMaturity }, f: string[]): boolean {
  if (!f.length) return true;
  const m = s.maturity;
  if (!m) return false;
  return f.some((x) => x === m.step || m.overlays.some((o) => o.kind === x));
}

/**
 * "Maturity" sort: specs needing attention first: any overlay (worst first: failing, outdated, blocked; archived last),
 * then by step ascending (specified first), then title.
 */
export function compareMaturity(a: { maturity?: SpecMaturity; title: string }, b: { maturity?: SpecMaturity; title: string }): number {
  const rank = (m?: SpecMaturity) => {
    const o = m?.overlays[0]?.kind;
    if (!o) return 10;
    return o === 'archived' ? 20 : OVERLAY_RANK[o];
  };
  return rank(a.maturity) - rank(b.maturity) || (a.maturity?.stepIndex ?? 0) - (b.maturity?.stepIndex ?? 0) || a.title.localeCompare(b.title);
}

export const maturityOptions = (specs: { maturity?: SpecMaturity }[]) => [
  ...(['specified', 'in_progress', 'implemented'] as MaturityStep[]).map((s) => ({
    value: s,
    label: MATURITY_LABELS[s],
    tone: STEP_TONE[s],
    count: specs.filter((x) => x.maturity?.step === s).length,
  })),
  ...MATURITY_OVERLAYS.map((o) => ({
    value: o,
    label: o[0]!.toUpperCase() + o.slice(1),
    tone: OVERLAY_TONE[o],
    count: specs.filter((x) => x.maturity?.overlays.some((y) => y.kind === o)).length,
  })),
];

/** Component ids a spec affects (`affects` section links to a component or one of its sections). */
export function affectedComponents(spec: Pick<Spec, 'sections'>): string[] {
  const out = new Set<string>();
  for (const s of spec.sections ?? []) for (const l of s.links ?? []) if (l.rel === 'affects') {
    const r = parseRef(l.to);
    if (r?.kind === 'components') out.add(r.id);
  }
  return [...out];
}

export interface ComponentMaturity {
  /** Least mature step among the (non-archived) specs affecting it. */
  step: MaturityStep;
  stepIndex: number;
  tone: SpecMaturity['tone'];
  /** Worst overlay among them (failing > outdated > blocked), if any. */
  overlay?: MaturityOverlayKind;
  specs: { id: string; title: string; maturity: SpecMaturity }[];
}

/**
 * A component's maturity, derived from the specs affecting it (directly, or one of its children): the least mature
 * step and the worst overlay, so a component reads "verified" only when every spec touching it is.
 */
export function componentMaturity(specs: Spec[], ids: string[]): ComponentMaturity | null {
  const want = new Set(ids);
  const list = specs
    .filter((s) => s.maturity && !s.maturity.overlays.some((o) => o.kind === 'archived') && affectedComponents(s).some((c) => want.has(c)))
    .map((s) => ({ id: s.id, title: s.title, maturity: s.maturity! }));
  if (!list.length) return null;
  const least = list.reduce((a, b) => (b.maturity.stepIndex < a.maturity.stepIndex ? b : a));
  const overlays = list.flatMap((s) => s.maturity.overlays.map((o) => o.kind)).filter((k) => k !== 'archived');
  const overlay = overlays.sort((a, b) => OVERLAY_RANK[a] - OVERLAY_RANK[b])[0];
  return { step: least.maturity.step, stepIndex: least.maturity.stepIndex, tone: overlay ? OVERLAY_TONE[overlay] : STEP_TONE[least.maturity.step], overlay, specs: list };
}

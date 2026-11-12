import { useMemo, type ReactNode } from 'react';
import type { SpecMaturity } from '@mandate/shared';
import { useSpecs } from '../../lib/queries';
import { Tooltip } from '@mantine/core';
import { MATURITY_LABELS } from '@mandate/shared';
import { componentMaturity } from '../../lib/maturity';
import { parseRef } from '@mandate/shared/refs';
import { MaturityDot, MaturityMeter, OVERLAY_LABEL } from './MaturityBadge';

/** Spec id -> maturity, from the cached spec list (`doc_list specs`), for places that only hold a reference. */
export function useSpecMaturities(enabled = true): Map<string, SpecMaturity> {
  const q = useSpecs(enabled);
  return useMemo(() => new Map((q.data ?? []).flatMap((s) => (s.maturity ? [[s.id, s.maturity] as const] : []))), [q.data]);
}

/** "In progress · Failing": the maturity label with its first flag (the one state shown for a spec). */
export const maturityText = (m: SpecMaturity) => `${m.label}${m.overlays[0] ? ` · ${OVERLAY_LABEL[m.overlays[0].kind]}` : ''}`;

/** The maturity of a spec document reference (a spec, not one of its sections), from the cached spec list. */
export function useSpecMaturityOf(uri: string | undefined): SpecMaturity | undefined {
  const r = uri ? parseRef(uri) : null;
  const isSpec = r?.kind === 'specs' && !r.sectionId;
  const map = useSpecMaturities(isSpec);
  return isSpec ? map.get(r!.id) : undefined;
}

/** Small maturity meter for a spec reference (nothing when unknown). */
export function SpecMaturityDot({ id, details = false, fallback = null }: { id: string; details?: boolean; fallback?: ReactNode }) {
  const m = useSpecMaturities().get(id);
  return m ? <MaturityDot m={m} details={details} /> : <>{fallback}</>;
}

/** Architecture: the maturity of a component, derived from the specs affecting it or its children (see componentMaturity). */
export function ComponentMaturityDot({ ids }: { ids: string[] }) {
  const q = useSpecs();
  const cm = useMemo(() => (q.data ? componentMaturity(q.data, ids) : null), [q.data, ids.join()]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!cm) return null;
  const tip = (
    <div>
      <div style={{ fontWeight: 600 }}>
        {MATURITY_LABELS[cm.step]} (least mature of {cm.specs.length} spec{cm.specs.length === 1 ? '' : 's'}){cm.overlay ? ` · ${OVERLAY_LABEL[cm.overlay]}` : ''}
      </div>
      {cm.specs.slice(0, 8).map((s) => (
        <div key={s.id}>
          {s.title}: {s.maturity.label}
          {s.maturity.overlays[0] ? ` · ${OVERLAY_LABEL[s.maturity.overlays[0].kind]}` : ''}
        </div>
      ))}
    </div>
  );
  return (
    <Tooltip label={tip} multiline maw={300} withinPortal>
      <span className="maturity-dot" data-tone={cm.tone} role="img" aria-label={`Maturity: ${MATURITY_LABELS[cm.step]}${cm.overlay ? ` · ${OVERLAY_LABEL[cm.overlay]}` : ''}`}>
        <MaturityMeter stepIndex={cm.stepIndex} tone={cm.tone} audited={cm.step === 'audited'} />
      </span>
    </Tooltip>
  );
}

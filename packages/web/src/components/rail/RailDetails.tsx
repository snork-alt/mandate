import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useRailOptional } from './RailProvider';

/**
 * The right-column content of a document page. Inside the layout it is rendered into the rail's
 * Details tab; standalone (no rail) it keeps the old inline `<aside>`.
 */
export function RailDetails({ children }: { children: ReactNode }) {
  const rail = useRailOptional();
  if (!rail) return <aside className="doc-aside">{children}</aside>;
  return rail.detailsSlot ? createPortal(<div className="rail-details">{children}</div>, rail.detailsSlot) : null;
}

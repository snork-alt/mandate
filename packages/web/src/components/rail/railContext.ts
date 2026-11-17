import { createContext, useContext } from 'react';
import type { RailState } from './RailProvider';

/** The rail's React context, apart from the provider (light imports for components that only read it). */
export const RailCtx = createContext<RailState | null>(null);
/** Null outside a RailProvider (tests, standalone pages). */
export const useRailOptional = () => useContext(RailCtx);
export function useRail(): RailState {
  const v = useContext(RailCtx);
  if (!v) throw new Error('useRail outside RailProvider');
  return v;
}

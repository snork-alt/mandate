import { createContext, useContext } from 'react';
import type { CopyTarget } from '../../lib/refs';

/** Copy target of the enclosing section (for diagram toolbars and chips inside it). */
export const SectionTargetContext = createContext<CopyTarget | null>(null);
export const useSectionTarget = () => useContext(SectionTargetContext);

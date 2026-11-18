import type { Section } from '@mandate/shared';

const isCriterion = (s: Pick<Section, 'type'>) => s.type === 'acceptance' || s.type === 'rule';

/**
 * Display order of a document: description / behaviour sections first (an overview or context section leading, the others in
 * stored order), then every criterion (acceptance criterion, standard rule) in stored order, whatever the stored order is.
 */
export function displayOrder<T extends Pick<Section, 'id' | 'type'>>(sections: T[]): T[] {
  const rest = sections.filter((s) => !isCriterion(s));
  const lead = rest.filter((s) => s.id === 'overview' || s.id === 'context');
  const others = rest.filter((s) => !lead.includes(s));
  return [...lead, ...others, ...sections.filter(isCriterion)];
}

import { IconQuestionMark } from '@tabler/icons-react';
import { getSectionRenderer } from './types';
import { sectionTypeLabel } from './anchors';


export function SectionTypeIcon({ type, size = 14 }: { type: string; size?: number }) {
  const Icon = getSectionRenderer(type)?.icon ?? IconQuestionMark;
  return <Icon size={size} stroke={1.7} style={{ flexShrink: 0 }} aria-label={sectionTypeLabel(type)} />;
}

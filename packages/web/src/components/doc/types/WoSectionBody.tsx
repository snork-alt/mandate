import { WoSectionBody as Body } from '../../work-orders/WoSection';
import type { SectionBodyProps } from './registry';

export default function WoSectionBody({ section }: SectionBodyProps) {
  return <Body section={section} />;
}

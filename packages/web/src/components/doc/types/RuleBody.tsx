import { RuleBody as Body } from '../../rules/RuleParts';
import type { SectionBodyProps } from './registry';

export default function RuleBody({ section }: SectionBodyProps) {
  return <Body section={section} />;
}

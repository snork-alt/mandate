import { AuditItemBody as Body } from '../../audits/AuditItem';
import type { SectionBodyProps } from './registry';

export default function AuditItemBody({ section }: SectionBodyProps) {
  return <Body section={section} />;
}

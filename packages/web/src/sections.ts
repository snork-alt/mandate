import type { IconFileText } from '@tabler/icons-react';
import { KIND_ICON } from './components/refs/kinds';
import type { EntityKind } from '@mandate/shared';

export interface SectionDef {
  kind: EntityKind;
  /** Plural label for navigation / headings. */
  label: string;
  /** Singular label for buttons ("New spec"). */
  singular: string;
  description: string;
  icon: typeof IconFileText;
  /** Count shown in the sidebar (default: number of items). */
  count?: (items: unknown[]) => number;
}

export const SECTIONS: SectionDef[] = [
  {
    kind: 'specs',
    label: 'Specs',
    singular: 'spec',
    description: 'Specifications agents implement against.',
    icon: KIND_ICON.spec,
  },
  {
    kind: 'standards',
    label: 'Standards',
    singular: 'standard',
    description: 'Reusable rule sets and patterns that specs follow.',
    icon: KIND_ICON.standard,
  },
  {
    kind: 'components',
    label: 'Components',
    singular: 'component',
    description: 'The architecture: services, modules and datastores, what they own and depend on.',
    icon: KIND_ICON.component,
  },
  {
    kind: 'audits',
    label: 'Audits',
    singular: 'audit',
    description: 'Audit reports: a coding agent checks the code against a spec or standard.',
    icon: KIND_ICON.audit,
  },
  {
    kind: 'work-orders',
    label: 'Work orders',
    singular: 'work order',
    description: 'Work orders for agents on spec sections, in file order.',
    icon: KIND_ICON.work_order,
  },
  {
    kind: 'feedback',
    label: 'Feedbacks',
    singular: 'feedback item',
    description: 'Why specs and standards change: ambiguities, conflicts, bugs and ideas.',
    icon: KIND_ICON.feedback,
    count: (items) => (items as { status: string }[]).filter((f) => f.status === 'open').length,
  },
];

export const sectionOf = (kind: EntityKind) => SECTIONS.find((s) => s.kind === kind)!;

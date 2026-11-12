import type { SectionTypeDef } from '../registry.js';
import { htmlToLines } from '../split/extract.js';

/** An HTML fragment (UI mock, email template), stored in a ```html fence and rendered sandboxed. */
export const htmlType: SectionTypeDef = {
  id: 'html',
  label: 'HTML',
  description: 'HTML fragment (e.g. a UI mock), stored in an html fence; viewers render it sandboxed without scripts.',
  fence: 'html',
  toIndexText: (section) => htmlToLines(section.body),
};

/** A Mandate reference string (a `scheme://...` URI without the `@mandate:` prefix). */
export type MandateRefString = string;

export type AskChipKind = 'spec' | 'standard' | 'section' | 'work_order' | 'feedback' | 'component' | 'question' | 'other';

export interface AskChip {
  /** Reference (versioned when viewing a version; with `#L` for line selections). */
  uri: MandateRefString;
  kind: AskChipKind;
  label: string;
  /** Selected text, quoted in the prompt. */
  quote?: string;
}

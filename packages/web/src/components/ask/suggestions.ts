import type { AskChip, AskChipKind } from './types';

const SUGGESTIONS: Record<AskChipKind | 'none', string[]> = {
  spec: ['Explain this spec', "What's blocking it?", 'What changed since it was implemented?'],
  standard: ['Summarize the rules', 'Which specs does it affect?', 'Any ambiguous or conflicting rules?'],
  section: ['Explain this section', 'Which standards and code does it involve?', 'What breaks if this changes?'],
  work_order: ['Plan the implementation', 'Which rules apply to the code involved?', 'What should I verify when done?'],
  feedback: ['Propose the changes to resolve this', 'Which sections does this affect?'],
  component: ['What does this component do?', 'Which specs affect it?', 'What depends on it, and which rules apply?'],
  question: ['Explain this question and its options', 'What would each option change?', 'Which option fits the specs and standards?'],
  other: ['Explain this'],
  none: ['What is in progress right now?', 'Which specs are blocked?', 'Find specs about authentication'],
};

/** Suggestion pills for the empty Ask state, from the most specific context chip (section first). */
export function suggestionsFor(chips: AskChip[]): string[] {
  const kind = chips.find((c) => c.kind === 'section')?.kind ?? chips[0]?.kind ?? 'none';
  return SUGGESTIONS[kind];
}

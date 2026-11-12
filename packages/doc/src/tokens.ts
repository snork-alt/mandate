/** Counts tokens in a string. Inject a real tokenizer for exact counts. */
export type Tokenizer = (text: string) => number;

/**
 * Cheap token estimate: `ceil(chars / 4)` plus a safety margin (15% by default),
 * so chunks built with it stay under a real tokenizer's limit.
 */
export function estimateTokens(text: string, margin = 0.15): number {
  if (!text) return 0;
  return Math.ceil(Math.ceil(text.length / 4) * (1 + margin));
}

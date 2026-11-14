/** Source extensions that make inline code read as a file path. */
const EXT = 'ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|kts|rb|php|cs|c|h|cc|cpp|hpp|swift|scala|md|mdx|json|jsonl|yaml|yml|toml|sql|css|scss|less|html|sh|proto|graphql|xml';
const KNOWN = new RegExp(`^[^\\s\`]+\\.(?:${EXT})(?::\\d+(?:[-–]\\d+)?)?$`, 'i');
const SLASHED = /^[^\s`]*\/[^\s`]*\.[A-Za-z][A-Za-z0-9]{0,6}(?::\d+(?:[-–]\d+)?)?$/;

/** True when inline code clearly looks like a file path (`kyc.test.ts`, `src/a/b.go:10-20`); URLs never count. */
export function looksLikeFilePath(text: string): boolean {
  const t = text.trim();
  if (!t || t.length > 300 || t.includes('://')) return false;
  return KNOWN.test(t) || SLASHED.test(t);
}

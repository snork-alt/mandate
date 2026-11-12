/**
 * Identifier handling for symbol search: `AuthService.login`, `session_tokens`,
 * `Foo::Bar::baz`, `GET /v1/audit-events` are split into lowercase parts.
 */

/** Lowercase parts of an identifier: camelCase, PascalCase, snake_case, kebab-case, dots, `::`, slashes and spaces. */
export function identifierParts(name: string): string[] {
  return name
    .split(/::|[.\s/_\-#:()[\]{}<>,'"`?=&]+/)
    .flatMap((p) => p.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2').split(' '))
    .map((p) => p.toLowerCase())
    .filter(Boolean);
}

/** Canonical form for exact-ish matching: lowercase, `::` / `#` / `/` as `.`, whitespace collapsed. */
export function normalizeSymbol(name: string): string {
  return name.trim().toLowerCase().replace(/::|#/g, '.').replace(/\s+/g, ' ');
}

/** Character trigrams of a lowercase string (for fuzzy scoring). */
export function trigrams(s: string): Set<string> {
  const t = s.toLowerCase();
  const out = new Set<string>();
  for (let i = 0; i + 3 <= t.length; i++) out.add(t.slice(i, i + 3));
  return out;
}

/** Jaccard similarity of trigram sets (0..1). */
export function trigramSimilarity(a: string, b: string): number {
  const A = trigrams(a);
  const B = trigrams(b);
  if (!A.size || !B.size) return a.toLowerCase() === b.toLowerCase() ? 1 : 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

/** FTS5 query string quoting. */
export const ftsQuote = (s: string): string => `"${s.replace(/"/g, '""')}"`;

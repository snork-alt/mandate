/** Cmd+K input -> which MCP tool to call. Pure, so it is unit-tested. */
export type PaletteQuery =
  | { type: 'empty' }
  | { type: 'ref'; uri: string }
  | { type: 'id'; id: string }
  | { type: 'symbol'; name: string }
  | { type: 'code'; path: string; lines?: string }
  | { type: 'phrase'; phrase: string }
  | { type: 'search'; q: string };

const MENTION = /^@mandate:/i;
const URI_START = /^mandate:\/\//;

/**
 * Prefixes: `@name` symbol (prefix match), `/path[:N-M]` code references, `"phrase"` literal text,
 * `#id` direct id lookup, a pasted `@mandate:` mention or reference resolves the node. Anything else is a hybrid search.
 */
export function parsePaletteQuery(raw: string): PaletteQuery {
  const t = raw.trim();
  if (!t) return { type: 'empty' };
  const bare = t.replace(MENTION, '');
  if (URI_START.test(bare)) return { type: 'ref', uri: bare };
  if (t.startsWith('@')) {
    const name = t.slice(1).trim();
    return name ? { type: 'symbol', name } : { type: 'empty' };
  }
  if (t.startsWith('/')) {
    const m = /^(.*?)(?::(\d+(?:-\d+)?))?$/.exec(t.slice(1).trim())!;
    const path = m[1]!.trim();
    if (!path) return { type: 'empty' };
    return m[2] ? { type: 'code', path, lines: m[2] } : { type: 'code', path };
  }
  if (t.startsWith('"')) {
    const phrase = t.replace(/^"/, '').replace(/"$/, '');
    return phrase.trim() ? { type: 'phrase', phrase } : { type: 'empty' };
  }
  if (t.startsWith('#')) {
    const id = t.slice(1).trim().toLowerCase();
    return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id) ? { type: 'id', id } : { type: 'empty' };
  }
  return { type: 'search', q: t };
}

/**
 * Model-facing tool results for Ask: every result is compacted (`toModel`) and then hard-bounded to a token cap
 * (estimateTokens). The UI keeps its richer copy (`trimForUi`); only what the MODEL reads is shaped here.
 *
 * - Compaction drops noise: null / empty values, `id` / `ref` duplicated by `uri`, line numbers and `#L` anchors,
 *   scores, full hashes (shortened to 7 chars), `<mark>` tags; documents become an outline (bodies of short sections
 *   only), search results collapse to one line per hit, graphs become `ref -rel-> ref` lines, tables are row lines.
 * - Bounding cuts whole items (rows, hits, sections, paragraphs), never mid-item, and appends a machine-readable
 *   continuation `{"truncated":true,"shown":k,"total":n,"next":{"cursor":"…"}}` with a hint that leads with NARROWING
 *   (facets, statuses, section ids, refs taken from the result itself) and offers paging second. After
 *   MAX_CONTINUATIONS paged calls of a tool the continuation is withheld and the hint insists on narrowing.
 */
import { estimateTokens } from '@mandate/doc';

export const MAX_CONTINUATIONS = 2;
/** Bodies of sections up to this many chars are inlined in a document outline... */
const SHORT_BODY = 400;
/** ...and every body when all of them together stay under this (small documents need no section_get calls). */
const SMALL_DOC_BODIES = 6_000;
const SNIPPET = 180;

/** A compacted result: head lines always shown, then whole items that may be cut from the end. */
export interface Compacted {
  head: string[];
  items: string[];
  /** Items available in total (server total), when known. */
  total?: number;
  /** Position of the first item in the full list (from the request's cursor). */
  offset?: number;
  /** How the tool pages: a numeric cursor (storage lists), a base64url offset (index tools) or not at all. */
  paging?: 'numeric' | 'base64' | null;
  /** Server cursor for the next page when nothing was cut here. */
  serverNext?: string | null;
  /** Narrower calls built from the data (facets, ids, refs). Shown first when truncated. */
  narrow: string[];
  /** What a page is made of, for the note ("hits", "rows", "sections"). */
  unit: string;
}

/* ------------------------------------------------------------------ noise */

const HASH = /^[0-9a-f]{40}$/;
const DROP_KEYS = new Set(['lines', 'line', 'score', 'matchedBy', 'elapsedMs', 'path', 'email', 'trailers', 'semantic', 'mode']);

const stripMarks = (s: string) => s.replace(/<\/?mark>/g, '');
/** `mandate://…#L12` -> `mandate://…` (line anchors are noise for the model). */
const noAnchor = (u: unknown) => (typeof u === 'string' ? u.replace(/#L\d+(-L?\d+)?$/, '') : u);

/** Drop noise recursively (see the module comment). */
export function prune(v: unknown): unknown {
  if (v === null || v === undefined) return undefined;
  if (typeof v === 'string') {
    if (v === '') return undefined;
    if (HASH.test(v)) return v.slice(0, 7);
    return stripMarks(v);
  }
  if (Array.isArray(v)) {
    const a = v.map(prune).filter((x) => x !== undefined);
    return a.length ? a : undefined;
  }
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(o)) {
      if (DROP_KEYS.has(k)) continue;
      if ((k === 'id' || k === 'ref') && typeof o.uri === 'string' && (k === 'ref' ? x === o.uri : true)) continue;
      const p = k === 'uri' || k === 'docUri' ? noAnchor(prune(x)) : prune(x);
      if (p !== undefined) out[k] = p;
    }
    return Object.keys(out).length ? out : undefined;
  }
  return v;
}

const json = (v: unknown) => JSON.stringify(v ?? null);
const short = (s: unknown, n: number) => {
  const t = stripMarks(String(s ?? '')).replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const countBy = <T>(xs: T[], f: (x: T) => unknown) => {
  const m = new Map<string, number>();
  for (const x of xs) {
    const k = f(x);
    if (k !== undefined && k !== null && k !== '') m.set(String(k), (m.get(String(k)) ?? 0) + 1);
  }
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
};
const fmtCounts = (e: [string, number][], max = 8) =>
  e
    .slice(0, max)
    .map(([k, n]) => `${k}(${n})`)
    .join(', ');
const facetLine = (name: string, f: Record<string, number> | undefined) => (f && Object.keys(f).length ? `${name}: ${fmtCounts(Object.entries(f).sort((a, b) => b[1] - a[1]))}` : '');

/** Tools that page with a base64url offset cursor (index services); storage lists use a numeric cursor. */
const INDEX_TOOLS = /^(search|text_search|symbol_search|code_search|metadata_query|history_search|related|graph_\w+)$/;
const cursorOffset = (name: string, cursor: unknown): number => {
  if (typeof cursor !== 'string' || !cursor) return 0;
  const n = Number(INDEX_TOOLS.test(name) ? Buffer.from(cursor, 'base64url').toString() : cursor);
  return Number.isInteger(n) && n >= 0 ? n : 0;
};
export const encodeOffset = (name: string, offset: number) => (INDEX_TOOLS.test(name) ? Buffer.from(String(offset)).toString('base64url') : String(offset));

/* ------------------------------------------------------------------ per tool */

type Body = Record<string, any>;
type Args = Record<string, any>;

function doc(name: string, b: Body): Compacted {
  const fm = (b.frontmatter ?? {}) as Body;
  const kind = name.split('_')[0]!;
  const v = b.verification as Body | undefined;
  const head = [
    `${b.uri} "${fm.title ?? b.title ?? ''}"`,
    [fm.status && `status ${fm.status}`, fm.category && `category ${fm.category}`, fm.priority, fm.owner && `owner ${fm.owner}`, fm.repo && `repo ${fm.repo}`, fm.tags?.length && `tags ${fm.tags.join(',')}`]
      .filter(Boolean)
      .join(' · '),
    fm.summary ? `summary: ${short(fm.summary, 300)}` : '',
    v ? `verification: ${v.verified}/${v.total} verified${v.failing ? `, ${v.failing} failing` : ''}${v.stale ? `, ${v.stale} stale` : ''}` : '',
    b.links?.warnings?.length ? `warnings: ${b.links.warnings.map((w: string) => short(w, 160)).join(' | ')}` : '',
    b.meta?.updatedAt ? `updated ${String(b.meta.updatedAt).slice(0, 10)} by ${b.meta.updatedBy ?? '?'} (${b.meta.revisions ?? '?'} revisions)` : '',
  ].filter(Boolean);
  const sections = (b.sections ?? []) as Body[];
  const allBodies = sections.reduce((n, s) => n + (typeof s.body === 'string' ? s.body.length : 0), 0);
  const inlineBody = (s: Body) => typeof s.body === 'string' && (allBodies <= SMALL_DOC_BODIES || s.body.length <= SHORT_BODY);
  // Verification per own criterion (section id -> last result).
  const checks = new Map<string, string>();
  for (const c of (v?.own ?? []) as Body[]) if (c.sectionId) checks.set(c.sectionId, c.last ? `${c.last.result} (${c.last.method ?? c.method ?? ''}${c.last.at ? ` ${String(c.last.at).slice(0, 10)}` : ''})` : 'not verified');
  const inherited = ((v?.inherited ?? []) as Body[]).map((i) => `${i.standard} (${(i.criteria ?? []).length} criteria)`);
  if (inherited.length) head.push(`inherited criteria: ${inherited.join(', ')}`);
  const items = sections.map((s) => {
    const links = ((s.meta?.links ?? []) as Body[]).map((l) => `${l.rel}→${l.to}`);
    const body = inlineBody(s) ? `\n  ${String(s.body).trim().replace(/\n+/g, '\n  ')}` : s.body ? ` (body ${s.body.length} chars: ${kind}_section_get)` : '';
    const check = checks.get(s.id);
    return `- ${s.id} [${s.type}${s.meta?.status ? `, ${s.meta.status}` : ''}] "${s.title}"${s.summary ? ` — ${short(s.summary, 200)}` : ''}${links.length ? ` · links ${links.join(', ')}` : ''}${check ? ` · verification: ${check}` : ''}${body}`;
  });
  const inline = sections.filter(inlineBody).length;
  head.push(
    inline === sections.length
      ? `${sections.length} sections with their full text (complete: do not fetch them again):`
      : `${sections.length} sections. Outline below; the full text of the ${inline} short ones is included (do not fetch them again); for the others marked "body N chars" call ${kind}_section_get {"ref":"${b.uri}/sections/<id>"}:`,
  );
  const long = sections.filter((s) => s.body && !inlineBody(s)).map((s) => s.id);
  return {
    head,
    items,
    total: sections.length,
    paging: null,
    unit: 'sections',
    narrow: [`call ${kind}_section_get for the sections you need${long.length ? ` (long: ${long.slice(0, 10).join(', ')})` : ''}: ${sections.map((s) => s.id).slice(0, 15).join(', ')}`],
  };
}

function section(b: Body): Compacted {
  const s = (b.section ?? {}) as Body;
  const links = ((s.meta?.links ?? []) as Body[]).map((l) => `${l.rel}→${l.to}`);
  const refs = ((s.meta?.refs ?? []) as Body[]).map((r) => `${r.repo ?? ''}:${r.path ?? ''}`);
  const head = [
    `${s.uri} "${s.title}" [${s.type}] in ${b.docUri} "${b.docTitle}" (${b.docStatus})`,
    s.summary ? `summary: ${short(s.summary, 300)}` : '',
    links.length ? `links: ${links.join(', ')}` : '',
    refs.length ? `code: ${refs.join(', ')}` : '',
    s.meta?.symbols?.length ? `symbols: ${s.meta.symbols.join(', ')}` : '',
    s.meta?.verifiedBy?.length ? `verified by: ${json(prune(s.meta.verifiedBy))}` : '',
  ].filter(Boolean);
  const paras = String(s.body ?? '')
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);
  return { head, items: paras, total: paras.length, paging: null, unit: 'paragraphs', narrow: ['the section is long: quote only what you need'] };
}

function search(name: string, b: Body, a: Args): Compacted {
  const groups = (b.groups ?? []) as Body[];
  const items: string[] = [];
  for (const g of groups) {
    const hits = (g.hits ?? []) as Body[];
    items.push(
      `${g.docUri} "${g.docTitle}" (${g.docKind}${g.status ? `, ${g.status}` : ''})${hits
        .slice(0, 3)
        .map((h) => `\n  - ${noAnchor(h.uri)}${h.sectionTitle ? ` "${h.sectionTitle}"` : ''}: ${short(h.snippet, SNIPPET)}`)
        .join('')}${hits.length > 3 ? `\n  (+${hits.length - 3} more hits in this document)` : ''}`,
    );
  }
  const f = (b.facets ?? {}) as Record<string, Record<string, number>>;
  const facets = [facetLine('kinds', f.kinds), facetLine('status', f.status), facetLine('category', f.category), facetLine('sectionType', f.sectionType)].filter(Boolean);
  return {
    head: [`${b.total ?? 0} hits in ${groups.length} documents for "${a.q ?? b.query ?? ''}"${facets.length ? `; facets ${facets.join('; ')}` : ''}`],
    items,
    total: groups.length,
    offset: cursorOffset(name, a.cursor),
    paging: 'base64',
    serverNext: b.nextCursor ?? null,
    unit: 'documents',
    narrow: [
      facets.length ? `filter with kinds / status / category (${facets.join('; ')})` : '',
      'use a more specific phrase',
      groups.length ? `or graph_neighbors / spec_section_get on one of: ${groups.slice(0, 4).map((g) => g.docUri).join(', ')}` : '',
    ].filter(Boolean),
  };
}

function textSearch(name: string, b: Body, a: Args): Compacted {
  const m = (b.matches ?? []) as Body[];
  const docs = countBy(m, (x) => x.docUri);
  return {
    head: [`${b.total ?? m.length} matches for "${a.q ?? ''}"; top documents: ${fmtCounts(docs, 6)}`],
    items: m.map((x) => `- ${noAnchor(x.uri)} "${x.docTitle ?? ''}": ${short(x.text, SNIPPET)}`),
    total: b.total ?? m.length,
    offset: cursorOffset(name, a.cursor),
    paging: 'base64',
    serverNext: b.nextCursor ?? null,
    unit: 'matches',
    narrow: [`restrict to one document (top: ${docs.slice(0, 3).map(([d]) => d).join(', ')})`, 'use a longer, more specific phrase or a regex'],
  };
}

const nodeLine = (n: Body) => {
  const p = (n.props ?? {}) as Body;
  return `${n.uri ?? n.ref} "${n.label ?? p.title ?? ''}" (${[n.kind, p.status].filter(Boolean).join(', ')})${p.summary ? ` — ${short(p.summary, 140)}` : ''}`;
};

function graph(name: string, b: Body, a: Args): Compacted {
  const nodes = (b.nodes ?? []) as Body[];
  const edges = (b.edges ?? []) as Body[];
  const items = [...edges.map((e) => `${e.from} -${e.kind ?? e.rel}-> ${e.to}${e.props?.rules ? ` [${[].concat(e.props.rules).join(',')}]` : ''}`), ...nodes.map((n) => `node ${nodeLine(n)}`)];
  const kinds = countBy(nodes, (n) => n.kind);
  const rels = countBy(edges, (e) => e.kind ?? e.rel);
  return {
    head: [`${b.root ?? a.uri ?? ''}: ${edges.length} edges, ${nodes.length} nodes; node kinds ${fmtCounts(kinds)}; relations ${fmtCounts(rels)}`],
    items,
    total: items.length,
    offset: cursorOffset(name, a.cursor),
    paging: null,
    serverNext: b.nextCursor ?? null,
    unit: 'lines',
    narrow: [`filter by relation (${rels.map(([r]) => r).slice(0, 6).join(', ')}) or node kind (${kinds.map(([k]) => k).join(', ')})`, 'lower depth', 'or one graph_query with WHERE / count()'],
  };
}

function impact(b: Body): Compacted {
  const groups = (b.groups ?? {}) as Record<string, Body[]>;
  const items: string[] = [];
  for (const [kind, ns] of Object.entries(groups)) for (const n of ns) items.push(`${kind}: ${nodeLine(n)}${n.via ? ` via ${n.via}` : ''}${n.depth ? ` (depth ${n.depth})` : ''}`);
  const counts = Object.entries(groups).map(([k, v]) => [k, v.length] as [string, number]);
  return {
    head: [`${b.uri}: ${b.total ?? items.length} impacted (${fmtCounts(counts)})`],
    items,
    total: items.length,
    paging: null,
    unit: 'impacted nodes',
    narrow: [`restrict to one kind (${counts.map(([k]) => k).join(', ')}) or lower depth`, 'or count with graph_query'],
  };
}

function table(b: Body): Compacted {
  const rows = (b.rows ?? []) as unknown[][];
  return {
    head: [`columns: ${json(b.columns)}${b.truncated ? ' (server truncated the result)' : ''}`],
    items: rows.map((r) => json(prune(r) ?? r)),
    total: rows.length,
    paging: null,
    unit: 'rows',
    narrow: ['add a WHERE clause, aggregate with count() / collect(), or RETURN fewer columns', 'page with SKIP n LIMIT m only if you need every row'],
  };
}

/** Lists of objects (and anything else): pruned, one minified item per line, facets from the items. */
const PRIMARY = ['items', 'events', 'entries', 'matches', 'rows', 'nodes', 'hits', 'results', 'refs', 'symbols', 'sections', 'groups'];
const LIST_DROP: Record<string, string[]> = {
  activity_list: ['details', 'id', 'commit'],
  spec_list: ['exemptFrom', 'updatedBy'],
  standard_list: ['updatedBy'],
  work_order_list: ['createdAt', 'specCommit'],
  history_get: ['body'],
};

function generic(name: string, b: Body, a: Args): Compacted {
  const key = PRIMARY.find((k) => Array.isArray(b[k]) && b[k].length);
  const p = (prune(b) ?? {}) as Body;
  if (!key) {
    // One object: its top-level fields are the items.
    const entries = Object.entries(p);
    return { head: [], items: entries.map(([k, v]) => `${k}: ${typeof v === 'string' ? v : json(v)}`), total: entries.length, paging: null, unit: 'fields', narrow: ['ask for a narrower part of it'] };
  }
  const drop = new Set(LIST_DROP[name] ?? []);
  const list = (b[key] as unknown[]).map((x) => {
    const q = prune(x);
    if (q && typeof q === 'object' && !Array.isArray(q)) for (const d of drop) delete (q as Body)[d];
    return q;
  });
  const { [key]: _list, nextCursor, total, ...rest } = p;
  const objs = list.filter((x): x is Body => !!x && typeof x === 'object' && !Array.isArray(x));
  const facets = (['status', 'kind', 'type', 'result', 'spec', 'agent', 'category'] as const)
    .map((f) => [f, countBy(objs, (o) => (typeof o[f] === 'string' ? o[f] : undefined))] as const)
    .filter(([, c]) => c.length > 1)
    .map(([f, c]) => `${f}: ${fmtCounts(c)}`);
  const restJson = Object.keys(rest).length ? json(rest) : '';
  const numeric = typeof b.nextCursor === 'string' && /^\d+$/.test(b.nextCursor);
  return {
    head: [`${typeof b.total === 'number' ? b.total : list.length} ${key}${facets.length ? `; ${facets.join('; ')}` : ''}`, restJson.length > 2 && restJson.length < 600 ? restJson : ''].filter(Boolean),
    items: list.map((x) => json(x)),
    total: typeof b.total === 'number' ? b.total : list.length,
    offset: cursorOffset(name, a.cursor),
    paging: b.nextCursor !== undefined ? (numeric || !INDEX_TOOLS.test(name) ? 'numeric' : 'base64') : null,
    serverNext: typeof nextCursor === 'string' ? nextCursor : null,
    unit: key,
    narrow: [facets.length ? `filter by ${facets.join('; ')}` : 'use the tool filters (status, kind, spec, q)', 'or get one item by its uri'],
  };
}

/** Compact a tool result for the model. */
export function toModel(name: string, body: Body, args: Args = {}): Compacted {
  if (body?.error) return { head: [json({ error: body.error })], items: [], paging: null, unit: 'items', narrow: [] };
  switch (name) {
    case 'spec_get':
    case 'standard_get':
    case 'component_get':
      if (Array.isArray(body.sections)) return doc(name, body);
      break;
    case 'spec_section_get':
    case 'standard_section_get':
    case 'component_section_get':
      if (body.section) return section(body);
      break;
    case 'search':
      return search(name, body, args);
    case 'text_search':
      return textSearch(name, body, args);
    case 'graph_query':
      return table(body);
    case 'graph_impact':
      if (body.groups && !Array.isArray(body.groups)) return impact(body);
      break;
  }
  if (Array.isArray(body?.nodes) && Array.isArray(body?.edges)) return graph(name, body, args);
  return generic(name, body ?? {}, args);
}

/* ------------------------------------------------------------------ bound */

export interface BoundOptions {
  /** Hard cap for the text sent to the model (estimateTokens). */
  maxTokens: number;
  /** Continuation calls already made for this tool in this answer. */
  continuations?: number;
}

export interface BoundResult {
  text: string;
  tokens: number;
  truncated: boolean;
}

/** Render a compacted result within the cap: whole items only, with a continuation note leading with narrowing. */
export function bound(name: string, c: Compacted, o: BoundOptions): BoundResult {
  const cap = Math.max(200, o.maxTokens);
  const fits = (s: string) => estimateTokens(s) <= cap;
  const head = c.head.join('\n');
  const all = [head, ...c.items].filter(Boolean).join('\n');
  const moreOnServer = !!c.serverNext;
  if (fits(all) && !moreOnServer) return { text: all, tokens: estimateTokens(all), truncated: false };

  const stopPaging = (o.continuations ?? 0) >= MAX_CONTINUATIONS;
  const footer = (shown: number) => {
    const offset = c.offset ?? 0;
    const total = c.total !== undefined ? Math.max(c.total, offset + shown) : undefined;
    const cut = shown < c.items.length;
    let next: { cursor: string } | undefined;
    if (!stopPaging) {
      if (cut && c.paging) next = { cursor: c.paging === 'base64' ? Buffer.from(String(offset + shown)).toString('base64url') : String(offset + shown) };
      else if (!cut && c.serverNext) next = { cursor: c.serverNext };
    }
    const note = { truncated: true, shown, ...(total !== undefined ? { total } : {}), unit: c.unit, ...(next ? { next } : {}) };
    const narrow = c.narrow.length ? `Narrow first: ${c.narrow.join('; ')}.` : 'Narrow the query.';
    const page = stopPaging
      ? ` Do not page further (${MAX_CONTINUATIONS} continuation calls already made): narrow the query instead.`
      : next
        ? ` Only if you truly need every ${c.unit}: call ${name} again with the same arguments and cursor "${next.cursor}".`
        : '';
    return `\n${json(note)}\n${narrow}${page}`;
  };

  // Greedy: whole items while head + items + footer fit.
  let shown = 0;
  let text = head;
  for (const item of c.items) {
    const next = text ? `${text}\n${item}` : item;
    if (!fits(next + footer(shown + 1))) break;
    text = next;
    shown++;
  }
  let out = text + footer(shown);
  if (!fits(out)) {
    // The head alone is too big (rare): keep whole head lines that fit.
    let h = '';
    for (const line of c.head) {
      const n = h ? `${h}\n${line}` : line;
      if (!fits(n + footer(0))) break;
      h = n;
    }
    out = h + footer(0);
    // Last resort (one gigantic line): hard cut, still marked.
    if (!fits(out)) {
      const f = footer(0);
      const room = Math.max(0, Math.floor((cap / 1.15 - 2) * 4) - f.length - 8);
      out = `${out.slice(0, room)}…${f}`;
    }
  }
  return { text: out, tokens: estimateTokens(out), truncated: true };
}

/** Compact + bound in one call (what Ask sends to the model). */
export function modelResult(name: string, body: Body, args: Args, o: BoundOptions): BoundResult {
  return bound(name, toModel(name, body, args), o);
}

/**
 * Strict input schemas for the search, graph and index service functions. The MCP tools wrap
 * these 1:1 (the same schema produces each tool's JSON Schema).
 */
import { z } from 'zod';
import { parseNodeUri, parseRef } from './refs.js';
import { CHANGE_KINDS, EDGE_KINDS, LINK_EDGE_KINDS, SEARCH_KINDS, SEARCH_MODES, SYMBOL_MATCHES } from './search.js';

const shortText = (max = 120) => z.string().trim().min(1).max(max);
const list = <T extends z.ZodType>(item: T, max = 20) => z.array(item).min(1).max(max);
const DATE_RE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;
export const isoDateSchema = z.string().regex(DATE_RE, 'expected an ISO date (2026-11-12 or 2026-11-12T10:00:00Z)');

/** Any graph node URI (`mandate://specs/x`, `.../sections/y`, `mandate://symbols/...`, `mandate://code/...`, ...). */
export const nodeUriSchema = z
  .string()
  .trim()
  .min(10)
  .max(1000)
  .refine((u) => parseNodeUri(u) !== null, 'expected a mandate:// node URI');

/** A spec or standard (doc-level) URI. */
export const docUriSchema = z
  .string()
  .trim()
  .max(300)
  .refine((u) => {
    const r = parseRef(u);
    return r !== null && !r.sectionId && !r.commit && !r.lines;
  }, 'expected a document URI such as mandate://specs/login-sso');

/** A point in history: commit sha (4-40 hex) or ISO date (the last first-parent commit at or before it). */
export const atSchema = z.union([z.string().regex(/^[0-9a-f]{4,40}$/, 'commit sha'), isoDateSchema]);
export type At = z.infer<typeof atSchema>;

const cursorSchema = z.string().max(200).regex(/^[A-Za-z0-9_=-]*$/, 'invalid cursor');
const linesSchema = z.string().regex(/^\d+(?:-\d+)?$/, 'lines must be N or N-M');

const filters = {
  kinds: list(z.enum([...SEARCH_KINDS, 'request']), 6).optional(),
  status: list(shortText(40)).optional(),
  category: list(shortText(80)).optional(),
  repo: list(shortText(120)).optional(),
  tags: list(shortText(80)).optional(),
  standards: list(shortText(120)).optional(),
  sectionType: list(shortText(40)).optional(),
  updatedSince: isoDateSchema.optional(),
  updatedUntil: isoDateSchema.optional(),
  /** A doc or section reference, as copied (resolved with resolveRef; must be the current version). */
  within: z.lazy(() => nodeUriSchema).optional(),
};

export const searchInputSchema = z
  .object({
    q: shortText(500),
    mode: z.enum(SEARCH_MODES).default('hybrid'),
    ...filters,
    /** Documents (groups) per page. */
    limit: z.number().int().min(1).max(50).default(10),
    cursor: cursorSchema.optional(),
  })
  .strict();
export type SearchInput = z.input<typeof searchInputSchema>;

export const textSearchInputSchema = z
  .object({
    q: z.string().min(1).max(500),
    regex: z.boolean().default(false),
    caseSensitive: z.boolean().default(false),
    wholeWord: z.boolean().default(false),
    ...filters,
    limit: z.number().int().min(1).max(200).default(50),
    cursor: cursorSchema.optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (!v.regex) return;
    try {
      new RegExp(v.q, v.caseSensitive ? 'u' : 'iu');
    } catch (e) {
      ctx.addIssue({ code: 'custom', path: ['q'], message: `invalid regular expression: ${(e as Error).message}` });
    }
  });
export type TextSearchInput = z.input<typeof textSearchInputSchema>;

export const symbolSearchInputSchema = z
  .object({
    name: shortText(200),
    /** exact: exact, normalized and identifier-part matches; prefix adds prefix matches; fuzzy adds typo-tolerant matches. */
    match: z.enum(SYMBOL_MATCHES).default('exact'),
    limit: z.number().int().min(1).max(100).default(20),
  })
  .strict();
export type SymbolSearchInput = z.input<typeof symbolSearchInputSchema>;

export const codeSearchInputSchema = z
  .object({
    repo: shortText(120).optional(),
    /** File or directory path (a directory matches every file below it). */
    path: z.string().trim().min(1).max(500).optional(),
    /** Glob over paths (`src/**\/*.ts`). */
    glob: z.string().trim().min(1).max(500).optional(),
    lines: linesSchema.optional(),
    limit: z.number().int().min(1).max(200).default(50),
  })
  .strict()
  .refine((v) => v.path || v.glob || v.repo, { message: 'give a repo, a path or a glob' });
export type CodeSearchInput = z.input<typeof codeSearchInputSchema>;

export const relatedInputSchema = z
  .object({
    uri: nodeUriSchema,
    kinds: list(z.enum([...SEARCH_KINDS, 'request']), 6).optional(),
    limit: z.number().int().min(1).max(50).default(10),
  })
  .strict();
export type RelatedInput = z.input<typeof relatedInputSchema>;

export const metadataQueryInputSchema = z
  .object({
    kinds: list(z.enum(['spec', 'standard', 'work_order', 'feedback', 'request']), 5).optional(),
    status: list(shortText(40)).optional(),
    category: list(shortText(80)).optional(),
    repo: list(shortText(120)).optional(),
    tags: list(shortText(80)).optional(),
    owner: list(shortText(120)).optional(),
    priority: list(shortText(10)).optional(),
    standards: list(shortText(120)).optional(),
    staleClaim: z.boolean().optional(),
    outdated: z.boolean().optional(),
    minOpenFeedback: z.number().int().min(1).max(10_000).optional(),
    updatedSince: isoDateSchema.optional(),
    updatedUntil: isoDateSchema.optional(),
    limit: z.number().int().min(1).max(200).default(50),
    cursor: cursorSchema.optional(),
  })
  .strict();
export type MetadataQueryInput = z.input<typeof metadataQueryInputSchema>;

export const historySearchInputSchema = z
  .object({
    q: z.string().trim().min(1).max(500).optional(),
    uri: nodeUriSchema.optional(),
    author: shortText(200).optional(),
    agent: shortText(200).optional(),
    branch: shortText(200).optional(),
    feedback: shortText(40).optional(),
    changeKinds: list(z.enum(CHANGE_KINDS), 3).optional(),
    since: isoDateSchema.optional(),
    until: isoDateSchema.optional(),
    limit: z.number().int().min(1).max(200).default(50),
    cursor: cursorSchema.optional(),
  })
  .strict();
export type HistorySearchInput = z.input<typeof historySearchInputSchema>;

/* ------------------------------------------------------------------ graph */

/** Edge kinds; the deprecated `links_to` (one release) expands to the per-rel section link kinds. */
const edgeKinds = z.preprocess(
  (v) => (Array.isArray(v) && v.includes('links_to') ? [...new Set(v.flatMap((k) => (k === 'links_to' ? [...LINK_EDGE_KINDS] : [k])))] : v),
  // A plain string in the JSON schema (the 68-value enum cost ~250 tokens per tool); validated here with close matches.
  list(
    z
      .string()
      .describe('edge kind (graph_schema lists them)')
      .superRefine((k, ctx) => {
        if ((EDGE_KINDS as readonly string[]).includes(k)) return;
        const near = EDGE_KINDS.filter((e) => e.includes(k) || k.includes(e) || e.split('_')[0] === k.split('_')[0]).slice(0, 6);
        ctx.addIssue({ code: 'custom', message: `unknown edge kind '${k}'${near.length ? ` (did you mean ${near.join(', ')}?)` : ''}; graph_schema lists the edge kinds` });
      }) as unknown as z.ZodEnum<{ [K in (typeof EDGE_KINDS)[number]]: K }>,
    EDGE_KINDS.length,
  ),
);

export const graphNodeInputSchema = z
  .object({ uri: nodeUriSchema, at: atSchema.optional(), limit: z.number().int().min(1).max(100).default(10) })
  .strict();
export type GraphNodeInput = z.input<typeof graphNodeInputSchema>;

export const graphNeighborsInputSchema = z
  .object({
    uri: nodeUriSchema,
    kinds: edgeKinds.optional(),
    direction: z.enum(['out', 'in', 'both']).default('both'),
    depth: z.number().int().min(1).max(3).default(1),
    limit: z.number().int().min(1).max(500).default(100),
    cursor: cursorSchema.optional(),
    at: atSchema.optional(),
  })
  .strict();
export type GraphNeighborsInput = z.input<typeof graphNeighborsInputSchema>;

export const graphPathInputSchema = z
  .object({
    from: nodeUriSchema,
    to: nodeUriSchema,
    maxDepth: z.number().int().min(1).max(6).default(6),
    kinds: edgeKinds.optional(),
    at: atSchema.optional(),
  })
  .strict();
export type GraphPathInput = z.input<typeof graphPathInputSchema>;

export const graphImpactInputSchema = z
  .object({ uri: nodeUriSchema, maxDepth: z.number().int().min(1).max(10).default(6), at: atSchema.optional() })
  .strict();
export type GraphImpactInput = z.input<typeof graphImpactInputSchema>;

export const graphHistoryInputSchema = z
  .object({
    uri: nodeUriSchema,
    since: z.union([atSchema]).optional(),
    until: z.union([atSchema]).optional(),
    kinds: list(z.enum(CHANGE_KINDS), 3).optional(),
    agent: shortText(200).optional(),
    limit: z.number().int().min(1).max(200).default(50),
    cursor: cursorSchema.optional(),
  })
  .strict();
export type GraphHistoryInput = z.input<typeof graphHistoryInputSchema>;

export const graphChangesInputSchema = z
  .object({
    from: atSchema,
    to: atSchema.optional(),
    /** Edge kinds to report (default: all structural kinds, no commit bookkeeping). */
    kinds: edgeKinds.optional(),
    within: nodeUriSchema.optional(),
  })
  .strict();
export type GraphChangesInput = z.input<typeof graphChangesInputSchema>;

export const graphEvolutionInputSchema = z.object({ uri: nodeUriSchema }).strict();
export type GraphEvolutionInput = z.input<typeof graphEvolutionInputSchema>;

/** Entry points for graph traversal: hybrid search + symbol + code matches, returned as nodes. */
export const graphSearchInputSchema = z.object({ q: shortText(500), limit: z.number().int().min(1).max(50).default(10) }).strict();
export type GraphSearchInput = z.input<typeof graphSearchInputSchema>;

export const indexStatusInputSchema = z.object({}).strict();
export const indexRebuildInputSchema = z.object({}).strict();

/** Resolve a copied reference (any form: `@mandate:` prefix, `@sha`, `#Lx-Ly`) to its graph node. */
export const resolveRefInputSchema = z.object({ ref: nodeUriSchema, at: atSchema.optional() }).strict();
export type ResolveRefInput = z.input<typeof resolveRefInputSchema>;

/* ------------------------------------------------------------------ batch */

/** Service functions callable from `graph_batch` (each validates its own args). */
export const BATCH_OPS = [
  'search',
  'textSearch',
  'symbolSearch',
  'codeSearch',
  'related',
  'metadataQuery',
  'historySearch',
  'resolveRef',
  'graphNode',
  'graphNeighbors',
  'graphPath',
  'graphImpact',
  'graphHistory',
  'graphChanges',
  'graphEvolution',
  'graphSearch',
  'graphQuery',
  'graphSchema',
] as const;
export type BatchOp = (typeof BATCH_OPS)[number];

export const graphBatchInputSchema = z
  .object({
    ops: z
      .array(z.object({ op: z.enum(BATCH_OPS), args: z.record(z.string(), z.unknown()).default({}) }).strict())
      .min(1)
      .max(20),
  })
  .strict();
export type GraphBatchInput = z.input<typeof graphBatchInputSchema>;

/* ------------------------------------------------------------------ cypher */

export const graphQueryInputSchema = z
  .object({
    query: z.string().trim().min(1).max(10_000),
    params: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.unknown()).default({}),
    /** Point in time: sha, seq, ISO date or a versioned reference; default HEAD. */
    at: z.union([atSchema, nodeUriSchema]).optional(),
    /** Row cap (default 500, max 5000). */
    limit: z.number().int().min(1).max(5000).default(500),
  })
  .strict();
export type GraphQueryInput = z.input<typeof graphQueryInputSchema>;
export const graphSchemaInputSchema = z.object({}).strict();

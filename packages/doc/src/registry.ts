import type { z } from 'zod';
import type { Section } from './schema.js';
import type { IndexLine } from './split/extract.js';

/**
 * A pluggable section type. Register it on a registry passed to `createDocFormat`
 * and documents may use `type: <id>` for their sections.
 */
export interface SectionTypeDef {
  /** Value of `type:` in the frontmatter, e.g. `mermaid`. Lowercase, dashes allowed. */
  id: string;
  /** Human label for UIs and tools ("Diagram"). Defaults to the id. */
  label?: string;
  /** One-line description for agents (exposed via the API). */
  description?: string;
  /**
   * Fence language used to store the body (```<fence> ... ```). Omit to store the body as raw markdown.
   */
  fence?: string;
  /** Optional schema the (unfenced) body must satisfy. */
  bodySchema?: z.ZodType<string>;
  /** Optional schema for the section's frontmatter entry (type-specific fields such as `method`). */
  metaSchema?: z.ZodType;
  /** Sections of this type are verifiable criteria (other sections may list them in `verifiedBy`). */
  verifies?: boolean;
  /** Extra validation; return human-readable problems (empty / undefined = valid). */
  validate?(body: string): string[] | undefined | void;
  /** Code symbols mentioned by the body, if the type can tell (for indexing later). */
  extractSymbols?(body: string): string[];
  /**
   * Text to index for search (default: the body). Return `IndexLine`s to keep a mapping
   * from extracted text to (1-based) body lines, so search hits point at the right lines.
   */
  toIndexText?(section: Section): string | IndexLine[];
  /** Custom split for an index text over budget; pieces are packed into chunks by the chunker. */
  split?(section: Section, budget: SplitBudget): SplitPiece[];
  /** Granularity of body diffs; defaults to `lines` for fenced (code-like) types and `words` otherwise. */
  diffMode?: 'words' | 'lines';
  /** Custom body diff (overrides `diffMode`). */
  diff?(before: string, after: string): TextOp[];
  /**
   * Structured, type-specific diff of two bodies (e.g. per acceptance criterion), keyed by item id.
   * Used next to the text diff when the type has addressable items.
   */
  diffItems?(before: string, after: string): ItemChange[];
  /** Graph nodes contributed by a section (e.g. one per criterion), for the index / knowledge graph. */
  extractNodes?(section: Section, docUri: string): GraphNode[];
  /** Graph edges contributed by a section (e.g. section -> criterion it is verified by). */
  extractEdges?(section: Section, docUri: string): GraphEdge[];
  /** Rollup status of a section (e.g. `{ verified: 4, total: 5, state: 'partial' }`), given app context. */
  status?(section: Section, ctx: SectionStatusContext): SectionRollup | undefined;
}

/** A change to one addressable item inside a section body. */
export interface ItemChange {
  id: string;
  change: 'added' | 'removed' | 'modified';
  /** Changed fields for `modified` items (e.g. `statement`). */
  fields?: string[];
  before?: unknown;
  after?: unknown;
}

export interface GraphNode {
  /** Stable URI, e.g. `mandate://specs/x/sections/y/criteria/ac-1`. */
  uri: string;
  kind: string;
  label: string;
  /** Optional text for indexing. */
  text?: string;
}

export interface GraphEdge {
  from: string;
  to: string;
  kind: string;
}

/** App-provided context for `status` hooks (e.g. verification results), keyed by item URI. */
export interface SectionStatusContext {
  docUri: string;
  /** Per-item state, e.g. criterion URI -> 'verified' | 'failing' | 'stale' | 'unverified'. */
  itemStates?: Record<string, string>;
}

export interface SectionRollup {
  total: number;
  verified: number;
  state: string;
}

/** Token budget handed to `split`: `tokens` available for text, `count` measures a string. */
export interface SplitBudget {
  tokens: number;
  count(text: string): number;
}

/** A piece returned by a `split` hook; lines are 1-based and relative to the section body. */
export interface SplitPiece {
  text: string;
  lineStart?: number;
  lineEnd?: number;
}

/** One run of a text diff. */
export interface TextOp {
  op: 'equal' | 'insert' | 'delete';
  text: string;
}

export interface SectionTypeRegistry {
  /** Add a type; throws if the id is invalid or already registered. Returns the registry for chaining. */
  register(def: SectionTypeDef): SectionTypeRegistry;
  get(id: string): SectionTypeDef | undefined;
  has(id: string): boolean;
  /** Registered types in registration order. */
  list(): SectionTypeDef[];
}

export const SECTION_TYPE_ID_RE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

/** Create an empty registry, optionally pre-filled with `defs`. */
export function createRegistry(defs: SectionTypeDef[] = []): SectionTypeRegistry {
  const types = new Map<string, SectionTypeDef>();
  const registry: SectionTypeRegistry = {
    register(def) {
      if (!SECTION_TYPE_ID_RE.test(def.id)) throw new Error(`invalid section type id "${def.id}"`);
      if (types.has(def.id)) throw new Error(`section type "${def.id}" is already registered`);
      if (def.fence !== undefined && !/^[\w-]+$/.test(def.fence)) throw new Error(`invalid fence "${def.fence}" for type "${def.id}"`);
      types.set(def.id, def);
      return registry;
    },
    get: (id) => types.get(id),
    has: (id) => types.has(id),
    list: () => [...types.values()],
  };
  defs.forEach((d) => registry.register(d));
  return registry;
}

/** Problems with a body according to its type (schema + validate hook). */
export function checkBody(def: SectionTypeDef, body: string): string[] {
  const problems: string[] = [];
  if (def.bodySchema) {
    const r = def.bodySchema.safeParse(body);
    if (!r.success) problems.push(...r.error.issues.map((i) => i.message));
  }
  const extra = def.validate?.(body);
  if (extra) problems.push(...extra);
  return problems;
}

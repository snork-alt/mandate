import type { NodeKind } from './refs.js';
/**
 * Search, graph and index result types (MCP tools: search, graph_*, index_status).
 * The MCP server wraps the same service functions, so these are its result shapes too.
 */

/* ------------------------------------------------------------------ authoring */

/** Guidance for agents writing specs and standards (embedded in MCP write-tool descriptions). */
export const AUTHORING_GUIDANCE = `Writing specs and standards for Mandate:
- One concept per section. If a section covers two things, split it; sections are the unit agents implement, review and search.
- One idea per paragraph, stated plainly. Lead with the rule, then the detail.
- Always write or update the section \`summary\`: one sentence saying what the section decides. Update it whenever the body changes.
- Keep sections under the soft limit (about 600 tokens). Longer sections are split for search and are harder to implement in one go.
- Name code symbols (\`symbols\`), code locations (\`refs\`) and applicable standards (\`standards\`) in the section metadata, so search and impact analysis find them.
- Use \`###\` subheadings, lists and tables for structure; keep code blocks short and focused.`;

/* ------------------------------------------------------------------ search */

export const SEARCH_MODES = ['hybrid', 'text', 'semantic'] as const;
export type SearchMode = (typeof SEARCH_MODES)[number];

/** What a hit is: a whole document (spec/standard/work order/feedback) or a section of a spec or standard. */
export const SEARCH_KINDS = ['spec', 'standard', 'section', 'work_order', 'feedback', 'component'] as const;
export type SearchKind = (typeof SEARCH_KINDS)[number];
export type DocKind = Exclude<SearchKind, 'section'>;

export type MatchSource = 'text' | 'semantic' | 'symbol';

export interface SearchFilters {
  /** `section` matches every section; a doc kind matches the doc and its sections. */
  kinds?: SearchKind[];
  status?: string[];
  category?: string[];
  repo?: string[];
  /** Every listed tag must be present. */
  tags?: string[];
  /** Doc or section uses any of these standards. */
  standards?: string[];
  /** Section type (markdown, mermaid, html, ...). */
  sectionType?: string[];
  /** ISO dates on the doc's last change (git). */
  updatedSince?: string;
  updatedUntil?: string;
  /** Restrict to one document: `mandate://specs/x`. */
  within?: string;
}

export interface SearchRequest extends SearchFilters {
  q: string;
  mode?: SearchMode;
  limit?: number;
  cursor?: string;
}

export interface SearchHit {
  /** `mandate://specs/x/sections/y#L12-L20` (or the doc URI for doc-level hits). */
  uri: string;
  docUri: string;
  docTitle: string;
  sectionId?: string;
  sectionTitle?: string;
  kind: SearchKind;
  docKind: DocKind;
  /** Short excerpt; matched terms wrapped in `<mark>`. Other text is HTML-escaped. */
  snippet: string;
  score: number;
  matchedBy: MatchSource[];
  lines?: { start: number; end: number };
}

export interface SearchGroup {
  docUri: string;
  docTitle: string;
  docKind: DocKind;
  status?: string;
  category?: string;
  /** Best hit score in the group. */
  score: number;
  hits: SearchHit[];
}

export type FacetCounts = Record<string, number>;

export interface SearchResponse {
  query: string;
  mode: SearchMode;
  /** Hits grouped by document, best group first. */
  groups: SearchGroup[];
  /** Counts over every matching hit (before pagination): kinds, status, category, repo, tags, sectionType. */
  facets: Record<'kinds' | 'status' | 'category' | 'repo' | 'tags' | 'sectionType', FacetCounts>;
  total: number;
  nextCursor: string | null;
  /** False when semantic matching was skipped (provider `none`, model unavailable or vectors pending). */
  semantic: { used: boolean; reason?: string; pending: number };
}

/** `text_search`: literal phrase or regex over stored bodies, no stemming. */
export interface TextSearchRequest extends SearchFilters {
  q: string;
  /** Treat `q` as a regular expression (JavaScript syntax). */
  regex?: boolean;
  caseSensitive?: boolean;
  /** Whole-word matches only. */
  wholeWord?: boolean;
  limit?: number;
  cursor?: string;
}

export interface TextMatch {
  /** Section (or doc) URI with `#L<line>`. */
  uri: string;
  docUri: string;
  docTitle: string;
  sectionId?: string;
  sectionTitle?: string;
  kind: SearchKind;
  /** 1-based line in the stored file (for work orders / feedback: line in the .jsonl file). */
  line: number;
  /** The matching line, HTML-escaped, with `<mark>` around matches. */
  text: string;
}

export interface TextSearchResponse {
  matches: TextMatch[];
  total: number;
  nextCursor: string | null;
}

export const SYMBOL_MATCHES = ['exact', 'prefix', 'fuzzy'] as const;
export type SymbolMatch = (typeof SYMBOL_MATCHES)[number];

export interface SymbolUse {
  sectionUri: string;
  docUri: string;
  docTitle: string;
  sectionTitle: string;
  lines?: { start: number; end: number };
}

export interface SymbolResult {
  name: string;
  uri: string;
  /** How it matched: exact name, normalized name, identifier part, prefix or fuzzy (trigram). */
  match: 'exact' | 'normalized' | 'part' | 'prefix' | 'fuzzy';
  score: number;
  usedIn: SymbolUse[];
}

export interface SymbolSearchResponse {
  query: string;
  symbols: SymbolResult[];
}

export interface CodeRefHit {
  /** `mandate://code/<repo>/<path>[#La-Lb]` of the stored reference. */
  uri: string;
  repo: string;
  path: string;
  lines?: { start: number; end: number };
  commit?: string;
  sectionUri: string;
  docUri: string;
  docTitle: string;
  sectionTitle: string;
  status?: string;
}

export interface CodeSearchResponse {
  repo?: string;
  path?: string;
  glob?: string;
  lines?: { start: number; end: number };
  refs: CodeRefHit[];
}

export interface RelatedItem {
  uri: string;
  docUri: string;
  docTitle: string;
  sectionTitle?: string;
  kind: SearchKind;
  score: number;
}

export interface RelatedResponse {
  uri: string;
  items: RelatedItem[];
  /** Why the list may be empty: no vectors yet, provider `none`, ... */
  reason?: string;
}

export interface MetadataQuery {
  kinds?: DocKind[];
  status?: string[];
  category?: string[];
  repo?: string[];
  tags?: string[];
  owner?: string[];
  priority?: string[];
  standards?: string[];
  /** Specs whose claim heartbeat is older than the claim TTL. */
  staleClaim?: boolean;
  /** Specs with sections changed since they were implemented. */
  outdated?: boolean;
  /** Docs with at least this many open feedback items (1 = any). */
  minOpenFeedback?: number;
  updatedSince?: string;
  updatedUntil?: string;
  limit?: number;
  cursor?: string;
}

export interface MetadataItem {
  uri: string;
  kind: DocKind;
  id: string;
  title: string;
  status?: string;
  category?: string;
  repo?: string;
  tags: string[];
  owner?: string;
  priority?: string;
  updatedAt?: string;
  claim?: { agent: string; staleSince?: string; stale: boolean } | null;
  outdatedSections: string[];
  openFeedback: number;
}

export interface MetadataResponse {
  items: MetadataItem[];
  total: number;
  nextCursor: string | null;
}

export const CHANGE_KINDS = ['text', 'metadata', 'status'] as const;
export type ChangeKind = (typeof CHANGE_KINDS)[number];

export interface HistoryQuery {
  /** Words or phrase in subject, body or trailers (FTS). */
  q?: string;
  /** Commits touching this doc or section (or anything under it). */
  uri?: string;
  author?: string;
  agent?: string;
  branch?: string;
  /** `Feedback:` trailer value. */
  feedback?: string;
  changeKinds?: ChangeKind[];
  since?: string;
  until?: string;
  limit?: number;
  cursor?: string;
}

export interface CommitRecord {
  sha: string;
  uri: string;
  subject: string;
  body: string;
  author: string;
  email: string;
  date: string;
  trailers: Record<string, string>;
  agent?: string;
  branch?: string;
  changeKinds: ChangeKind[];
  /** Docs and sections the commit touched. */
  uris: string[];
}

export interface HistorySearchResponse {
  commits: CommitRecord[];
  total: number;
  nextCursor: string | null;
}

/* ------------------------------------------------------------------ graph */

export type GraphNodeKind = 'spec' | 'standard' | 'section' | 'work_order' | 'feedback' | 'symbol' | 'code_file' | 'code_range' | 'repo' | 'commit' | 'agent' | 'branch' | 'verification' | 'version' | 'excerpt' | 'component' | 'architecture';

export const EDGE_KINDS = [
  'has_section',
  'depends_on',
  'uses_standard',
  'applies_to',
  'mentions_symbol',
  'references_code',
  'in_file',
  'in_repo',
  'targets',
  'changed',
  'parent',
  'authored_by',
  'on_branch',
  'resolves',
  'duplicate_of',
  'related_to',
  'covers',
  'similar_to',
  'verifies',
  'applied_to',
  'verified_at',
  'links_to',
  'deviates_from',
  'version_of',
  'previous_version',
  'created_in',
  'excerpt_of',
  'claimed_by',
  // Rules (standards): what code a rule governs, its examples, what spec sections inherit it, lifecycle successors.
  'governs',
  'example_of',
  'inherits_rule',
  'superseded_by',
  // Components (architecture): what a spec section affects, what code a component owns (any matching glob) and which
  // component owns a file or range (the most specific glob wins), and the architecture view's components.
  'affects',
  'owns',
  'owned_by',
  // Containment: a component contains its children (`parent` frontmatter).
  'contains',
  'includes',
] as const;
export type EdgeKind = (typeof EDGE_KINDS)[number];

/** Name of each edge kind when traversed backwards (to -> from). */
export const REVERSE_EDGE_NAMES: Record<EdgeKind, string> = {
  has_section: 'section_of',
  depends_on: 'blocks',
  uses_standard: 'used_by',
  applies_to: 'applied_by',
  mentions_symbol: 'mentioned_in',
  references_code: 'referenced_by',
  in_file: 'contains',
  in_repo: 'repo_contains',
  targets: 'targeted_by',
  changed: 'changed_by',
  parent: 'child',
  authored_by: 'authored',
  on_branch: 'branch_contains',
  resolves: 'resolved_by',
  duplicate_of: 'duplicated_by',
  related_to: 'related_to',
  covers: 'covered_by',
  similar_to: 'similar_to',
  verifies: 'verified_by',
  applied_to: 'has_verification',
  verified_at: 'verifications_at',
  links_to: 'linked_from',
  deviates_from: 'deviated_from_by',
  version_of: 'has_version',
  previous_version: 'next_version',
  created_in: 'created',
  excerpt_of: 'has_excerpt',
  claimed_by: 'claims',
  governs: 'governed_by',
  example_of: 'has_example',
  inherits_rule: 'rule_inherited_by',
  superseded_by: 'supersedes_standard',
  affects: 'affected_by',
  owns: 'owned_by_glob',
  owned_by: 'owner_of',
  contains: 'contained_in',
  includes: 'included_in',
};

export interface GraphNode {
  uri: string;
  /** Canonical, copyable reference of the node (resolves back to this node). */
  ref: string;
  kind: GraphNodeKind;
  label: string;
  props: Record<string, unknown>;
}

export interface GraphEdge {
  from: string;
  to: string;
  kind: EdgeKind;
  props?: Record<string, unknown>;
  /** similar_to only: cosine similarity. */
  score?: number;
}

export type GraphDirection = 'out' | 'in' | 'both';

export interface GraphNeighborGroup {
  kind: EdgeKind;
  direction: 'out' | 'in';
  /** `kind` for outgoing edges, its reverse name for incoming ones. */
  name: string;
  count: number;
  nodes: GraphNode[];
}

export interface GraphNodeResponse {
  node: GraphNode & {
    /** Set when the node no longer exists at the requested point (last known state is shown). */
    deletedAt?: CommitPoint;
    createdAt?: CommitPoint;
  };
  /** The point in time the graph was read at (HEAD when `at` is omitted). */
  at: CommitPoint | null;
  neighbors: GraphNeighborGroup[];
}

/** A point in history. The sha is the only stable coordinate (no sequence numbers are exposed). */
export interface CommitPoint {
  sha: string;
  date: string;
}

/** One change of a node (`graph_history`). */
export interface HistoryEvent {
  commit: CommitPoint & { subject: string; author: string; agent?: string; branch?: string; uri: string };
  /** The doc or section that changed (for symbols / code: the section mentioning or referencing it). */
  target: string;
  action: 'created' | 'modified' | 'deleted' | 'renamed';
  changeKinds: ChangeKind[];
  linesAdded: number;
  linesRemoved: number;
}

export interface GraphHistoryResponse {
  uri: string;
  events: HistoryEvent[];
  total: number;
  nextCursor: string | null;
}

export interface ContentChange {
  uri: string;
  kind: 'spec' | 'standard' | 'section' | 'work_order' | 'feedback' | 'component';
  action: 'created' | 'modified' | 'deleted' | 'renamed';
  changeKinds: ChangeKind[];
  /** Commits in the range that changed it. */
  commits: string[];
  /** For docs: frontmatter keys changed and section ids added / removed / modified (from diffDocs). */
  summary?: { frontmatter: string[]; sectionsAdded: string[]; sectionsRemoved: string[]; sectionsModified: string[] };
}

/** Graph diff between two points in time (`graph_changes`). */
export interface GraphChangesResponse {
  from: CommitPoint;
  to: CommitPoint;
  nodesAdded: GraphNode[];
  nodesRemoved: GraphNode[];
  edgesAdded: GraphEdge[];
  edgesRemoved: GraphEdge[];
  content: ContentChange[];
}

/** When each relationship of a node appeared and disappeared (`graph_evolution`). */
export interface EvolutionEntry {
  kind: EdgeKind;
  direction: 'out' | 'in';
  name: string;
  other: { uri: string; label: string; kind: GraphNodeKind | null };
  /** `version` = how many times the node had changed up to that commit (v1 = created). */
  from: CommitPoint & { version: number };
  to: (CommitPoint & { version: number }) | null;
  props?: Record<string, unknown>;
}

export interface GraphEvolutionResponse {
  uri: string;
  versions: (CommitPoint & { version: number; subject: string })[];
  entries: EvolutionEntry[];
}

export interface GraphNeighborsResponse {
  root: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  nextCursor: string | null;
}

export interface GraphPathResponse {
  from: string;
  to: string;
  found: boolean;
  /** Nodes along the path, from -> to. */
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface GraphImpactResponse {
  uri: string;
  /** Everything that transitively depends on / uses / references / covers / targets the node, by node kind. */
  groups: Partial<Record<GraphNodeKind, (GraphNode & { depth: number; via: EdgeKind })[]>>;
  total: number;
}

/* ------------------------------------------------------------------ index */

export interface IndexStatus {
  indexPath: string;
  schemaVersion: number;
  headCommit: string | null;
  indexedCommit: string | null;
  upToDate: boolean;
  building: boolean;
  docs: number;
  sections: number;
  chunks: number;
  nodes: number;
  edges: number;
  commits: number;
  embedding: {
    provider: 'openai-compatible' | 'local' | 'none';
    model: string;
    modelId: string;
    dimensions: number;
    /** Distinct chunk texts with a vector for the current model. */
    embedded: number;
    pending: number;
    running: boolean;
  };
  lastSyncAt: string | null;
  lastError: string | null;
  /** Last history rewrite detected on this repository (HEAD not descending from the indexed head), if any. */
  historyRewrite: {
    detectedAt: string;
    oldHead: string;
    newHead: string;
    lostCommits: number;
    /** Stored pins (implementedCommit, specCommit) that no longer resolve: their derived state is unknown. */
    lostPins: { uri: string; field: string; sha: string }[];
  } | null;
}

/** Non-blocking advice returned by section writes (`warnings` on POST/PUT spec and standard responses). */
export interface WriteWarnings {
  warnings?: string[];
}

/** `resolveRef`: the node a copied reference denotes, and the point in history it pins. */
export interface ResolvedRef {
  node: GraphNode;
  /** The commit the reference (or `at`) pins; null = current HEAD. */
  at: CommitPoint | null;
}

/** One op result of `graph_batch`: per-op errors never fail the batch. */
export type BatchResult =
  | { op: string; ok: true; result: unknown }
  | { op: string; ok: false; error: { code: string; message: string; hint?: string; issues?: unknown } };

/** `graph_query` result. Nodes serialise as `{ ref, kind, label, props }`, relationships as `{ type, from, to, props }`,
 * paths as alternating `[node, rel, node, ...]` lists. */
export interface GraphQueryResult {
  columns: string[];
  rows: unknown[][];
  truncated: boolean;
  at: CommitPoint | null;
  elapsedMs: number;
}

export interface GraphSchema {
  labels: { label: string; kind: string; description: string; properties: string[] }[];
  relationships: { type: string; kind: string; reverse: string; from: string[]; to: string[] }[];
  functions: string[];
  examples: { question: string; query: string }[];
}

/* ------------------------------------------------------------------ query labels */

/** Cypher label of each node kind (`satisfies` keeps it in sync with NODE_KINDS). */
export const NODE_LABELS = {
  spec: 'Spec',
  standard: 'Standard',
  section: 'Section',
  work_order: 'WorkOrder',
  feedback: 'Feedback',
  symbol: 'Symbol',
  code_file: 'CodeFile',
  code_range: 'CodeRange',
  repo: 'Repo',
  commit: 'Commit',
  agent: 'Agent',
  branch: 'Branch',
  verification: 'Verification',
  version: 'Version',
  excerpt: 'Excerpt',
  // (added with the components model; the graph side is the graph agent's)
  component: 'Component',
  architecture: 'Architecture',
} as const satisfies Record<NodeKind, string>;

/** Labels defined by a kind plus a property value. */
export const DERIVED_LABELS = {
  AcceptanceSection: { kind: 'section', prop: 'type', value: 'acceptance' },
  /** A standard's rule section (props: level, rationale, scope, check, examples). */
  Rule: { kind: 'section', prop: 'type', value: 'rule' },
} as const;

/** Relationship type of each edge kind: UPPER_SNAKE. */
export const relTypeOf = (kind: EdgeKind): string => kind.toUpperCase();

/** Relationship types defined by an edge kind plus its `rel` prop. */
export const DERIVED_REL_TYPES = {
  FOLLOWS: { kind: 'links_to', rel: 'follows' },
} as const;

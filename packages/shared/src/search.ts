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
export const SEARCH_KINDS = ['spec', 'standard', 'section', 'work_order', 'feedback', 'component', 'audit'] as const;
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
  /** Work orders that touched matching code (their `touched` list / section code refs; current state). */
  workOrders?: CodeTouchHit[];
}

/** A work order (or one of its sections) that touched a file / range. */
export interface CodeTouchHit {
  /** The work order (`mandate://work-orders/<id>`). */
  workOrder: string;
  /** The work-order section, when the touch was recorded for one. */
  section?: string;
  title: string;
  status?: string;
  repo: string;
  path: string;
  lines?: { start: number; end: number };
  change?: string;
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

export type GraphNodeKind = 'spec' | 'standard' | 'section' | 'work_order' | 'feedback' | 'symbol' | 'code_file' | 'code_range' | 'repo' | 'commit' | 'agent' | 'user' | 'branch' | 'verification' | 'version' | 'excerpt' | 'component' | 'architecture' | 'audit' | 'finding' | 'comment' | 'question' | 'pull_request' | 'code_commit';

/**
 * Authored section links: one edge kind per link `rel` (P1; props: note, feedback, by, pin, seenAt). They replace the
 * former `links_to {rel}` edge; the Cypher type `:LINKS_TO` stays an alias for their union for one release.
 */
export const LINK_EDGE_KINDS = ['depends_on', 'follows', 'deviates_from', 'extends', 'supersedes', 'conflicts_with', 'relates_to', 'affects', 'verified_by'] as const;
export type LinkEdgeKind = (typeof LINK_EDGE_KINDS)[number];

export const EDGE_KINDS = [
  'has_section',
  // Section links (LINK_EDGE_KINDS; `depends_on` also: work order -> work order).
  'depends_on',
  'follows',
  'extends',
  'supersedes',
  'conflicts_with',
  'relates_to',
  'verified_by',
  // Derived document-level dependencies (from the section links / legacy frontmatter `dependsOn`), never both kinds.
  'spec_depends_on',
  'component_depends_on',
  // Spec / component / standard -> standard it uses (props: via ['links' | 'appliesTo'], rules: matching appliesTo).
  'uses_standard',
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
  // Components (architecture): what a spec section affects, what code a component owns (any matching glob) and which
  // component owns a file or range (the most specific glob wins), and the architecture view's components.
  'affects',
  'owns',
  'owned_by',
  // Containment: a component contains its children (`parent` frontmatter).
  'contains',
  'includes',
  // Audits: an audit checks its target (spec / standard) and each checklist item (criterion / rule section) at a
  // commit; findings belong to an audit, concern a section, are found in code and are fixed by work orders or
  // reported in feedback (stored on the work order / feedback as `from_finding`).
  'audits',
  'checks',
  'audited_at',
  'finding_of',
  'concerns',
  'found_in',
  'fixed_by',
  'reported_in',
  'from_finding',
  // Work orders (markdown documents): the code they touched (file / range, temporal), their pull requests, the code
  // commits that implement them (code commit -> work order), a PR merged as a code commit.
  'touches',
  'has_pr',
  'implements',
  'merged_as',
  // Comments (review / coordination threads): a comment on a work order or one of its sections; replies.
  'comments_on',
  'reply_to',
  // Lineage: an effect (changed doc / section / record, or the commit) -> its recorded cause (`cause` input and
  // Feedback / Work-Order / Verification / Audit / Caused-By trailers); temporal, from the commit that recorded it.
  'caused_by',
  // Standards in code: rule (or standard) -> code file / range where it was checked: passed / failed.
  'applies_at',
  'violated_at',
  // Approvals and provenance: a waiver (section deviates_from with feedback) or exemption (spec exemptFrom) -> its
  // approving feedback; spec -> standard it is exempt from; work order -> the feedback it acts on (`reason`);
  // verification -> the code commit it ran at; work-order section -> the criteria / results that prove it.
  'waived_by',
  'exempt_from',
  'acts_on',
  'verified_at_code',
  'proven_by',
  // Identity (P6): feedback / work order -> the user who filed / created it (server mode; the commit's user).
  'created_by',
  'filed_by',
  // A finding that repeats a finding of an earlier audit (finding `duplicateOf`).
  'duplicate_finding_of',
] as const;
export type EdgeKind = (typeof EDGE_KINDS)[number];

/** Name of each edge kind when traversed backwards (to -> from). */
export const REVERSE_EDGE_NAMES: Record<EdgeKind, string> = {
  has_section: 'section_of',
  depends_on: 'blocks',
  follows: 'followed_by',
  extends: 'extended_by',
  supersedes: 'superseded_by',
  conflicts_with: 'conflicted_by',
  relates_to: 'related_by',
  verified_by: 'verification_of',
  spec_depends_on: 'spec_dependency_of',
  component_depends_on: 'component_dependency_of',
  uses_standard: 'used_by',
  mentions_symbol: 'mentioned_in',
  references_code: 'referenced_by',
  in_file: 'has_range',
  in_repo: 'repo_contains',
  targets: 'targeted_by',
  changed: 'changed_by',
  parent: 'child',
  authored_by: 'authored',
  on_branch: 'branch_contains',
  resolves: 'resolved_by',
  duplicate_of: 'duplicated_by',
  related_to: 'related_from',
  covers: 'covered_by',
  similar_to: 'similar_from',
  verifies: 'has_verification_result',
  applied_to: 'has_verification',
  verified_at: 'verifications_at',
  deviates_from: 'deviated_from_by',
  version_of: 'has_version',
  previous_version: 'next_version',
  created_in: 'created',
  excerpt_of: 'has_excerpt',
  claimed_by: 'claims',
  governs: 'governed_by',
  example_of: 'has_example',
  inherits_rule: 'rule_inherited_by',
  affects: 'affected_by',
  owns: 'matched_by_component',
  owned_by: 'owner_of',
  contains: 'contained_in',
  includes: 'included_in',
  audits: 'audited_by',
  checks: 'checked_by',
  audited_at: 'audits_at',
  finding_of: 'has_finding',
  concerns: 'concerned_by',
  found_in: 'has_finding_in',
  fixed_by: 'fixes',
  reported_in: 'reports',
  from_finding: 'followed_up_by',
  touches: 'touched_by',
  has_pr: 'pr_of',
  implements: 'implemented_by',
  merged_as: 'merge_of',
  comments_on: 'has_comment',
  reply_to: 'has_reply',
  caused_by: 'led_to',
  applies_at: 'follows_rule',
  violated_at: 'violates',
  waived_by: 'approves_waiver',
  exempt_from: 'exempts',
  acts_on: 'acted_on_by',
  verified_at_code: 'code_verified_by',
  proven_by: 'proves',
  created_by: 'creator_of',
  filed_by: 'filer_of',
  duplicate_finding_of: 'duplicated_by_finding',
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
  kind: 'spec' | 'standard' | 'section' | 'work_order' | 'feedback' | 'component' | 'audit';
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
  /** The node cap was reached (GQ-14): the neighbourhood is incomplete. */
  truncated?: boolean;
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
    /**
     * Which model answers semantic queries: `current`; `previous` while a new model re-embeds after a switch;
     * `text-only` when no previous model is usable meanwhile; `none` when semantic search is off.
     */
    serving?: { mode: 'current' | 'previous' | 'text-only' | 'none'; modelId: string | null; model: string | null; note?: string };
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
  relationships: { type: string; kind: string; reverse: string; from: string[]; to: string[]; description?: string; deprecated?: boolean }[];
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
  user: 'User',
  branch: 'Branch',
  verification: 'Verification',
  version: 'Version',
  excerpt: 'Excerpt',
  // (added with the components model; the graph side is the graph agent's)
  component: 'Component',
  architecture: 'Architecture',
  audit: 'Audit',
  finding: 'Finding',
  comment: 'Comment',
  question: 'Question',
  pull_request: 'PullRequest',
  code_commit: 'CodeCommit',
} as const satisfies Record<NodeKind, string>;

/** Labels defined by a kind plus a property value. */
export const DERIVED_LABELS = {
  AcceptanceSection: { kind: 'section', prop: 'type', value: 'acceptance' },
  /** A standard's rule section (props: level, rationale, scope, check, examples). */
  Rule: { kind: 'section', prop: 'type', value: 'rule' },
} as const;

/** Relationship type of each edge kind: UPPER_SNAKE. */
export const relTypeOf = (kind: EdgeKind): string => kind.toUpperCase();

/**
 * Relationship types that stand for several edge kinds. `LINKS_TO` (deprecated, one release): the union of the section
 * link kinds (LINK_EDGE_KINDS); `l.rel` still reads the link's rel on them.
 */
export const DERIVED_REL_TYPES: Record<string, { kinds: readonly EdgeKind[]; deprecated?: string }> = {
  LINKS_TO: { kinds: LINK_EDGE_KINDS, deprecated: 'use the per-rel types (:DEPENDS_ON, :FOLLOWS, ...); LINKS_TO and l.rel go away in the next release' },
};

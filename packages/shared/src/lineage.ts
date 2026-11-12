/**
 * Lineage, cause recording and attribution (see plans/lineage-brief.md §2, §6, §7).
 *
 * - Attribution: every write records the triggering USER (server mode only: the GitHub login of the MCP principal, or
 *   `service:<name>` for a named service-account key) and the coding AGENT. Users are never taken from client input.
 *   Trailers: `Mandate-User:` (new) with `Agent-User:` kept for compatibility; `Agent:` for the agent.
 *   Local mode records no user at all (the agent only).
 * - Causes: every MCP write accepts `cause` (refs). Stored as a `Caused-By:` trailer (comma separated) and as temporal
 *   `caused_by` graph edges from every changed node (sections included) to each cause. `Feedback:`, `Work-Order:`,
 *   `Verification:` and `Audit:` trailers produce `caused_by` edges too.
 * - Lineage: a walk over `caused_by` plus structural edges, oriented cause -> effect (LINEAGE_EDGES).
 */
import { z } from 'zod';
import { parseNodeUri } from './refs.js';
import { atSchema, nodeUriSchema } from './search-schemas.js';
import type { CommitPoint, EdgeKind, GraphNodeKind } from './search.js';

/* ------------------------------------------------------------------ attribution */

/** Trailer naming the user who triggered a write (server mode). */
export const USER_TRAILER = 'Mandate-User';
/** Legacy trailer with the same meaning (still written for compatibility). */
export const LEGACY_USER_TRAILER = 'Agent-User';
/** Trailer listing the causes of a write (comma separated references). */
export const CAUSE_TRAILER = 'Caused-By';
/** Prefix of service-account users (`service:<name>`, CI keys created with `mandate key create --service`). */
export const SERVICE_USER_PREFIX = 'service:';

/** Who triggered a write: the user (server mode only) and the coding agent. Old data: agent only. */
export interface Attribution {
  /** GitHub login, or `service:<name>`; absent in local mode and for legacy commits. */
  user?: string;
  /** Coding agent (the `Agent:` trailer / MCP clientInfo name), else the commit author. */
  agent?: string;
  /** When the write happened (ISO). */
  at?: string;
  /** Commit of the write. */
  commit?: string;
}

const findTrailer = (trailers: Record<string, string> | null | undefined, key: string) =>
  Object.entries(trailers ?? {}).find(([k]) => k.toLowerCase() === key.toLowerCase())?.[1];

/** The user of a commit's trailers (`Mandate-User`, else the legacy `Agent-User`). */
export function userOfTrailers(trailers: Record<string, string> | null | undefined): string | undefined {
  return findTrailer(trailers, USER_TRAILER) ?? findTrailer(trailers, LEGACY_USER_TRAILER) ?? undefined;
}

/** The causes recorded in a commit's trailers (`Caused-By`), as given (canonical refs). */
export function causesOfTrailers(trailers: Record<string, string> | null | undefined): string[] {
  const v = findTrailer(trailers, CAUSE_TRAILER);
  return v ? v.split(/[\s,]+/).filter(Boolean) : [];
}

/* ------------------------------------------------------------------ cause */

/** Node kinds a write may name as its cause. */
export const CAUSE_KINDS = ['specs', 'standards', 'components', 'feedback', 'work-orders', 'audits', 'findings', 'verifications', 'comments', 'questions', 'commits'] as const;

/** One cause reference: feedback item, audit finding, work order, spec / standard section, ... (`@mandate:` optional). */
export const causeRefSchema = z
  .string()
  .trim()
  .min(3)
  .max(600)
  .refine((v) => {
    const n = parseNodeUri(v);
    return !!n && (CAUSE_KINDS as readonly string[]).includes(n.kind);
  }, `a cause is a reference to one of: ${CAUSE_KINDS.join(', ')} (e.g. mandate://feedback/fb-01..., mandate://audits/<id>/findings/f1, mandate://work-orders/<id>, mandate://specs/<id>/sections/<sid>)`);
/** The `cause` input of every MCP write tool: one reference or a list (max 20). */
export const causeInputSchema = z.union([causeRefSchema, z.array(causeRefSchema).min(1).max(20)]);
export type CauseInput = z.input<typeof causeInputSchema>;

/* ------------------------------------------------------------------ lineage */

export const LINEAGE_DIRECTIONS = ['up', 'down', 'both'] as const;
export type LineageDirection = (typeof LINEAGE_DIRECTIONS)[number];
/** Status of a node in a lineage view: done (changed), in progress (changing), needs attention, or neutral. */
export const LINEAGE_STATUSES = ['done', 'in_progress', 'attention', 'neutral'] as const;
export type LineageStatus = (typeof LINEAGE_STATUSES)[number];

/**
 * Edges a lineage walk follows, oriented cause -> effect. `forward`: the edge's `from` is the cause (finding
 * -fixed_by-> work order); `reverse`: the edge's `to` is the cause (section -caused_by-> feedback).
 */
export const LINEAGE_EDGES: Partial<Record<EdgeKind, 'forward' | 'reverse'>> = {
  // recorded causes
  caused_by: 'reverse',
  resolves: 'reverse',
  from_finding: 'reverse',
  fixed_by: 'forward',
  reported_in: 'forward',
  finding_of: 'reverse',
  concerns: 'reverse',
  found_in: 'reverse',
  targets: 'reverse',
  // feedback -duplicate_of-> earlier feedback (the original is the cause); related_to: first hop only (L-7)
  duplicate_of: 'reverse',
  related_to: 'reverse',
  // standards in code
  applies_at: 'forward',
  violated_at: 'forward',
  // L-2 / P5: work order -> the feedback it acts on (`reason`), section / spec -> the feedback approving its waiver
  acts_on: 'reverse',
  waived_by: 'reverse',
  verified_at_code: 'forward',
  exempt_from: 'reverse',
  proven_by: 'forward',
  duplicate_finding_of: 'reverse',
  // structure: section links, one orientation per rel (P1). The target is the cause of a dependency / follow /
  // deviation / extension; a superseding section causes the superseded one to go (and a spec section causes what it
  // affects; an acceptance criterion is proven by what verifies it).
  has_section: 'forward',
  depends_on: 'reverse',
  follows: 'reverse',
  deviates_from: 'reverse',
  extends: 'reverse',
  supersedes: 'forward',
  conflicts_with: 'reverse',
  relates_to: 'reverse',
  affects: 'forward',
  verified_by: 'forward',
  spec_depends_on: 'reverse',
  component_depends_on: 'reverse',
  uses_standard: 'reverse',
  inherits_rule: 'reverse',
  contains: 'forward',
  includes: 'forward',
  owns: 'forward',
  references_code: 'forward',
  mentions_symbol: 'forward',
  in_file: 'reverse',
  in_repo: 'reverse',
  example_of: 'reverse',
  verifies: 'reverse',
  applied_to: 'reverse',
  audits: 'reverse',
  checks: 'reverse',
  covers: 'reverse',
  // work orders (touched code / PRs: phase B fills these from the work-order rework)
  touches: 'forward',
  has_pr: 'forward',
  merged_as: 'forward',
  implements: 'reverse',
  comments_on: 'reverse',
  reply_to: 'reverse',
  // history and identity
  changed: 'forward',
  authored_by: 'reverse',
  created_by: 'reverse',
  filed_by: 'reverse',
  on_branch: 'reverse',
  parent: 'reverse',
  version_of: 'reverse',
  previous_version: 'reverse',
  created_in: 'reverse',
  excerpt_of: 'reverse',
};

/**
 * The causal subset walked by default: recorded causes and the meaningful flow (feedback -> change -> work order ->
 * code / PR -> verification -> audit -> finding -> fix). Everything else in LINEAGE_EDGES is structure.
 */
export const CAUSAL_EDGES: EdgeKind[] = [
  'caused_by',
  'resolves',
  'targets',
  'from_finding',
  'fixed_by',
  'reported_in',
  'finding_of',
  'found_in',
  'applies_at',
  'violated_at',
  'touches',
  'has_pr',
  'merged_as',
  'implements',
  'verifies',
  'audits',
  'comments_on',
  'reply_to',
  'changed',
  // L-2: a covered section is a cause of an implement / update / fix work order created after it changed (the walk
  // filters other kinds and applies the time guard).
  'covers',
  // L-7
  'duplicate_of',
  'related_to',
  // P5: the feedback a work order acts on, a waiver's approving feedback, the code a verification ran at, a repeated finding
  'acts_on',
  'waived_by',
  'verified_at_code',
  'duplicate_finding_of',
];

/** Kinds of story event (one per commit and element). */
export const LINEAGE_EVENT_KINDS = ['feedback', 'spec', 'standard', 'component', 'work_order', 'verification', 'audit', 'comment', 'question', 'other'] as const;
export type LineageEventKind = (typeof LINEAGE_EVENT_KINDS)[number];

/** One step of an element's story: what one commit did to one element of the lineage. */
export interface LineageEvent {
  /** `<sha>:<element uri>`. */
  id: string;
  /** Commit time (ISO). */
  at: string;
  commit: string;
  kind: LineageEventKind;
  /** created | edited | status (status / metadata only) | deleted. */
  verb: 'created' | 'edited' | 'status' | 'deleted';
  /** The element (document-level uri: spec, standard, component, work order, feedback, audit, verification, comment). */
  subject: string;
  /** The element's label. */
  label: string;
  /** One short sentence ("Edited 2 sections of Login with SSO", "Verification pass: Session expiry"). */
  text: string;
  /** The commit subject (what the agent said it did). */
  commitSubject: string;
  /** Sections changed (documents). */
  sections?: { uri: string; title: string; action: 'created' | 'modified' | 'deleted' }[];
  linesAdded?: number;
  linesRemoved?: number;
  /** Status of the element after this event (verification result, feedback / work order status when known). */
  status?: string;
  /** Server mode only: the user who triggered it. */
  user?: string;
  agent?: string;
  branch?: string;
  /** Recorded causes of the commit (canonical refs). */
  causes: string[];
  /** The earlier event in this story that caused it (latest event of a cause element before this one). */
  causedBy?: string;
  /** Time since the previous event of the story (ms). */
  gapMs?: number;
  /** Tracked changes of this version (`mandate://specs/<id>@<sha>`), for documents. */
  version?: string;
}

/**
 * Lineage edge kinds per node kind (the contract test asserts every node kind has at least one, and that the fixture
 * graph has lineage for every kind it contains).
 */
export const LINEAGE_KINDS_BY_NODE: Record<GraphNodeKind, EdgeKind[]> = {
  spec: ['has_section', 'spec_depends_on', 'uses_standard', 'caused_by', 'changed', 'audits', 'exempt_from', 'waived_by'],
  standard: ['has_section', 'uses_standard', 'supersedes', 'caused_by', 'changed', 'audits'],
  section: ['has_section', 'caused_by', 'changed', 'references_code', 'affects', 'targets', 'applies_at', 'violated_at', 'inherits_rule', 'depends_on', 'follows', 'deviates_from', 'extends', 'supersedes', 'conflicts_with', 'relates_to', 'verified_by', 'covers', 'waived_by'],
  work_order: ['caused_by', 'acts_on', 'from_finding', 'fixed_by', 'has_section', 'touches', 'has_pr', 'implements', 'comments_on', 'created_by'],
  feedback: ['caused_by', 'resolves', 'reported_in', 'from_finding', 'duplicate_of', 'related_to', 'acts_on', 'waived_by', 'filed_by'],
  symbol: ['mentions_symbol'],
  code_file: ['references_code', 'in_file', 'owns', 'applies_at', 'violated_at', 'touches', 'found_in'],
  code_range: ['references_code', 'in_file', 'applies_at', 'violated_at', 'touches', 'found_in'],
  repo: ['in_repo'],
  commit: ['changed', 'caused_by', 'resolves', 'authored_by', 'parent', 'on_branch', 'created_in'],
  agent: ['authored_by'],
  user: ['authored_by', 'created_by', 'filed_by'],
  branch: ['on_branch'],
  verification: ['verifies', 'applied_to', 'caused_by', 'authored_by', 'applies_at', 'violated_at', 'verified_at_code'],
  version: ['version_of', 'created_in', 'previous_version'],
  excerpt: ['excerpt_of'],
  component: ['affects', 'owns', 'contains', 'includes', 'caused_by', 'changed'],
  architecture: ['includes'],
  audit: ['audits', 'has_section', 'caused_by', 'changed', 'authored_by'],
  finding: ['finding_of', 'concerns', 'found_in', 'fixed_by', 'reported_in', 'from_finding', 'duplicate_finding_of'],
  comment: ['comments_on', 'reply_to', 'caused_by'],
  question: ['concerns', 'caused_by', 'authored_by', 'created_by'],
  pull_request: ['has_pr', 'merged_as'],
  code_commit: ['implements', 'merged_as', 'verified_at_code'],
};

export const lineageInputSchema = z
  .object({
    /** Any reference as copied (`@mandate:` optional; `@sha` pins a version). */
    ref: nodeUriSchema,
    /** up = why (causes), down = led to (effects), both (default). */
    direction: z.enum(LINEAGE_DIRECTIONS).default('both'),
    /** Hops from the element (default 3, max 6). */
    depth: z.number().int().min(1).max(6).default(3),
    /** Time travel: the lineage as of a commit (sha) or date. */
    at: atSchema.optional(),
    /** Only nodes with these statuses (the element itself is always included). */
    status: z.array(z.enum(LINEAGE_STATUSES)).min(1).max(4).optional(),
    /** Only nodes of these kinds (the element itself is always included). */
    kinds: z.array(z.string().min(1).max(40)).max(30).optional(),
    /** Leave out history bookkeeping (commits, versions, agents, branches; default true). */
    hideHistory: z.boolean().default(true),
    /**
     * false (default): CAUSAL lineage only (caused_by and the flow edges in CAUSAL_EDGES: feedback -> change -> work
     * order -> code -> verification -> audit); a document's own sections count as the document. true: also structural
     * edges (has_section, inherits_rule, covers, links_to, applied_to, ...).
     */
    structure: z.boolean().default(false),
    /** Also return the chronological story: one event per commit and element in this lineage (oldest first). */
    story: z.boolean().default(false),
    /** Event cap for the story (newest kept; default 300). */
    eventLimit: z.number().int().min(1).max(2000).default(300),
    /** Node cap (default 300, max 1000). */
    limit: z.number().int().min(1).max(1000).default(300),
  })
  .strict();
export type LineageInput = z.input<typeof lineageInputSchema>;

export interface LineageNode {
  uri: string;
  ref: string;
  kind: GraphNodeKind;
  label: string;
  /** Hops from the element: negative = upstream (causes), positive = downstream (effects), 0 = the element. */
  layer: number;
  status: LineageStatus;
  /** Raw status of the node (spec / work order / feedback / finding status, verification result). */
  rawStatus?: string;
  /** When the node first appeared (its first commit). */
  createdAt?: CommitPoint | null;
  /** Who created it (from the trailers of its first commit), when known. */
  createdBy?: Attribution;
  deleted?: boolean;
  /** External link (pull requests). */
  url?: string;
  /** Work orders: progress, claim, branch and pull requests (open ones are "changing"). */
  progress?: WorkProgress;
}

/** Progress of a work order (from its document: wo-sections, claim, git context). */
export interface WorkProgress {
  sectionsDone: number;
  sectionsTotal: number;
  claimedBy?: string;
  branch?: string;
  prs: { repo: string; number: number; url?: string; status?: string }[];
}

export interface LineageEdge {
  /** Cause. */
  from: string;
  /** Effect. */
  to: string;
  /** The graph edge kind it came from. */
  kind: EdgeKind;
  /** Recorded at write time (caused_by / trailers) vs structural. */
  recorded: boolean;
  /** The commit that recorded it (caused_by edges). */
  commit?: string;
  at?: string;
  /** Where the cause came from: a commit trailer (default), a lineage annotation (`lineage.jsonl`) or a work order's `reason`. */
  source?: 'trailer' | 'annotation' | 'reason';
  /** `low`: an annotation inferred after the fact from circumstantial evidence (shown dashed, "inferred"). */
  confidence?: 'low';
  /** The section / code location the edge actually touches when it is reported on its document (causal mode). */
  via?: string;
}

export interface LineageSummary {
  /** Downstream, done: e.g. sections changed, specs changed, components, files, done work orders. */
  changed: { sections: number; docs: number; components: number; files: number; workOrders: number; commits: number; total: number };
  /** Downstream, in progress (phase B: open work orders with progress, branches, open PRs). */
  changing: {
    workOrders: number;
    findings: number;
    feedback: number;
    /** Open pull requests (of work orders in the lineage). */
    prs: number;
    /** Branches being worked on (claims / git context of open work orders). */
    branches: string[];
    total: number;
    /** `progress`: a short line ("1/2 sections · claimed by x on feat/y · PR #42 open"); `work` the details. */
    items: { uri: string; kind?: GraphNodeKind; label: string; progress?: string; work?: WorkProgress; url?: string }[];
  };
  /** Upstream causes. */
  causes: number;
  /** One line, e.g. "Changed: 3 sections in 2 specs, 1 component · Changing: 1 work order". */
  text: string;
}

export interface LineageResponse {
  root: LineageNode;
  at: CommitPoint | null;
  direction: LineageDirection;
  depth: number;
  nodes: LineageNode[];
  edges: LineageEdge[];
  summary: LineageSummary;
  /** More nodes than `limit` were reachable. */
  truncated: boolean;
  /** Whether structural edges were walked (false = causal lineage only). */
  structure: boolean;
  /** The story (with `story: true`): events oldest first. */
  events?: LineageEvent[];
  /** More events than `eventLimit` (the oldest were dropped). */
  eventsTruncated?: boolean;
  /** Copyable reference of this view (the element, pinned when `at` is set). */
  viewRef: string;
}

/* ------------------------------------------------------------------ blast radius */

export const blastRadiusInputSchema = z
  .object({
    ref: nodeUriSchema,
    at: atSchema.optional(),
    /** Cap per group (default 50). */
    limit: z.number().int().min(1).max(500).default(50),
  })
  .strict();
export type BlastRadiusInput = z.input<typeof blastRadiusInputSchema>;

export interface BlastItem {
  uri: string;
  kind: GraphNodeKind;
  label: string;
  status?: string;
  /** Why it is impacted (edge path, e.g. "depends_on", "uses_standard", "owns"). */
  via: string;
}

export interface BlastRadiusResponse {
  root: { uri: string; kind: GraphNodeKind; label: string };
  at: CommitPoint | null;
  /** Specs that depend on it (transitively) or link to its sections. */
  dependentSpecs: BlastItem[];
  /** Specs / sections following a standard (or a rule). */
  followers: BlastItem[];
  /** Code owned by the element's components or referenced by its sections. */
  ownedCode: BlastItem[];
  components: BlastItem[];
  /** Open work orders on the same specs (phase B: and on the same files). */
  openWorkOrders: BlastItem[];
  /** Open feedback / findings on the same specs. */
  openIssues: BlastItem[];
  total: number;
  text: string;
}

/* ------------------------------------------------------------------ where standards are used */

export const whereUsedInputSchema = z
  .object({
    /** A standard or one of its rule sections. */
    ref: nodeUriSchema,
    limit: z.number().int().min(1).max(2000).default(500),
  })
  .strict();
export type WhereUsedInput = z.input<typeof whereUsedInputSchema>;

export type UsageState = 'compliant' | 'violating' | 'unchecked';

export interface UsageLocation {
  /** Code file or range reference. */
  uri: string;
  repo: string;
  path: string;
  lines?: { start: number; end: number };
  state: UsageState;
  /** The rule section it follows / violates. */
  rule: string;
  ruleTitle?: string;
  /** The component owning the file (most specific glob). */
  component?: string | null;
  /** Evidence: the verification, finding or explicit ref that recorded it. */
  source?: string;
  at?: string;
}

export interface WhereUsedResponse {
  standard: string;
  rule?: string;
  locations: UsageLocation[];
  /** Grouped by component (null = no owner). */
  byComponent: { component: string | null; label: string; compliant: number; violating: number; unchecked: number }[];
  coverage: {
    /** Files in scope of the standard's / rule's appliesTo globs (known to the graph). */
    inScope: number;
    /** In-scope files with at least one recorded check. */
    checked: number;
    violating: number;
    /** In-scope files never checked (first `limit`). */
    unchecked: string[];
    /** checked / inScope (0..1; null when nothing is in scope). */
    ratio: number | null;
  };
}

/** Code-ref tooltip: the rules a code location follows or violates. */
export const codeRulesInputSchema = z.object({ ref: nodeUriSchema }).strict();
export type CodeRulesInput = z.input<typeof codeRulesInputSchema>;
export interface CodeRulesResponse {
  ref: string;
  follows: { rule: string; standard: string; label: string; source?: string }[];
  violates: { rule: string; standard: string; label: string; source?: string }[];
}

/* ------------------------------------------------------------------ recent writers (doctor / Settings) */

export const writersInputSchema = z.object({ limit: z.number().int().min(1).max(2000).default(500) }).strict();
export interface WritersResponse {
  mode: 'local' | 'server' | null;
  /** Recent commits grouped by (user, agent, credential). */
  writers: { user: string | null; agent: string | null; source: string | null; commits: number; last: string }[];
  /** Commits without a user in server mode (legacy or shared keys). */
  unattributed: number;
  /** Commits made by service accounts. */
  service: number;
  scanned: number;
}

/* ------------------------------------------------------------------ contributors (server mode: users only) */

export const contributorsInputSchema = z
  .object({
    /** Elements (any reference: document, section, work order, feedback, audit, finding, ...). */
    refs: z.array(nodeUriSchema).min(1).max(100),
    /** Hops of `caused_by` followed for indirect contributors (0 = direct only; default 2). */
    depth: z.number().int().min(0).max(4).default(2),
    at: atSchema.optional(),
  })
  .strict();
export type ContributorsInput = z.input<typeof contributorsInputSchema>;

/** created | edited | claimed | commented | verified | closed | accepted | audited | rechecked | ... */
export type ContributorRole = string;

export interface Contributor {
  /** GitHub login or service:<name>; the agent name when no user was recorded (`userRecorded: false`). */
  user: string;
  /** false: no user on the commits (legacy data, local mode): `user` is the agent identity. */
  userRecorded: boolean;
  /** direct: wrote to the element (or its sections, comments, verifications); via: contributed to a cause of it. */
  kind: 'direct' | 'via';
  roles: ContributorRole[];
  /** Contributions (commits) counted. */
  count: number;
  lastAt: string;
  /** Coding agents the user acted through. */
  agents: string[];
  /** kind via: the cause chain from the element outwards (nearest cause first). */
  via?: { uri: string; kind: GraphNodeKind; label: string }[];
  /** kind direct: causes the user also contributed through. */
  alsoVia?: { uri: string; kind: GraphNodeKind; label: string }[];
}

export interface ContributorsResponse {
  /** Per requested ref (canonical uri): direct contributors first (most recent first), then indirect ones. */
  contributors: Record<string, Contributor[]>;
}

/* ------------------------------------------------------------------ user directory (server mode) */

export const usersResolveInputSchema = z.object({ logins: z.array(z.string().trim().min(1).max(200)).min(1).max(200) }).strict();
export type UsersResolveInput = z.input<typeof usersResolveInputSchema>;
export interface DirectoryUser {
  login: string;
  name: string | null;
  /** Avatar image URL (GitHub; null for service accounts). */
  avatarUrl: string | null;
  /** Signed in to this server at least once. */
  known: boolean;
  service: boolean;
}
export interface UsersResolveResponse {
  users: DirectoryUser[];
}

/* ------------------------------------------------------------------ lineage annotations */

/** Data-repo file of lineage annotations (append-only; history itself is never rewritten). */
export const LINEAGE_ANNOTATIONS_FILE = 'lineage.jsonl';
/** Trailer marking migration / bulk commits: they record no causes (L-1). Any value but `no` / `false`. */
export const MIGRATION_TRAILER_KEY = 'Mandate-Migration';

/** One lineage annotation: causes recorded after the fact for a past commit of the data repo. Frozen once written. */
export const lineageAnnotationSchema = z
  .object({
    id: z.string().min(1),
    /** Full sha of the annotated data-repo commit. */
    commit: z.string().regex(/^[0-9a-f]{40}$/),
    /** Canonical cause references (validated like `cause`). */
    causes: z.array(z.string().min(3)).min(1).max(20),
    note: z.string().trim().min(1).max(2000),
    /** Who annotated: the server principal (the user in server mode), else the agent. */
    by: z.string().min(1),
    at: z.string(),
    /** `low`: inferred from circumstantial evidence (no record names the cause); omitted = asserted. */
    confidence: z.literal('low').optional(),
  })
  .strict();
export type LineageAnnotation = z.infer<typeof lineageAnnotationSchema>;

/** `lineage_annotate` input: a past commit (sha or unique prefix), its causes and why. */
export const lineageAnnotateInputSchema = z
  .object({
    commit: z.string().trim().regex(/^[0-9a-f]{7,40}$/, 'a commit sha (7..40 hex characters) of the data repo'),
    causes: causeInputSchema,
    note: z.string().trim().min(1).max(2000),
    /** `low` when the cause is inferred from circumstantial evidence rather than named by a record. */
    confidence: z.literal('low').optional(),
  })
  .strict();
export type LineageAnnotateInput = z.input<typeof lineageAnnotateInputSchema>;

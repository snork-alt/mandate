import { parseNodeUri, parseRef } from './refs.js';
import { auditCodeRefSchema, findingUriSchema, type LastAudit, type SpecAudits, type StandardAudits } from './audits.js';
import type { SpecMaturity } from './maturity.js';
import { gitContextSchema, pastClaimSchema, touchedFileSchema, type CommentCounts, type CommentThread, type GitContext, type PastClaim, type TouchedFile } from './work-orders.js';
import { z } from 'zod';
import { layerSchema, type LayerInfo } from './layers.js';
import { idSchema, STORED_SPEC_STATUSES, PRIORITIES, exemptionSchema, appliesToSchema, WORK_ORDER_KINDS, FEEDBACK_KINDS, FEEDBACK_RESOLUTIONS, VERIFICATION_RESULTS, VERIFICATION_METHODS, SPEC_STATUSES, WORK_ORDER_STATUSES, FEEDBACK_STATUSES, CRITERION_STATES, STANDARD_STATUSES, COMPONENT_STATUSES } from './base.js';
// Leaf module (no imports from this file): modules re-exported below can use these at load time without a cycle.
export { idSchema, STORED_SPEC_STATUSES, PRIORITIES, exemptionSchema, appliesToSchema, WORK_ORDER_KINDS, FEEDBACK_KINDS, FEEDBACK_RESOLUTIONS, VERIFICATION_RESULTS, VERIFICATION_METHODS, SPEC_STATUSES, WORK_ORDER_STATUSES, FEEDBACK_STATUSES, CRITERION_STATES, STANDARD_STATUSES, COMPONENT_STATUSES } from './base.js';
import { parseLinkTarget, sectionSchema, type CodeRef, type Section, type SectionInput, type SectionType } from '@mandate/doc';

/**
 * Entity kinds stored in the git repo: specs and standards as one markdown
 * file per entity (`<kind>/<id>.md`, work orders and audits too), feedback / verifications / comments as JSON Lines.
 */
export const ENTITY_KINDS = ['specs', 'standards', 'components', 'work-orders', 'feedback', 'audits'] as const;
export type EntityKind = (typeof ENTITY_KINDS)[number];

/** Slug used as the file name: `<kind>/<id>.md`. */

/* ---------- File metadata (derived from git, never stored in files) ---------- */

/** Created/updated time and last author of an entity's file, derived from `git log`. */
export interface FileMeta {
  createdAt: string;
  updatedAt: string;
  /** Agent trailer of the last commit, else its author name. */
  updatedBy: string | null;
  /** Number of commits that touched the file. */
  revisions: number;
  /** Same as `revisions`: the number of versions of the file. */
  versionCount: number;
  /** Latest commit that changed the file (null when uncommitted). */
  lastCommit: string | null;
  /** Who created the file (first commit): user and coding agent. */
  createdBy?: import('./lineage.js').Attribution;
  /** Who made the last change. */
  lastEditedBy?: import('./lineage.js').Attribution;
}

/** One commit in a file's history. `Agent:` / `Branch:` commit trailers are surfaced separately. */
export interface HistoryEntry {
  commit: string;
  subject: string;
  body: string;
  author: string;
  email: string;
  date: string;
  trailers: Record<string, string>;
  agent?: string;
  branch?: string;
  /** The user who triggered the write (`Mandate-User` / `Agent-User` trailer); absent on older agent-only commits. */
  user?: string;
  /** Recorded causes of the write (`Caused-By` trailer). */
  causes?: string[];
  /** Team: co-authors (`Co-authored-by:` logins: contributors of the causes). */
  coAuthors?: string[];
  /** What the commit changed in the document: section text, the status field, other metadata. */
  changes?: ('text' | 'status' | 'metadata')[];
}

/** One version of a file and the version it is compared with (MCP `version_get`). */
export interface FileVersion {
  path: string;
  /** Full id of the requested commit. */
  commit: string;
  /** Commit the comparison starts from: the previous version of the file, or the requested commit itself when compared with HEAD. */
  base: string | null;
  /** `parent`: changes made in this commit; `head`: from this commit to the current version. */
  against: 'parent' | 'head';
  status: 'added' | 'modified' | 'deleted' | 'unchanged';
  before: string | null;
  after: string | null;
  meta: HistoryEntry;
  /** Neighbouring versions of this file (for prev/next navigation). */
  older: string | null;
  newer: string | null;
  /** 1-based position among the file's versions (oldest = 1) and their count. */
  index: number;
  total: number;
}

/* ---------- Specs (structured docs, see @mandate/doc) ---------- */

/** Spec statuses as shown: `in_progress` is DERIVED (an open work order on the spec is claimed), never stored. */
export const specStatusSchema = z.enum(SPEC_STATUSES);
export type SpecStatus = z.infer<typeof specStatusSchema>;
/** Statuses stored in the spec file. */
export type StoredSpecStatus = (typeof STORED_SPEC_STATUSES)[number];
/** Reads tolerate the legacy stored `in_progress` (it means `ready` + a claimed work order). */
export const storedSpecStatusSchema = z.preprocess((v) => (v === 'in_progress' ? 'ready' : v), z.enum(STORED_SPEC_STATUSES));


/** p0 = urgent ... p3 = low. */
export const prioritySchema = z.enum(PRIORITIES);
export type Priority = z.infer<typeof prioritySchema>;

const commitish = z.preprocess((v) => (typeof v === 'number' ? String(v) : v), z.string().min(4));

/**
 * Which agent works on a work order, where (present only while the work order is open). `heartbeatAt` is NOT stored in
 * git: reads fill it from the server's runtime state (the last heartbeat; after a server restart, the claim counts as
 * fresh until CLAIM_STALE_AFTER_MS since startup).
 */
export const claimSchema = z.object({
  agent: z.string().min(1),
  branch: z.string().min(1).optional(),
  worktree: z.string().min(1).optional(),
  startedAt: z.string().min(1),
  heartbeatAt: z.string().min(1),
});
export type Claim = z.infer<typeof claimSchema>;
/** A claim without a heartbeat for this long is stale (another agent may take the work order over). */
export const CLAIM_STALE_AFTER_MS = 30 * 60_000;
export const isClaimStale = (claim: Pick<Claim, 'heartbeatAt'>, now = Date.now()) => {
  const t = Date.parse(claim.heartbeatAt);
  return Number.isNaN(t) || now - t > CLAIM_STALE_AFTER_MS;
};

/** A spec's exemption from a standard that applies to it through `appliesTo`. */
export type Exemption = z.infer<typeof exemptionSchema>;

/** One criterion as it stood when the spec passed the done gate. */
export const gateCriterionSchema = z.object({
  uri: z.string(),
  /** Content hash of the criterion (title, body, method, threshold). */
  hash: z.string(),
  /** State at done (only `must` criteria had to be verified or waived). */
  state: z.enum(['verified', 'waived', 'failing', 'stale', 'unverified', 'unknown']),
  /** Verification record that satisfied it. */
  record: z.string().optional(),
  /** Feedback item approving the waiver. */
  feedback: z.string().optional(),
});
/** Done-gate snapshot: what "done" was proven against (C1). */
export const gateSnapshotSchema = z.object({
  /** HEAD when the gate passed (full sha). */
  commit: z.string().optional(),
  at: z.string(),
  criteria: z.array(gateCriterionSchema).default([]),
});
export type GateSnapshot = z.infer<typeof gateSnapshotSchema>;

/** Spec frontmatter (everything except `sections`, which @mandate/doc manages). */
export const specFrontmatterSchema = z.object({
  title: z.string().trim().min(1),
  summary: z.string().optional(),
  category: z.string().min(1).optional(),
  status: storedSpecStatusSchema.default('draft'),
  priority: prioritySchema.optional(),
  tags: z.array(z.string().min(1)).default([]),
  owner: z.string().min(1).optional(),
  repo: z.string().min(1).optional(),
  /** Mandate repo commit of the spec version that was last marked done (full sha). */
  implementedCommit: commitish.optional(),
  /** Opt-outs from standards that apply through `appliesTo` (approved like waivers: accepted feedback by someone else). */
  exemptFrom: z.array(exemptionSchema).default([]),
  /** Done-gate snapshot recorded when the spec moved to done (server-set). */
  gate: gateSnapshotSchema.optional(),
});
export type SpecFrontmatter = z.infer<typeof specFrontmatterSchema>;

/** A spec as stored: frontmatter + id (file name) + sections. */
export const specSchema = specFrontmatterSchema.extend({
  id: idSchema,
  sections: z.array(sectionSchema),
});
export type StoredSpec = z.infer<typeof specSchema>;
/** A spec as returned by the API (`verification` rollup in lists, full detail on GET by id). */
export type Spec = Omit<StoredSpec, 'status'> &
  FileMeta & {
    /** Shown status (`in_progress` derived from claimed work orders). */
    status: SpecStatus;
    /** The stored status (without the derived `in_progress`). */
    storedStatus?: StoredSpecStatus;
    verification?: VerificationRollup | SpecVerification;
    links?: DocLinks;
    /** Sections blocked by section-level depends_on (lists). */
    blockedSections?: string[];
    /** Last completed audit (null = never audited). */
    lastAudit?: LastAudit | null;
    /** Detail: latest audit, history and findings. */
    audits?: SpecAudits;
    /** How far the feature really is (derived ladder + overlays; the stored status is unchanged). */
    maturity?: SpecMaturity;
  } & Partial<SpecDerived>;

/** One criterion involved in a spec's drift: each criterion appears once, with every reason that applies. */
export interface DriftCriterion {
  /** Acceptance or rule section URI (a spec section, or a standard section for inherited rules). */
  uri: string;
  title: string;
  state: CriterionStateName;
  reasons: ('added' | 'changed' | 'unverified')[];
}
/** Structured drift of a done spec (see SpecDerived.drift for the same as sentences). */
export interface DriftDetail {
  /** The done-gate snapshot: when and at which commit the spec passed. */
  gate?: { at: string; commit?: string };
  noSnapshot: boolean;
  /** Criteria in the snapshot that no longer exist. */
  removed: number;
  criteria: DriftCriterion[];
  dependencies: ('broken' | 'blocked')[];
}

/** Facts derived for a spec (lists and detail). */
export interface SpecDerived {
  /** Specs this one depends on (derived from its sections' depends_on links). */
  dependsOn: string[];
  /** Standards in force: from the sections' `follows` links plus `appliesTo` matches (minus exemptions). */
  standards: { id: string; title: string | null; sections: { id: string; target: string }[]; appliesBy: string[]; exempt?: boolean }[];
  /** Active claims, via the spec's open work orders. */
  claims: { workOrder: string; kind: WorkOrderKind; sections: string[]; claim: Claim }[];
  /** Done specs that no longer satisfy their gate (C1); empty / absent when not drifted. */
  drift: string[];
  /** The same drift, structured for display (absent when not drifted). */
  driftDetail?: DriftDetail;
  /** Sections whose depends_on target is archived or missing. */
  brokenSections: string[];
  /** Non-blocking warnings (e.g. done with zero criteria). */
  warnings: string[];
}
export type { Section, SectionInput, SectionType, CodeRef };

/** A registered section type, as listed by the MCP tool `section_types`. */
export interface SectionTypeInfo {
  id: string;
  label: string;
  description?: string;
  /** Fence language the body is stored in; absent = raw markdown. */
  fence?: string;
}

/* ---------- Standards (structured docs, same format as specs) ---------- */

/** `appliesTo` selector: `repo:app`, `tag:api`, `category:billing`, `path:<glob>` or `lang:<language>`. */

/** Standard lifecycle: drafts never apply; deprecated standards still apply but point at their successor. */
export type StandardStatus = (typeof STANDARD_STATUSES)[number];

/** Standard frontmatter (everything except `sections`). */
export const standardFrontmatterSchema = z.object({
  title: z.string().trim().min(1),
  summary: z.string().optional(),
  /** Lifecycle (default active). */
  status: z.enum(STANDARD_STATUSES).default('active'),
  /** In force from this ISO date or commit (sha); before that its rules are announced, not required. */
  effectiveFrom: z.string().min(4).optional(),
  /** The successor (required when deprecated). */
  supersededBy: idSchema.optional(),
  tags: z.array(z.string().min(1)).default([]),
  owner: z.string().min(1).optional(),
  appliesTo: z.array(appliesToSchema).default([]),
});
export type StandardFrontmatter = z.infer<typeof standardFrontmatterSchema>;

export const standardSchema = standardFrontmatterSchema.extend({
  id: idSchema,
  sections: z.array(sectionSchema),
});
export type StoredStandard = z.infer<typeof standardSchema>;
export type Standard = StoredStandard & FileMeta & {
  /** Checklist + per-spec matrix (GET by id). */
  verification?: StandardVerification;
  /** Detail: audits of the standard and the compliance view (latest result per rule per spec audited against it). */
  audits?: StandardAudits;
  /** Last completed audit of the standard itself (null = never audited). */
  lastAudit?: LastAudit | null;
  links?: DocLinks;
  /** Number of non-archived specs using this standard (any way). */
  usedBy?: number;
  /** Rules per level (lists). */
  ruleCounts?: Record<'must' | 'should' | 'may', number>;
  /** Not in force yet (draft, or effectiveFrom in the future / not reached). */
  inForce?: boolean;
};

/* ---------- Code scope (globs, languages) ---------- */

const LANGUAGES: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript', js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  py: 'python', go: 'go', rs: 'rust', java: 'java', kt: 'kotlin', rb: 'ruby', php: 'php', cs: 'csharp', swift: 'swift', sql: 'sql',
  css: 'css', scss: 'css', html: 'html', md: 'markdown', json: 'json', yaml: 'yaml', yml: 'yaml', sh: 'shell', tf: 'terraform',
};
/** Language of a file from its extension (`src/a.ts` -> `typescript`). */
export function languageOf(path: string): string | null {
  const ext = /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase();
  return ext ? (LANGUAGES[ext] ?? ext) : null;
}

/** Glob match over repo paths: `**` (any directories), `*` (within a segment), `?`, `{a,b}`. */
export function globMatch(glob: string, path: string): boolean {
  const p = path.replace(/^\/+/, '');
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') {
          i++;
          re += '(?:.*/)?';
        } else re += '.*';
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if (c === '{') {
      const end = glob.indexOf('}', i);
      re += `(?:${glob.slice(i + 1, end).split(',').map((x) => x.replace(/[.+^$()|[\]\\]/g, '\\$&')).join('|')})`;
      i = end;
    } else re += c.replace(/[.+^$()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`).test(p.replace(/^\.\//, '').replace(/^\/+/, '')) || new RegExp(`^${re}$`).test(p);
}

/** Does code (path) fall in a scope (paths globs AND languages; an absent part matches everything)? */
export function inScope(scope: { paths?: string[]; languages?: string[] } | undefined, path: string): boolean {
  if (!scope) return true;
  if (scope.paths?.length && !scope.paths.some((g) => globMatch(g, path))) return false;
  if (scope.languages?.length && !scope.languages.includes(languageOf(path) ?? '')) return false;
  return true;
}

/* ---------- Components (architecture) ---------- */

export const COMPONENT_KINDS = ['service', 'module', 'library', 'datastore', 'external'] as const;
export type ComponentKind = (typeof COMPONENT_KINDS)[number];

/** Code a component owns: path globs in one repository. */
export const ownsSchema = z.object({ repo: z.string().min(1), paths: z.array(z.string().min(1)).min(1) });

/** Component frontmatter (sections: responsibility, interfaces, context (mermaid), rationale (optional)). */
export const componentFrontmatterSchema = z.object({
  title: z.string().trim().min(1),
  summary: z.string().optional(),
  kind: z.enum(COMPONENT_KINDS),
  owns: z.array(ownsSchema).default([]),
  tags: z.array(z.string().min(1)).default([]),
  owner: z.string().min(1).optional(),
  status: z.enum(COMPONENT_STATUSES).default('active'),
  /** Architecture layer (ui, api, service, domain, data, infra or any slug); omitted: derived from depends_on. */
  layer: layerSchema.optional(),
  /** Containing component (containment is a tree: one parent, no cycles). */
  parent: idSchema.optional(),
});
export type ComponentFrontmatter = z.infer<typeof componentFrontmatterSchema>;
export const componentSchema = componentFrontmatterSchema.extend({ id: idSchema, sections: z.array(sectionSchema) });
export type StoredComponent = z.infer<typeof componentSchema>;
export const createComponentSchema = componentFrontmatterSchema.extend({ id: idSchema.optional(), sections: z.array(sectionSchema).default([]) });
export type CreateComponentInput = z.input<typeof createComponentSchema>;
export const updateComponentSchema = z.object({
  title: z.string().trim().min(1).optional(),
  summary: z.string().nullable().optional(),
  kind: z.enum(COMPONENT_KINDS).optional(),
  owns: z.array(ownsSchema).optional(),
  tags: z.array(z.string().min(1)).optional(),
  owner: z.string().min(1).nullable().optional(),
  status: z.enum(COMPONENT_STATUSES).optional(),
  layer: layerSchema.nullable().optional(),
  parent: idSchema.nullable().optional(),
  sections: z.array(sectionSchema).optional(),
});
export type UpdateComponentInput = z.input<typeof updateComponentSchema>;

/** Specificity of a glob: literal characters count, wildcards cost (the most specific owner wins). */
export function globSpecificity(glob: string): number {
  const literal = glob.replace(/\*\*|\*|\?|\{[^}]*\}/g, '').length;
  const wild = (glob.match(/\*\*/g)?.length ?? 0) * 3 + (glob.replace(/\*\*/g, '').match(/[*?]/g)?.length ?? 0);
  return literal * 10 - wild;
}

/** The owning component of a code path: glob match on `owns`, the most specific match wins; archived components own nothing. */
export function ownerOf<C extends Pick<StoredComponent, 'id' | 'owns'> & { status?: string }>(repo: string | undefined, path: string, components: C[]): { component: C; glob: string } | null {
  let best: { component: C; glob: string; score: number } | null = null;
  for (const c of components) {
    if (c.status === 'archived') continue;
    for (const o of c.owns) {
      if (repo && o.repo !== repo) continue;
      for (const g of o.paths) {
        if (!globMatch(g, path)) continue;
        const score = globSpecificity(g);
        if (!best || score > best.score) best = { component: c, glob: g, score };
      }
    }
  }
  return best ? { component: best.component, glob: best.glob } : null;
}

/** Ancestors of a component through `parent` (nearest first; stops at a missing parent or a cycle). */
export function componentAncestors<C extends { id: string; parent?: string }>(id: string, components: C[]): C[] {
  const byId = new Map(components.map((c) => [c.id, c]));
  const out: C[] = [];
  const seen = new Set([id]);
  for (let p = byId.get(id)?.parent; p && !seen.has(p) && byId.has(p); p = byId.get(p)!.parent) {
    seen.add(p);
    out.push(byId.get(p)!);
  }
  return out;
}

/** Derived facts of a component (lists and detail). */
export interface ComponentDerived {
  /** Components this one depends on / that depend on it. */
  dependsOn: string[];
  dependents: string[];
  /** Containment: its parent chain (nearest first) and direct children. */
  ancestors: { id: string; title: string }[];
  children: { id: string; title: string; status: (typeof COMPONENT_STATUSES)[number] }[];
  /** Spec sections affecting it (affects links) and spec sections whose code refs it owns. */
  affectedBy: { spec: string; title: string; sections: string[]; via: ('affects' | 'owns')[] }[];
  /** Open work orders on those spec sections (with claims). */
  workOrders: { id: string; spec: string; kind: string; status: string; claim?: Claim }[];
  /** Open (and accepted) feedback targeting its sections. */
  openFeedback: number;
  /** Rules that apply: follows links, appliesTo (component / componentKind) and rules scoped to its owned paths. */
  rules: { uri: string; title: string; level: 'must' | 'should' | 'may'; standard: string; via: string }[];
  /** Its sections with "Upstream changed" (an interface it depends on changed). */
  upstreamChanged: string[];
  /** States of the affecting specs. */
  specStates: { drifted: number; blocked: number; failing: number };
  /** Coverage: owns globs that match no known code ref. */
  emptyGlobs: string[];
  /** Reference gaps of an active component (the `component_*` integrity warnings), each with a suggested fix. */
  gaps?: ComponentGap[];
}

/** A reference gap of an active component: nothing affects it, it follows no standard, or it declares no code. */
export interface ComponentGap {
  rule: 'component_unreferenced' | 'component_no_standards' | 'component_no_code';
  message: string;
  /** One-line suggested fix. */
  hint: string;
}
export type Component = StoredComponent & FileMeta & Partial<ComponentDerived> & { links?: DocLinks };

/** Generated architecture view (`architectureGet`). */
export const architectureGetInputSchema = z
  .object({
    /** Compute at this commit (default HEAD). */
    at: z.string().min(4).optional(),
    /** Compare with this (older) commit: added / removed / changed nodes and edges. */
    compare: z.string().min(4).optional(),
    /** Highlight a component's upstream and downstream. */
    focus: z.string().min(1).optional(),
    /** Show archived components (hidden by default). */
    includeArchived: z.boolean().default(false),
    groupBy: z.enum(['repo', 'kind']).default('repo'),
    format: z.enum(['graph', 'mermaid']).default('graph'),
  })
  .strict();
export type ArchitectureGetInput = z.input<typeof architectureGetInputSchema>;

export type DiffState = 'added' | 'removed' | 'changed' | 'unchanged';
export interface ArchitectureNode {
  id: string;
  uri: string;
  title: string;
  kind: ComponentKind;
  status: (typeof COMPONENT_STATUSES)[number];
  summary?: string;
  /** First paragraph of the responsibility section (hover summary). */
  responsibility?: string;
  group: string;
  repos: string[];
  /** Effective layer (explicit `layer`, inherited from its parent, or derived from depends_on) and where it came from. */
  layer: string;
  layerSource: 'explicit' | 'inherited' | 'derived';
  /** Containment: the containing component (when shown) and the direct children shown. */
  parent?: string;
  children: string[];
  /** Code it owns, as `repo:glob` (hover hint). */
  owns: string[];
  overlay: {
    workOrders: number;
    claims: string[];
    specs: number;
    /** Distinct standards its sections follow. */
    standards: number;
    openFeedback: number;
    drifted: number;
    blocked: number;
    upstreamChanged: number;
    failing: number;
  };
  /** Focus mode: role relative to the focused component. */
  focus?: 'focus' | 'upstream' | 'downstream' | 'other';
  diff?: DiffState;
}
export interface ArchitectureEdge {
  from: string;
  to: string;
  /** Target interface section title, when the link targets a section. */
  label?: string;
  section?: string;
  focus?: boolean;
  diff?: DiffState;
  /** The edge points upward: the dependent sits in a lower layer than its dependency. */
  violation?: boolean;
}
export interface ArchitectureGraph {
  /** `mandate://architecture[@sha][?focus=<id>]`. */
  ref: string;
  commit: string | null;
  compare: string | null;
  groupBy: 'repo' | 'kind';
  groups: { id: string; label: string }[];
  /** Layers top to bottom (the vertical layout and the Mermaid subgraphs). */
  layers: LayerInfo[];
  nodes: ArchitectureNode[];
  edges: ArchitectureEdge[];
  /** format=mermaid: the flowchart (top to bottom, one subgraph per layer). */
  mermaid?: string;
}

/** A rule (or criterion) hit for a piece of code (`rulesForCode`). */
export interface RuleHit {
  uri: string;
  standard: string;
  standardTitle: string;
  title: string;
  level: 'must' | 'should' | 'may';
  rationale?: string;
  check?: { kind: string; command?: string; ruleId?: string; note?: string };
  /** Why it applies: the code matches the rule's / standard's scope, or a spec section referencing the code inherits it. */
  why: ('scope' | 'section')[];
  /** Spec sections referencing this code that inherit the rule. */
  sections: string[];
  /** The standard is deprecated (with its successor). */
  deprecated?: { supersededBy?: string };
}

export const rulesForCodeInputSchema = z.object({
  /** Omit to match the path in any repository. */
  repo: z.string().min(1).optional(),
  path: z.string().min(1),
  /** `12` or `12-40`. */
  lines: z.string().regex(/^\d+(?:-\d+)?$/).optional(),
}).strict();
export type RulesForCodeInput = z.infer<typeof rulesForCodeInputSchema>;

/** An automated check to run for a spec (`ruleCheckPlan`, for agents and CI). */
export interface RuleCheckItem {
  criterion: string;
  title: string;
  level: 'must' | 'should' | 'may';
  check: { kind: 'lint' | 'test' | 'script' | 'review'; command?: string; ruleId?: string; note?: string };
  /** Current state for the spec. */
  state: string;
  /** Spec sections following it ([] = spec-wide). */
  sections: string[];
  path?: string[];
}
export const ruleCheckPlanInputSchema = z.object({ spec: z.string().min(1) }).strict();
export type RuleCheckPlanInput = z.infer<typeof ruleCheckPlanInputSchema>;

/** How one spec uses a standard (MCP `standard_usage`). */
export interface StandardUsage {
  specId: string;
  title: string;
  status: SpecStatus;
  category?: string;
  /** Sections following the standard (whole or one of its sections). */
  sections: { id: string; title: string }[];
  /** `appliesTo` rules of the standard that match the spec (empty when the spec is exempt). */
  appliesBy: string[];
  /** Spec sections with a `follows` link to this standard (`target`: the whole standard or one section). */
  follows: { id: string; title: string; target: string }[];
  /** Spec sections with a `deviates_from` link to this standard (with the justification). */
  deviations: { id: string; title: string; target: string; note: string; feedback?: string }[];
  /** The spec is exempt from this standard's `appliesTo` (approved exemption). */
  exempt?: boolean;
}

/**
 * `appliesTo` rules of a standard that match a spec: `repo:x`, `tag:x`, `category:x` on the spec's
 * fields; `path:<glob>` and `lang:<language>` on the code its sections reference.
 */
export function matchingAppliesTo(
  rules: string[],
  spec: Pick<StoredSpec, 'repo' | 'tags' | 'category'> & { sections?: Pick<Section, 'refs'>[] },
  /** Components the spec (or the component itself) touches: `component:<id>` / `componentKind:<kind>`. */
  components: { id: string; kind: string }[] = [],
): string[] {
  const paths = (spec.sections ?? []).flatMap((s) => (s.refs ?? []).map((r) => r.path));
  return rules.filter((rule) => {
    const i = rule.indexOf(':');
    const kind = rule.slice(0, i);
    const value = rule.slice(i + 1);
    if (kind === 'repo') return spec.repo === value;
    if (kind === 'tag') return spec.tags.includes(value);
    if (kind === 'category') return spec.category === value;
    if (kind === 'path') return paths.some((p) => globMatch(value, p));
    if (kind === 'lang') return paths.some((p) => languageOf(p) === value);
    if (kind === 'component') return components.some((c) => c.id === value);
    if (kind === 'componentKind') return components.some((c) => c.kind === value);
    return false;
  });
}

/** Is `uri` (a link target) this standard or one of its sections? */
export const targetsStandard = (uri: string, standardId: string) => {
  const t = parseLinkTarget(uri);
  return !!t && t.kind === 'standards' && t.id === standardId;
};

/**
 * Every spec using a standard: through its sections' `follows` links (the whole standard or one of
 * its sections) or `appliesTo` (unless exempt). Archived sections do not count.
 */
export function standardUsage(standard: Pick<StoredStandard, 'id' | 'appliesTo'>, specs: Pick<StoredSpec, 'id' | 'title' | 'status' | 'category' | 'repo' | 'tags' | 'sections' | 'exemptFrom'>[]): StandardUsage[] {
  const out: StandardUsage[] = [];
  for (const spec of specs) {
    const exempt = (spec.exemptFrom ?? []).some((e) => e.standard === standard.id);
    const appliesBy = exempt ? [] : matchingAppliesTo(standard.appliesTo, spec);
    const links = spec.sections.filter((s) => !s.archived).flatMap((s) => (s.links ?? []).filter((l) => targetsStandard(l.to, standard.id)).map((l) => ({ s, l })));
    const follows = links.filter((x) => x.l.rel === 'follows').map(({ s, l }) => ({ id: s.id, title: s.title, target: l.to }));
    const deviations = links
      .filter((x) => x.l.rel === 'deviates_from')
      .map(({ s, l }) => ({ id: s.id, title: s.title, target: l.to, note: l.note ?? '', ...(l.feedback ? { feedback: l.feedback } : {}) }));
    // A `follows` link counts as using the standard (deviations alone do not).
    if (appliesBy.length || follows.length || exempt) {
      const sections = [...new Map(follows.map((f) => [f.id, { id: f.id, title: f.title }])).values()];
      out.push({ specId: spec.id, title: spec.title, status: spec.status, category: spec.category, sections, appliesBy, follows, deviations, ...(exempt ? { exempt } : {}) });
    }
  }
  return out;
}

export const workOrderStatusSchema = z.enum(WORK_ORDER_STATUSES);
export type WorkOrderStatus = z.infer<typeof workOrderStatusSchema>;
/** Statuses of work orders still to be worked on. */
export const OPEN_WORK_ORDER_STATUSES: WorkOrderStatus[] = ['pending', 'in_progress'];
/** Kinds that change a section (at most one open implement/update work order per spec section). */
export const CHANGING_WORK_ORDER_KINDS = ['implement', 'update'] as const;

export const workOrderKindSchema = z.enum(WORK_ORDER_KINDS);
export type WorkOrderKind = z.infer<typeof workOrderKindSchema>;

/** `obsolete`: the section was archived or superseded; it counts as finished. */
export const WORK_ORDER_SECTION_STATUSES = ['pending', 'done', 'obsolete'] as const;
export const workOrderSectionSchema = z.object({
  id: idSchema,
  status: z.enum(WORK_ORDER_SECTION_STATUSES).default('pending'),
});
export type WorkOrderSection = z.infer<typeof workOrderSectionSchema>;

/**
 * A work order on specific sections of one spec, at a given spec version (`specCommit`): the flat projection of the
 * markdown document `work-orders/<id>.md` (see work-orders.ts) that services and lists use. `sections` are the
 * targeted SPEC section ids with their status. (Before the migration, work orders were lines of `work-orders.jsonl`;
 * this schema still reads those lines.)
 */
export const workOrderSchema = z.object({
  id: idSchema,
  spec: idSchema,
  specCommit: commitish,
  kind: workOrderKindSchema,
  priority: prioritySchema.optional(),
  status: workOrderStatusSchema,
  note: z.string().optional(),
  sections: z.array(workOrderSectionSchema).min(1, 'a work order targets at least one section'),
  createdBy: z.string().min(1).optional(),
  /** Feedback items this work order acts on (work order -> feedback; backlinks derived). */
  reason: z.array(idSchema).default([]),
  /** Fix work orders: the audit findings it fixes (`mandate://audits/<id>/findings/<fid>`; backlinks derived). */
  findings: z.array(findingUriSchema).optional(),
  /** The agent working on it (only while open). */
  claim: claimSchema.optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  /* Markdown work orders (optional so legacy jsonl lines still parse). */
  title: z.string().optional(),
  fastPath: z.boolean().optional(),
  dependencies: z.array(idSchema).optional(),
  claims: z.array(pastClaimSchema).optional(),
  completedAt: z.string().optional(),
  touched: z.array(touchedFileSchema).optional(),
  git: z.array(gitContextSchema).optional(),
  /** The `plan` section is non-empty. */
  hasPlan: z.boolean().optional(),
});
export type WorkOrder = z.infer<typeof workOrderSchema>;

/** A targeted section resolved at the item's spec version (MCP `work_order_get`). */
export interface ResolvedWorkOrderSection {
  id: string;
  status: WorkOrderSection['status'];
  /** The section at `specCommit` (null if it no longer parses / exists there). */
  section: Section | null;
  /** The section in the current spec, when it differs from `specCommit` (null if removed). */
  latest?: Section | null;
  headChanged: boolean;
  /** A section-level depends_on target is not implemented yet. */
  blocked?: boolean;
  /** A depends_on target is archived or missing. */
  broken?: boolean;
  /** The section is archived at HEAD. */
  archived?: boolean;
}

export interface ResolvedWorkOrder {
  item: WorkOrder;
  spec: Pick<StoredSpec, 'id' | 'title' | 'summary' | 'category' | 'status' | 'priority' | 'repo' | 'owner'> | null;
  /** `specCommit` cannot be read any more (history rewritten): the pinned text is unknown. */
  pinLost?: boolean;
  /** Feedback items in `reason`, resolved. */
  reasons?: { id: string; status: FeedbackStatus; kind: FeedbackKind; body: string }[];
  sections: ResolvedWorkOrderSection[];
  /** Spec HEAD commit when it moved past `specCommit`. */
  specMovedTo: string | null;
  /** Upstream / downstream dependency graph of the work order (at `dependencies.commit` when given). */
  dependencies?: DependencyTree;
  /** The markdown document: plan, per-section notes / code / deviations, reconciliation, outcome. */
  doc?: {
    plan: string;
    reconciliation: string;
    outcome: string;
    history?: string;
    /** Per targeted spec section: the work-order section (`mandate://work-orders/<id>/sections/<sid>`). */
    sections: { id: string; uri: string; target: string; title: string; status: WorkOrderSection['status']; notes: string; verifications: string[]; codeRefs: TouchedFile[]; deviations: string[] }[];
  };
  /** Comment threads on the work order and its sections (open ones; resolved ones counted). */
  comments?: { counts: CommentCounts; threads: CommentThread[] };
  /** Claim history (current claim excluded), git context and touched code (also on `item`). */
  claims?: PastClaim[];
  git?: GitContext[];
  touched?: TouchedFile[];
}

/* ---------- Work-order dependency graph (derived from section links) ---------- */

/** Inputs of the dependency graph (MCP `work_order_get` with at / depth). */
export const workOrderDependenciesInputSchema = z.object({
  id: idSchema,
  /** Compute the graph from the repository at this commit (an old version); default HEAD. */
  at: commitish.optional(),
  /** Levels followed on each side (default 4). */
  depth: z.coerce.number().int().min(1).max(8).default(4),
});
export type WorkOrderDependenciesInput = z.input<typeof workOrderDependenciesInputSchema>;

/** Edge relation: section links (`depends_on`, soft `extends` / `follows`). */
export type DependencyRel = 'depends_on' | 'extends' | 'follows';

export interface DependencyNode {
  /** The section / spec URI (`mandate://specs/x/sections/y`), or the work order URI for the center node. */
  key: string;
  type: 'work_order' | 'section' | 'spec';
  side: 'center' | 'upstream' | 'downstream';
  /** Shortest distance from the work order (0 for the center). */
  depth: number;
  docKind: 'specs' | 'standards';
  docId: string;
  docTitle: string | null;
  sectionId?: string;
  sectionTitle?: string | null;
  summary?: string;
  /** `missing`: the link target does not exist (at that commit); `standard`: standards are not implemented; `archived`: no longer in force. */
  state: 'implemented' | 'not_implemented' | 'standard' | 'missing' | 'archived';
  specStatus?: SpecStatus;
  /** A section-level depends_on target of this node is not implemented. */
  blocked: boolean;
  /** A depends_on target of this node is archived or missing. */
  broken?: boolean;
  /** A link target changed after this section was implemented. */
  upstreamChanged: boolean;
  /** Claim of an open work order on this node. */
  claim?: Claim;
  /** Work orders on this section (spec nodes: on any section of the spec), cancelled ones excluded. */
  workOrders: { id: string; kind: WorkOrderKind; status: WorkOrderStatus }[];
  /** Neighbours beyond the depth limit were not followed. */
  truncated?: boolean;
  /** Unfinished hard upstream of the work order (its blockers). */
  blocker?: boolean;
  /** Components the node touches (affects links, owners of its code refs); the center: of the work order's sections. */
  components?: string[];
}

export interface DependencyEdge {
  /** Upstream end (the dependency). */
  from: string;
  /** Downstream end (the dependent). */
  to: string;
  rel: DependencyRel;
  /** `extends` / `follows`: soft relations (drawn dashed). */
  soft: boolean;
  /** For edges at the center: the work order's section the link starts from / ends at. */
  via?: string;
}

export interface DependencyTree {
  root: string;
  /** Commit the graph was computed at (null = HEAD). */
  commit: string | null;
  depth: number;
  nodes: DependencyNode[];
  edges: DependencyEdge[];
  summary: {
    /** Unfinished hard upstream sections (and specs) of the work order. */
    blockedBySections: number;
    blockedBySpecs: number;
    /** Distinct work orders downstream of this one. */
    dependentWorkOrders: number;
    upstream: number;
    downstream: number;
  };
}

/* ---------- Feedback (the "why" behind changes to specs and standards) ---------- */

export const feedbackKindSchema = z.enum(FEEDBACK_KINDS);
export type FeedbackKind = z.infer<typeof feedbackKindSchema>;

export const feedbackStatusSchema = z.enum(FEEDBACK_STATUSES);
export type FeedbackStatus = z.infer<typeof feedbackStatusSchema>;
export const feedbackResolutionSchema = z.enum(FEEDBACK_RESOLUTIONS);
export type FeedbackResolution = z.infer<typeof feedbackResolutionSchema>;

/** A verification result: `mandate://verifications/<id>` (to dispute a result). */
export const isVerificationTarget = (t: string) => parseNodeUri(t)?.kind === 'verifications';
/**
 * A section of a spec or standard (`mandate://specs/<id>/sections/<sid>[#Lx-Ly]`, or standards) or a
 * verification result (`mandate://verifications/<id>`). Whole documents are not targets.
 */
/** DF-10: an audit item (`mandate://audits/<id>/sections/<sid>`) or finding (`mandate://audits/<id>/findings/<fid>`). */
export const isAuditTarget = (t: string) => {
  const r = parseRef(t);
  return (r?.kind === 'audits' && !!r.sectionId) || parseNodeUri(t)?.kind === 'findings';
};
export const feedbackTargetSchema = z
  .string()
  .refine(
    (t) => (/^mandate:\/\/(specs|standards|components)\//.test(t) && parseRef(t) !== null) || isVerificationTarget(t) || isAuditTarget(t),
    'target must be a mandate://specs/..., mandate://standards/..., mandate://verifications/... or audit item / finding reference',
  );
const isSectionTarget = (t: string) => !!parseRef(t)?.sectionId || isVerificationTarget(t) || isAuditTarget(t);
const SECTION_HINT = 'feedback targets sections or verification results: pick the section, e.g. mandate://specs/<id>/sections/<sid>';

/** A feedback item's `relatedTo` entry: a feedback id, or a canonical element reference (`mandate://...`). */
export const relatedRefSchema = z.union([idSchema, z.string().max(400).refine((v) => !!parseNodeUri(v), 'an element reference (mandate://...)')]);

const feedbackFields = {
  /** Empty only for an intake request (improvement / bug) filed before its sections are known. */
  targets: z.array(feedbackTargetSchema).default([]),
  quote: z.string().optional(),
  kind: feedbackKindSchema,
  body: z.string().min(1),
  status: feedbackStatusSchema.default('open'),
  /** Required when closed. */
  resolution: feedbackResolutionSchema.optional(),
  /** Required when the resolution is `rejected`. */
  resolutionNote: z.string().optional(),
  /** Required when the resolution is `duplicate`. */
  duplicateOf: idSchema.optional(),
  /** Related elements: feedback ids (e.g. a closed item this one follows up on) or element references (DF-7). */
  relatedTo: z.array(relatedRefSchema).default([]),
  /** Author (server-set from the commit's agent / author; legacy items: derived from history). */
  createdBy: z.string().min(1).optional(),
  /** The user who triggered the creation (server-set from the principal; never client input). */
  createdByUser: z.string().min(1).optional(),
  /** The audit finding this item was filed from (spec_wrong / ambiguous findings). */
  fromFinding: findingUriSchema.optional(),
  /** Who accepted it (server-set principal: the user, else the agent); legacy items: derived from history. */
  acceptedBy: z.string().min(1).optional(),
  /**
   * Approval override (server-set by feedback_accept with override: true): the acceptance may approve the accepter's
   * own waivers / exemptions / criteria removals. Only for the sole active user or an admin; recorded and warned on.
   */
  approvalOverride: z.object({ by: z.string().min(1), reason: z.string().min(1), at: z.string().min(1) }).optional(),
};

/** Resolution rules shared by stored items and create inputs. */
function checkResolution(
  f: { status: FeedbackStatus; resolution?: FeedbackResolution; resolutionNote?: string; duplicateOf?: string; id?: string },
  ctx: z.RefinementCtx,
): void {
  if (f.status === 'closed' && !f.resolution) ctx.addIssue({ code: 'custom', path: ['resolution'], message: 'a closed item needs a resolution (applied, rejected or duplicate)' });
  if (f.status !== 'closed' && f.resolution) ctx.addIssue({ code: 'custom', path: ['resolution'], message: 'only closed items have a resolution' });
  if (f.resolution === 'rejected' && !f.resolutionNote?.trim()) ctx.addIssue({ code: 'custom', path: ['resolutionNote'], message: 'a rejected item needs a resolutionNote' });
  if (f.resolution === 'duplicate' && !f.duplicateOf) ctx.addIssue({ code: 'custom', path: ['duplicateOf'], message: 'a duplicate needs duplicateOf' });
  if (f.duplicateOf && f.resolution !== 'duplicate') ctx.addIssue({ code: 'custom', path: ['duplicateOf'], message: 'duplicateOf is only for duplicates' });
  if (f.duplicateOf && f.duplicateOf === f.id) ctx.addIssue({ code: 'custom', path: ['duplicateOf'], message: 'an item cannot duplicate itself' });
  // Whole-document targets are only tolerated on legacy closed (immutable) items.
  const targets = (f as { targets?: string[] }).targets ?? [];
  const kind = (f as { kind?: string }).kind;
  if (!targets.length && kind !== 'improvement' && kind !== 'bug') ctx.addIssue({ code: 'custom', path: ['targets'], message: 'feedback needs at least one target (only improvement / bug requests may start without one)' });
  if (f.status !== 'closed') {
    targets.forEach((t, i) => {
      if (!isSectionTarget(t)) ctx.addIssue({ code: 'custom', path: ['targets', i], message: `${t} is a whole document; ${SECTION_HINT}` });
    });
  }
}

export const feedbackSchema = z
  .object({ id: idSchema, ...feedbackFields, createdAt: z.string(), updatedAt: z.string() })
  .superRefine(checkResolution);
export type StoredFeedback = z.infer<typeof feedbackSchema>;

/** A document a feedback item changed, derived from commits with a `Feedback: <id>` trailer. */
export interface FeedbackChange {
  uri: string;
  kind: 'specs' | 'standards' | 'components';
  id: string;
  action: 'created' | 'modified' | 'deleted' | 'renamed';
  commit: string;
  subject: string;
  date: string;
  docTitle: string | null;
  /** For renames: the old document uri. */
  from?: string;
  /** For deletions: the last commit in which the document still existed (open it there). */
  lastVersion?: string;
  /** For modified documents: affected sections. */
  sections: { uri: string; id: string; title: string; action: 'added' | 'removed' | 'modified' }[];
}

/** Feedback as returned by the API: resulting changes and warnings are derived from git. */
export type Feedback = StoredFeedback & {
  /** Present when the stored record no longer passes validation (read is lenient, writes are strict). */
  validationIssues?: string[];
  changes: FeedbackChange[];
  /** When it was closed (commit that set status closed), if closed. */
  closedAt?: string;
  warnings: string[];
};

export const createFeedbackSchema = z
  .object({ id: idSchema.optional(), ...feedbackFields })
  .superRefine(checkResolution)
  .superRefine((f, ctx) =>
    f.targets.forEach((t, i) => {
      if (!isSectionTarget(t)) ctx.addIssue({ code: 'custom', path: ['targets', i], message: `${t} is a whole document; ${SECTION_HINT}` });
    }),
  );
export type CreateFeedbackInput = z.input<typeof createFeedbackSchema>;
export const updateFeedbackSchema = z.object({
  // (targets in updates are always section targets)
  status: feedbackStatusSchema.optional(),
  resolution: feedbackResolutionSchema.nullable().optional(),
  resolutionNote: z.string().nullable().optional(),
  duplicateOf: idSchema.nullable().optional(),
  relatedTo: z.array(relatedRefSchema).optional(),
  body: z.string().min(1).optional(),
  targets: z.array(feedbackTargetSchema.refine(isSectionTarget, SECTION_HINT)).min(1).optional(),
});
export type UpdateFeedbackInput = z.input<typeof updateFeedbackSchema>;

export interface ResolvedFeedbackTarget {
  ref: string;
  kind: 'specs' | 'standards' | 'components' | 'verifications' | 'audits' | 'findings';
  id: string;
  title: string | null;
  sectionId?: string;
  section?: Section | null;
  lines?: { start: number; end: number };
  /** Commit the target was resolved at (closed items: their closing commit). */
  at?: string;
  /** Verification targets: the record. */
  verification?: VerificationRecord | null;
}

export interface ResolvedFeedback {
  feedback: Feedback & { author?: string | null };
  targets: ResolvedFeedbackTarget[];
}

/** Feedback on one document (MCP `doc_feedback`). */
export interface DocFeedback {
  items: (Feedback & { sections: string[] })[];
  /** Open + accepted items per section id ("" = the whole document). */
  openBySection: Record<string, number>;
}

/* ---------- Reference resolution ---------- */

/** Input of `resolveReference`: a `mandate://` URI or `@mandate:` mention (short shas allowed). */
export const resolveReferenceSchema = z.object({ uri: z.string().min(1) });
export type ResolveReferenceInput = z.infer<typeof resolveReferenceSchema>;

/** A reference resolved against git: full sha, the section at that version and the referenced lines. */
export interface ResolvedReference {
  /** Canonical URI (full sha when versioned). */
  uri: string;
  kind: string;
  id: string;
  commit?: string;
  sectionId?: string;
  /** Section title at that version (null if the section did not exist there). */
  sectionTitle?: string | null;
  /** Whether the section still exists at HEAD. */
  existsAtHead: boolean;
  lines?: { start: number; end: number };
  /** Text of the referenced lines in the file at that version. */
  text?: string;
}

/* ---------- Section links ---------- */

/** An outgoing link with its target resolved. */
export interface ResolvedLink {
  to: string;
  rel: string;
  note?: string;
  kind: 'specs' | 'standards' | 'components';
  docId: string;
  docTitle: string | null;
  /** Absent for a whole-standard target. */
  sectionId?: string;
  sectionTitle: string | null;
  summary?: string;
  exists: boolean;
  /** Spec targets: the target section has an implementedCommit. */
  implemented?: boolean;
  /** The target document or section is archived. */
  archived?: boolean;
  /** The target changed after this (source) section was implemented (or acknowledged via `seenAt`). */
  upstreamChanged?: boolean;
  /** The pin to compare against (implementedCommit / seenAt) cannot be read: state unknown. */
  pinLost?: boolean;
  /** The target section is superseded (by `supersededBy`). */
  supersededBy?: string;
  /** deviates_from: whether it waives (accepted feedback by another author, criteria unchanged). */
  waiver?: WaiverState;
  feedback?: string;
  seenAt?: string;
}

/** State of a waiver (`deviates_from` link or exemption). */
export interface WaiverState {
  effective: boolean;
  /** Why it does not waive: no feedback, feedback not accepted, same author, criteria changed since approval. */
  reason?: 'no_feedback' | 'feedback_missing' | 'not_accepted' | 'same_author' | 'self_approved' | 'stale';
  feedback?: string;
}

/** A link pointing at a section (computed reverse lookup). */
export interface Backlink {
  from: string;
  kind: 'specs' | 'standards' | 'components';
  docId: string;
  docTitle: string;
  sectionId: string;
  sectionTitle: string;
  rel: string;
  note?: string;
  docStatus?: string;
}

export interface SectionLinkInfo {
  outgoing: ResolvedLink[];
  backlinks: Backlink[];
  /** A `depends_on` target section is not implemented yet. */
  blocked: boolean;
  /** A `depends_on` target is archived or missing ("Broken dependency"). */
  broken: boolean;
  upstreamChanged: boolean;
  /** Some pin could not be read ("Unknown (pin lost)"). */
  pinLost: boolean;
  /** Links to superseded targets. */
  supersededTargets: string[];
}

/** Link information of a document, on spec / standard GET by id. */
export interface DocLinks {
  sections: Record<string, SectionLinkInfo>;
  /** Spec-level warnings (superseded / conflicting standards in use). */
  warnings: string[];
  /** Standards (ids) in use that have superseded sections. */
  supersededStandards: string[];
}

/* ---------- Verification (acceptance criteria results) ---------- */


/** One append-only verification result (a line of `verifications.jsonl`). */
export const verificationRecordSchema = z.object({
  id: idSchema,
  /** Acceptance section URI (`mandate://specs|standards/<id>/sections/<sid>`). */
  criterion: z.string().refine((u) => /^mandate:\/\/(specs|standards)\/[^/]+\/sections\/[^/@#]+$/.test(u), 'criterion must be an acceptance section URI'),
  /** The spec the result is for (a spec's own criteria: the spec itself). */
  appliedTo: z.string().refine((u) => /^mandate:\/\/specs\/[^/@#]+$/.test(u), 'appliedTo must be a spec URI'),
  /** Mandate repo commit the verification was made against. */
  specCommit: commitish,
  code: z.object({ repo: z.string().min(1), commit: commitish, branch: z.string().min(1).optional() }),
  result: z.enum(VERIFICATION_RESULTS),
  method: z.enum(VERIFICATION_METHODS),
  evidence: z
    .object({
      test: z.string().optional(),
      ci: z.string().optional(),
      note: z.string().optional(),
      /** Automated checks: the command that ran and (the tail of) its output. */
      command: z.string().optional(),
      output: z.string().max(20_000).optional(),
    })
    .default({}),
  /**
   * Code locations the result applies to (`repo:path#Lx-Ly`): explicit refs that place the criterion / rule in code
   * (a rule passing there: `applies_at`; failing: `violated_at`).
   */
  codeRefs: z.array(auditCodeRefSchema).max(30).optional(),
  by: z.string().min(1),
  /** The user who triggered the write (server-set from the principal; never client input). */
  byUser: z.string().min(1).optional(),
  at: z.string(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
});
export type VerificationRecord = z.infer<typeof verificationRecordSchema>;

/**
 * Input for recording a result (MCP tool / service). `appliedTo` defaults to the criterion's spec.
 * `at` is always set by the server (results are ordered by append position, never by caller time).
 */
export const recordVerificationSchema = verificationRecordSchema
  .omit({ id: true, createdAt: true, updatedAt: true, appliedTo: true, at: true, specCommit: true })
  .extend({ id: idSchema.optional(), appliedTo: z.string().optional(), specCommit: commitish.optional() })
  .strict();
export type RecordVerificationInput = z.input<typeof recordVerificationSchema>;

/** `unknown`: the result's pin cannot be read any more (pin lost). */
export type CriterionStateName = (typeof CRITERION_STATES)[number];

/** Derived state of one criterion for one spec. */
export interface CriterionState {
  /** Acceptance section URI. */
  uri: string;
  sectionId: string;
  title: string;
  method?: string;
  state: CriterionStateName;
  /** Latest result (any outcome). */
  last?: VerificationRecord;
  /** All results for this (criterion, spec), newest first. */
  history: VerificationRecord[];
  /** A deviation from this criterion (effective or not); `waived` only when effective. */
  waiver?: { section?: string; note: string; feedback?: string; exemption?: boolean } & WaiverState;
  /** Why it is stale (e.g. the criterion or a section listing it in verifiedBy changed). */
  staleReason?: string;
  /** Inherited criteria: the spec sections that follow it (staleness is tracked per following section). */
  sections?: string[];
  /** Inherited criteria: how it applies (e.g. `appliesTo tag:api`, `security-baseline`, `extends`, `org/ac-tls`). */
  path?: string[];
  /** Rules: must (blocks done), should (warns), may (informational). Acceptance criteria are `must`. */
  level?: 'must' | 'should' | 'may';
  /** Section type (`acceptance` or `rule`). */
  type?: string;
  /** Rules of a standard not yet in force (effectiveFrom ahead): announced, never gating. */
  upcoming?: boolean;
}

export interface VerificationRollup {
  verified: number;
  total: number;
  failing: number;
  stale: number;
}

/** Verification of a spec: its own criteria plus those inherited from the standards it uses. */
export interface SpecVerification extends VerificationRollup {
  own: CriterionState[];
  inherited: { standard: string; title: string; criteria: CriterionState[]; /** For criteria inherited through `extends`: the chain of standard titles. */ via?: string[] }[];
}

/** A standard's checklist with the state of each criterion per spec using the standard. */
export interface StandardVerification {
  criteria: { uri: string; sectionId: string; title: string; method?: string; level?: 'must' | 'should' | 'may' }[];
  specs: { spec: string; title: string; status: SpecStatus; states: Record<string, CriterionStateName> }[];
}

/** Input of the status-change service (`moveSpecStatus`), gated for `done`. */
export const setSpecStatusSchema = z.object({ id: idSchema, status: z.enum(STORED_SPEC_STATUSES) });
export type SetSpecStatusInput = z.infer<typeof setSpecStatusSchema>;

/** Implementation state of each section of a spec (MCP `spec_implementation`). */
export type SectionImplementation = Record<string, { implementedCommit?: string; outdated: boolean; pinLost?: boolean }>;

/* ---------- Integrity (repo lint after pulls / merges) ---------- */

export interface IntegrityIssue {
  /** Rule id, e.g. `depends_on_cycle`, `dangling_link`, `duplicate_open_work_order`, `short_sha` (INTEGRITY_RULES). */
  rule: string;
  /** The element concerned (a mandate:// URI). */
  uri: string;
  message: string;
  /** `error`: a broken invariant (writes that would introduce one are rejected); `warning`: a gap worth fixing. */
  severity?: 'error' | 'warning';
  /** One-line suggested fix. */
  hint?: string;
}

export interface IntegrityReport {
  /** HEAD the lint ran at. */
  head: string | null;
  at: string;
  issues: IntegrityIssue[];
}

/** What a write changed in the integrity report (every write tool returns it as `integrity`). */
export interface IntegrityDelta {
  /** Issues the write introduced (warnings: fix them now or tell the user why not). */
  introduced: IntegrityIssue[];
  /** Issues the write resolved. */
  resolved: IntegrityIssue[];
}

/** Counts of a report (the `integrity.changed` activity event, the sidebar). */
export interface IntegrityCounts {
  errors: number;
  warnings: number;
  total: number;
}

/* ---------- API inputs ---------- */

export const createSpecSchema = specFrontmatterSchema.extend({
  id: idSchema.optional(),
  sections: z.array(sectionSchema).default([]),
});
export type CreateSpecInput = z.input<typeof createSpecSchema>;

/** Patch semantics: omitted fields are kept, `null` removes an optional field. No defaults here. */
export const updateSpecSchema = z.object({
  title: z.string().trim().min(1).optional(),
  summary: z.string().nullable().optional(),
  category: z.string().min(1).nullable().optional(),
  status: z.enum(STORED_SPEC_STATUSES).optional(),
  priority: prioritySchema.nullable().optional(),
  tags: z.array(z.string().min(1)).optional(),
  owner: z.string().min(1).nullable().optional(),
  repo: z.string().min(1).nullable().optional(),
  implementedCommit: commitish.nullable().optional(),
  exemptFrom: z.array(exemptionSchema).optional(),
  sections: z.array(sectionSchema).optional(),
});
export type UpdateSpecInput = z.input<typeof updateSpecSchema>;

export const createStandardSchema = standardFrontmatterSchema.extend({
  id: idSchema.optional(),
  sections: z.array(sectionSchema).default([]),
});
export type CreateStandardInput = z.input<typeof createStandardSchema>;
export const updateStandardSchema = z.object({
  title: z.string().trim().min(1).optional(),
  summary: z.string().nullable().optional(),
  tags: z.array(z.string().min(1)).optional(),
  owner: z.string().min(1).nullable().optional(),
  appliesTo: z.array(appliesToSchema).optional(),
  sections: z.array(sectionSchema).optional(),
});
export type UpdateStandardInput = z.input<typeof updateStandardSchema>;

export const createWorkOrderSchema = z.object({
  id: idSchema.optional(),
  spec: idSchema,
  /** Defaults to the spec's current version. */
  specCommit: commitish.optional(),
  kind: workOrderKindSchema,
  priority: prioritySchema.optional(),
  status: workOrderStatusSchema.default('pending'),
  note: z.string().optional(),
  sections: z.array(workOrderSectionSchema).min(1),
  createdBy: z.string().min(1).optional(),
  reason: z.array(idSchema).optional(),
  findings: z.array(findingUriSchema).optional(),
});
export type CreateWorkOrderInput = z.input<typeof createWorkOrderSchema>;
export const updateWorkOrderSchema = z.object({
  status: workOrderStatusSchema.optional(),
  priority: prioritySchema.nullable().optional(),
  note: z.string().nullable().optional(),
  sections: z.array(workOrderSectionSchema).min(1).optional(),
  reason: z.array(idSchema).optional(),
  /** Re-pin to another spec version (full sha or short; validated). */
  specCommit: commitish.optional(),
});
export type UpdateWorkOrderInput = z.input<typeof updateWorkOrderSchema>;

/** Claim a work order (sets it in progress). */
export const claimWorkOrderSchema = z.object({
  id: idSchema,
  agent: z.string().min(1),
  branch: z.string().min(1).optional(),
  worktree: z.string().min(1).optional(),
});
export type ClaimWorkOrderInput = z.infer<typeof claimWorkOrderSchema>;
/** Heartbeat / release a claim (only the claiming agent). */
export const workOrderClaimRefSchema = z.object({ id: idSchema, agent: z.string().min(1) });
export type WorkOrderClaimRefInput = z.infer<typeof workOrderClaimRefSchema>;
/** Mark covered sections done (records implementedCommit = the work order's specCommit) or obsolete. */
export const workOrderSectionDoneSchema = z.object({
  id: idSchema,
  sections: z.array(idSchema).min(1),
  status: z.enum(['done', 'obsolete']).default('done'),
});
export type WorkOrderSectionDoneInput = z.input<typeof workOrderSectionDoneSchema>;
/** Acknowledge "upstream changed" on a link (stores `seenAt` = current HEAD on the link). */
export const acknowledgeLinkSchema = z.object({ spec: idSchema, section: idSchema, to: z.string().min(1) });
export type AcknowledgeLinkInput = z.infer<typeof acknowledgeLinkSchema>;

/* ---------- Git ---------- */

export interface GitFileStatus {
  path: string;
  status: string;
}

export interface GitStatus {
  branch: string | null;
  head: string | null;
  clean: boolean;
  files: GitFileStatus[];
  remote: string | null;
  /** Repo lint after the last pull / startup (rules that only hold per write, e.g. across merged clones). */
  integrity?: IntegrityReport;
  /** Background push of this project's commits (git_status). */
  autoPush?: AutoPushStatus;
}

/**
 * Background push state. `state`: idle (nothing to push), scheduled, pushing, ok (last push succeeded), error
 * (retries stopped or backing off; see lastError), disabled (autoPush.enabled false), no_remote, reconnect (the
 * GitHub token of `connectedBy` was revoked), refused (the data dir is not its own git repository).
 */
export interface AutoPushStatus {
  enabled: boolean;
  state: 'idle' | 'scheduled' | 'pushing' | 'ok' | 'error' | 'disabled' | 'no_remote' | 'reconnect' | 'refused';
  /** Commits not on the remote branch / remote commits not merged locally (as of the last fetch); null when unknown. */
  ahead: number | null;
  behind: number | null;
  lastPushAt: string | null;
  lastResult: 'ok' | 'error' | null;
  lastError: string | null;
  nextPushAt: string | null;
  /** Consecutive failures (backoff). */
  failures: number;
  /** Human-readable status line for the UI ("Reconnect GitHub", "No remote", ...). */
  message: string;
}

export interface GitCommitInfo {
  id: string;
  message: string;
  author: string;
  date: string;
}

export interface GitSyncResult {
  pulled: boolean;
  pushed: boolean;
  message: string;
}

export interface HealthResponse {
  ok: true;
  version: string;
  dataDir: string;
  remote: string | null;
  /** Process start time (epoch ms): a new value means the server restarted. */
  startedAt?: number;
}

export interface ApiError {
  error: string;
  details?: unknown;
}

/** Turn an arbitrary title into a slug id. */
export function slugify(input: string): string {
  return input
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

/** Longest generated id (documents, sections, projects) before a `-2`, `-3` de-duplication suffix. */
export const GENERATED_ID_MAX = 48;

/**
 * A readable id from a title or name: lowercase ascii slug with hyphens, at most GENERATED_ID_MAX chars (cut at a hyphen
 * when one is close); `fallback` when nothing ascii is left. Ids are assigned by Mandate, never by agents.
 */
export function idFromTitle(title: string, fallback: string): string {
  let s = slugify(title);
  if (s.length > GENERATED_ID_MAX) {
    const cut = s.slice(0, GENERATED_ID_MAX);
    const i = cut.lastIndexOf('-');
    s = (i >= GENERATED_ID_MAX / 2 ? cut.slice(0, i) : cut).replace(/-+$/, '');
  }
  return s || fallback;
}

/** `base`, else the first free `base-2`, `base-3`, ... (`taken` sees every candidate; call it inside the write lock). */
export async function uniqueId(base: string, taken: (id: string) => boolean | Promise<boolean>): Promise<string> {
  if (!(await taken(base))) return base;
  for (let i = 2; ; i++) if (!(await taken(`${base}-${i}`))) return `${base}-${i}`;
}

export * from './refs.js';
export * from './layers.js';
export * from './search.js';
export * from './search-schemas.js';
export * from './read-schemas.js';
export * from './activity.js';
export * from './ask.js';
export * from './write-schemas.js';
export * from './audits.js';
export * from './maturity.js';
export * from './work-orders.js';
export * from './comments.js';
export * from './questions.js';
export * from './lifecycle.js';
export * from './lineage.js';
export * from './overview.js';

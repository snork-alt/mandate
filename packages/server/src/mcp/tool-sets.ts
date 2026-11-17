/**
 * Tool SETS and MERGED tools. Agents see a small default list (`core`); `tools_enable { sets }` (or `?tools=` on the MCP
 * URL) adds more. Any tool stays callable whether it is listed or not, so a client with a cached list loses nothing.
 *
 * Merged tools (`get`, `list`, `create`, `status_set`, ...) replace per-type tools that differed only by object type.
 * They ROUTE: the ref (or `of`) picks the per-type tool, which then runs exactly as before (same validation, errors,
 * results, news, gates). The per-type names stay callable as hidden aliases (never listed to agents).
 */
import { gateSummary, parseNodeUri, parseRef } from '@mandate/shared';
import { z } from 'zod';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { defineTool, inputJsonSchema, type AnyToolDef } from './define.js';
import type { ToolErrorBody } from './errors.js';

/* ---------------------------------------------------------------- object types (`of`) */

export const OF_TYPES = ['specs', 'standards', 'components', 'work-orders', 'requests', 'audits', 'questions', 'verifications', 'comments', 'decisions'] as const;
export type OfType = (typeof OF_TYPES)[number];

/** Singular / snake_case spellings accepted for `of`. */
const OF_ALIASES: Record<string, OfType> = {
  spec: 'specs',
  standard: 'standards',
  component: 'components',
  'work-order': 'work-orders',
  work_order: 'work-orders',
  work_orders: 'work-orders',
  workorder: 'work-orders',
  audit: 'audits',
  request: 'requests',
  // The old name of requests.
  feedback: 'requests',
  question: 'questions',
  verification: 'verifications',
  comment: 'comments',
  decision: 'decisions',
};
const normOf = (v: unknown): OfType | null => {
  if (typeof v !== 'string') return null;
  const s = v.trim().toLowerCase();
  return (OF_TYPES as readonly string[]).includes(s) ? (s as OfType) : (OF_ALIASES[s] ?? null);
};

/* ---------------------------------------------------------------- merged tools */

interface MergedSpec {
  name: string;
  title: string;
  kind: 'read' | 'write';
  description: string;
  /** The argument holding the ref that decides the type (null: `of` only). */
  refField: 'ref' | 'doc' | null;
  /** Per type: the per-type tool for a document ref / `of`. */
  doc: Partial<Record<OfType, string>>;
  /** Per type: the per-type tool for a SECTION ref (or a `section` / `doc` argument on get). */
  section?: Partial<Record<OfType, string>>;
  /** Argument rewrites for a target (e.g. audit_get takes `auditId`). */
  rewrite?: Record<string, (args: Record<string, unknown>) => Record<string, unknown>>;
  /** Shown when the type has no tool here. */
  noTarget?: Partial<Record<OfType, string>>;
}

const OF_DESC = 'Object type when the ref is a bare id (a mandate:// ref carries it)';

export const MERGED: MergedSpec[] = [
  {
    name: 'get',
    title: 'Get one item',
    kind: 'read',
    refField: 'ref',
    description: `Get one item by ref: spec, standard, component, work order, request, audit or question, or one SECTION of a spec / standard / component / audit / work order (a .../sections/<id> ref, or doc + section). Bare ids need of.
Documents: frontmatter, sections (bodies, lines, metadata) and, at HEAD, verification, section links and implementation state; metadataOnly: outline only; sections: only these ids; at: a commit. Work orders: covered sections at specCommit (headChanged / blocked) and the dependency tree (depth). Requests: resolved targets and derived changes. Sections: body, type, metadata, lines; #Lx-Ly in the ref returns that excerpt; includeImage: the picture of an image section.
Example: {"ref":"mandate://specs/login-sso","metadataOnly":true}`,
    doc: { specs: 'spec_get', standards: 'standard_get', components: 'component_get', 'work-orders': 'work_order_get', requests: 'request_get', audits: 'audit_get', questions: 'question_get' },
    section: { specs: 'spec_section_get', standards: 'standard_section_get', components: 'component_section_get', audits: 'audit_section_get', 'work-orders': 'work_order_section_get' },
    rewrite: {
      audit_get: ({ ref, ...rest }) => ({ ...rest, auditId: ref }),
      question_get: ({ ref, ...rest }) => ({ ...rest, id: ref }),
    },
  },
  {
    name: 'list',
    title: 'List items of a type',
    kind: 'read',
    refField: null,
    description: `List items of one type (of), with that type's filters; paginated (limit, cursor).
specs: status, category, repo, tags, standard, blocked, verification, audit (never|stale|open_findings|fail|warn|pass), maturity, q; verification rollup, blocked sections, lastAudit, maturity. standards: tags, q. components: kind, status, repo, tags, q. work-orders: status, kind, spec. requests: status, kind, target (doc or section ref). audits: target, status, stale. questions: status, mine, context, since. verifications: criterion, spec, state (verified|failing|stale|unverified|waived), result. comments: target (work order or section, required), includeResolved. decisions: open human decisions (kinds).
Example: {"of":"work-orders","status":["pending"],"spec":"login-sso"}`,
    doc: { specs: 'spec_list', standards: 'standard_list', components: 'component_list', 'work-orders': 'work_order_list', requests: 'request_list', audits: 'audit_list', questions: 'questions_list', verifications: 'verification_list', comments: 'comments_list', decisions: 'decisions_list' },
  },
  {
    name: 'create',
    title: 'Create a spec, standard or component',
    kind: 'write',
    refField: null,
    description: `Create a spec, standard or component (of). Mandate assigns the id from the title: use the returned ref; never pass id. Sections are optional here (section_insert).
specs: starts draft (status_set to move it); addresses / workOrder like other doc edits. standards: appliesTo rules (repo:x, tag:x, category:x) make it apply to matching specs. components: kind service|module|library|datastore|external; owns: code path globs per repo (most specific wins in code_owner); layer ui|api|service|domain|data|infra or a slug (default: inherited from parent or derived from depends_on); parent: the containing component (a tree, not archived). Architecture level, few: reuse first (architecture_get). Typical sections: responsibility, interfaces, context (mermaid), rationale.`,
    doc: { specs: 'spec_create', standards: 'standard_create', components: 'component_create' },
  },
  {
    name: 'update_meta',
    title: 'Update document metadata',
    kind: 'write',
    refField: 'ref',
    description: `Update frontmatter fields of a spec, standard or component (null removes an optional field). Status: status_set. Spec standards are linked from sections (follows); dependencies from section depends_on links. Standards: effectiveFrom here.`,
    doc: { specs: 'spec_update_meta', standards: 'standard_update_meta', components: 'component_update_meta' },
  },
  {
    name: 'status_set',
    title: 'Set lifecycle status',
    kind: 'write',
    refField: 'ref',
    description: `Set the lifecycle status of a spec, standard or component (by ref). Spec: in_progress is derived, never set; a failing done gate returns done_gate with detail.failures (criterion, state, provenance path). Standard: deprecated needs supersededBy. Component: never deleted; archiving never cascades (reason).`,
    doc: { specs: 'spec_status_set', standards: 'standard_status_set', components: 'component_status_set' },
  },
  {
    name: 'archive',
    title: 'Archive a document or section',
    kind: 'write',
    refField: 'ref',
    description: `Archive (never delete) a spec, a component or a section of a spec / standard / component (reason optional). Spec: cancels its open work orders; status_set draft restores it. Component (final): leaves architecture_get, its owns globs stop claiming code, new links to it are rejected. Section: stays in the document (ids never reused), no longer in force; pending work-order sections on a spec section become obsolete. Standards: status_set deprecated (supersededBy).`,
    doc: { specs: 'spec_archive', components: 'component_archive' },
    section: { specs: 'spec_section_archive', standards: 'standard_section_archive', components: 'component_section_archive' },
    noTarget: { standards: 'a whole standard is not archived: status_set { status: "deprecated", supersededBy } (or archive its sections)' },
  },
  {
    name: 'section_insert',
    title: 'Insert a section',
    kind: 'write',
    refField: 'doc',
    description: `Insert a section into a spec, standard or component (doc; after / before a section id, or position first | last; default last). Mandate assigns its id from the title. Types: markdown, mermaid, html; specs: acceptance (a criterion: method test|manual|review|metric, threshold for metric); standards: rule (level must|should|may, rationale, scope {paths, languages}, check {kind, command}, examples as code refs; must rules block done); components: responsibility, interfaces, context (mermaid), rationale. Links: section_link_add. Generated files (HTML mockups, large diagrams, images with alt): upload with curl (project_info.upload or upload_url_create), never inline.
Sections: one concept each, a one-sentence summary, under ~600 tokens (warnings otherwise); name symbols, refs and standards in the metadata.`,
    doc: { specs: 'spec_section_insert', standards: 'standard_section_insert', components: 'component_section_insert' },
  },
  {
    name: 'section_update',
    title: 'Update a section',
    kind: 'write',
    refField: 'ref',
    description: `Update a section of a spec, standard or component (title, summary, body, type, refs, symbols, verifiedBy, method, threshold; null clears an optional field). Pass ref as copied; a ref with @sha must be the current version (else stale_version: re-read and retry). Archived sections cannot be edited. Section guide: section_insert.`,
    doc: {},
    section: { specs: 'spec_section_update', standards: 'standard_section_update', components: 'component_section_update' },
  },
  {
    name: 'section_move',
    title: 'Move a section',
    kind: 'write',
    refField: 'ref',
    description: `Move a section of a spec, standard or component (exactly one of after, before, position first | last).`,
    doc: {},
    section: { specs: 'spec_section_move', standards: 'standard_section_move', components: 'component_section_move' },
  },
  {
    name: 'section_link_add',
    title: 'Link a section',
    kind: 'write',
    refField: 'ref',
    description: `Add a typed link from a section (ref). Spec section -> spec section: depends_on, extends, relates_to, conflicts_with, supersedes; -> standard or standard section: follows, deviates_from (note required; a waiver needs the user's approval: cite an answered question_ask purpose approval as cause), relates_to; -> component or component section: affects. Component section -> component (section): depends_on (an architecture edge); -> standard (section): follows, deviates_from (note required). Standard section -> standard section: extends, relates_to, conflicts_with, supersedes.
One link per target; cycles and superseded / archived targets are rejected (the hint names the successor).`,
    doc: {},
    section: { specs: 'spec_section_link_add', standards: 'standard_section_link_add', components: 'component_section_link_add' },
  },
  {
    name: 'section_link_remove',
    title: 'Unlink a section',
    kind: 'write',
    refField: 'ref',
    description: `Remove a link from a section (to, optionally rel). Unfollowing a standard from a done or claimed spec needs the user's approval (cite an answered question_ask purpose approval as cause).`,
    doc: {},
    section: { specs: 'spec_section_link_remove', standards: 'standard_section_link_remove', components: 'component_section_link_remove' },
  },
];

/** Old per-type name -> the merged tool that serves it (hidden aliases: callable, never listed to agents). */
export const ALIASES: Record<string, string> = {
  ...Object.fromEntries(MERGED.flatMap((m) => [...Object.values(m.doc), ...Object.values(m.section ?? {})].map((old) => [old, m.name]))),
  // The old feedback names (renamed to requests): hidden, callable.
  feedback_get: 'get',
  feedback_list: 'list',
  feedback_create: 'request_create',
  feedback_update: 'request_update',
  feedback_close: 'request_close',
  // Work orders have tasks only: the old step / section tools stay callable.
  work_order_step_set: 'work_order_task_set',
  work_order_section_done: 'work_order_task_set',
};

/* ---------------------------------------------------------------- routing */

export type Route = { def: AnyToolDef; args: unknown } | { error: ToolErrorBody };

/** The per-type tool name a merged tool's call selects, and its arguments (or the routing error). */
function pick(m: MergedSpec, raw: unknown): { name: string; args: Record<string, unknown> } | { error: ToolErrorBody } {
  const args = raw && typeof raw === 'object' && !Array.isArray(raw) ? { ...(raw as Record<string, unknown>) } : {};
  const err = (message: string, path: string, hint: string) => ({ error: { code: 'invalid_input', message, path, hint } });
  const ofRaw = args.of;
  delete args.of;
  const of = ofRaw === undefined ? null : normOf(ofRaw);
  if (ofRaw !== undefined && !of) return err(`unknown of '${String(ofRaw)}'`, 'of', `one of: ${typesOf(m).join(', ')}`);
  const refArg = m.refField ? (m.refField === 'ref' && args.ref === undefined && typeof args.doc === 'string' ? args.doc : args[m.refField]) : undefined;
  // parseRef: documents and their sections; parseNodeUri: every other ref kind (questions, ...).
  const parsed = typeof refArg === 'string' ? ((parseRef(refArg) ?? parseNodeUri(refArg.trim().replace(/^@mandate:/, ''))) as { kind: string; sectionId?: string } | null) : null;
  const refKind = parsed ? normOf(parsed.kind) : null;
  if (refKind && of && refKind !== of) return err(`of '${of}' does not match the ref (${refKind})`, 'of', 'omit of when passing a mandate:// ref');
  const type = refKind ?? of;
  if (!type) {
    if (m.refField && refArg === undefined) return err(`${m.refField} is required`, m.refField, m.name === 'get' ? 'pass ref (a mandate:// ref, or an id with of)' : `pass ${m.refField} (a mandate:// ref as copied)`);
    return err('of is required' + (m.refField ? ' for a bare id' : ''), 'of', `one of: ${typesOf(m).join(', ')}`);
  }
  const wantsSection = !!m.section && (!!parsed?.sectionId || (m.name === 'get' && (args.section !== undefined || args.doc !== undefined)) || Object.keys(m.doc).length === 0);
  const name = wantsSection ? m.section?.[type] : m.doc[type];
  if (!name) return err(`${m.name} does not apply to ${type}${wantsSection ? ' sections' : ''}`, m.refField ?? 'of', m.noTarget?.[type] ?? `${m.name} serves: ${typesOf(m).join(', ')}`);
  const rewrite = m.rewrite?.[name];
  return { name, args: rewrite ? rewrite(args) : args };
}

function route(m: MergedSpec, raw: unknown, byName: Map<string, AnyToolDef>): Route {
  const p = pick(m, raw);
  if ('error' in p) return p;
  const def = byName.get(p.name);
  return def ? { def, args: p.args } : { error: { code: 'invalid_input', message: `no tool ${p.name}`, path: 'name', hint: 'call tools/list' } };
}

/** The per-type tool name a call of a merged tool runs (the name itself for other tools; null: not routable). */
export function perTypeName(name: string, args: unknown): string | null {
  const m = MERGED.find((x) => x.name === name);
  if (!m) return name;
  const p = pick(m, args);
  return 'error' in p ? null : p.name;
}

const typesOf = (m: MergedSpec) => [...new Set([...Object.keys(m.doc), ...Object.keys(m.section ?? {})])];

/** JSON schemas of the targets merged: every property (differing ones as anyOf), required = in every target. */
function mergedJsonSchema(m: MergedSpec, targets: AnyToolDef[]): Tool['inputSchema'] {
  const props: Record<string, unknown[]> = {};
  const required: string[][] = [];
  for (const t of targets) {
    const js = inputJsonSchema(t.input) as { properties?: Record<string, unknown>; required?: string[] };
    const rw = m.rewrite?.[t.name];
    const renamed = rw ? Object.fromEntries(Object.entries(js.properties ?? {}).map(([k, v]) => [k === 'auditId' || k === 'id' ? 'ref' : k, v])) : (js.properties ?? {});
    for (const [k, v] of Object.entries(renamed)) {
      const list = (props[k] ??= []);
      if (!list.some((x) => JSON.stringify(x) === JSON.stringify(v))) list.push(v);
    }
    required.push((js.required ?? []).map((k) => (rw && (k === 'auditId' || k === 'id') ? 'ref' : k)));
  }
  const types = typesOf(m);
  const properties: Record<string, unknown> = {
    of: { type: 'string', enum: types, description: m.refField ? OF_DESC : 'Object type' },
    ...Object.fromEntries(Object.entries(props).map(([k, v]) => [k, v.length === 1 ? v[0] : { anyOf: v }])),
  };
  const req = required.length ? required[0]!.filter((k) => required.every((r) => r.includes(k))) : [];
  if (!m.refField) req.unshift('of');
  return { type: 'object', properties, ...(req.length ? { required: req } : {}), additionalProperties: false } as Tool['inputSchema'];
}

/** The merged tools, routing to the per-type tools in `byName`. */
export function mergedTools(byName: Map<string, AnyToolDef>): AnyToolDef[] {
  return MERGED.map((m) => {
    const targets = [...new Set([...Object.values(m.doc), ...Object.values(m.section ?? {})])].map((n) => {
      const d = byName.get(n);
      if (!d) throw new Error(`merged tool ${m.name}: no tool ${n}`);
      return d;
    });
    const jsonSchema = mergedJsonSchema(m, targets);
    // The zod input only names the keys (texts are checked against them); validation is the target's.
    const keys = Object.keys((jsonSchema as { properties: Record<string, unknown> }).properties);
    const def: AnyToolDef = {
      name: m.name,
      title: m.title,
      kind: m.kind,
      description: gateSummary(m.name) ? `${m.description}\n${gateSummary(m.name)}` : m.description,
      input: z.object(Object.fromEntries(keys.map((k) => [k, z.unknown().optional()]))).passthrough() as unknown as z.ZodType,
      jsonSchema,
      route: (raw: unknown) => route(m, raw, byName),
      run: async () => {
        throw new Error(`${m.name} routes to a per-type tool`);
      },
    };
    return def;
  });
}

/* ---------------------------------------------------------------- sets */

export const SET_NAMES = ['core', 'intake', 'bootstrap', 'review', 'lineage', 'admin'] as const;
export type ToolSetName = (typeof SET_NAMES)[number];
export const DEFAULT_SETS: readonly ToolSetName[] = ['core'];

/** Set membership (a tool may be in several sets). Every tool listed to agents is in at least one. */
export const TOOL_SETS: Record<ToolSetName, readonly string[]> = {
  /** The whole request flow (always on): record the request, match, edit specs / standards, create work orders, implement, verify. */
  core: [
    'project_info', 'instructions_get', 'lifecycle_get', 'flow_set', 'code_context_set', 'tools_enable',
    'search', 'get', 'list',
    'flow_next', 'request_create', 'request_update', 'request_close', 'request_assign', 'request_plan_approve', 'request_decision_add', 'spec_match', 'component_match', 'standard_match',
    'create', 'update_meta', 'archive', 'section_insert', 'section_move', 'section_link_add', 'section_link_remove',
    'work_order_create', 'work_order_cancel',
    'work_order_next', 'work_order_claim', 'work_order_heartbeat', 'work_order_plan_set', 'work_order_task_set', 'work_order_touch', 'work_order_git_update', 'work_order_complete', 'work_order_fail', 'work_order_release',
    'verification_record', 'question_ask', 'question_cancel', 'comment_add', 'comment_resolve',
    'status_set', 'section_update', 'rules_for_code', 'news_list', 'news_ack',
    'ask_pending', 'ask_answer', 'upload_url_create', 'architecture_get', 'code_owner', 'standard_usage', 'graph_neighbors',
  ],
  /** Legacy set name: its tools moved to core (listed by default). */
  intake: [],
  /** /mandate-bootstrap: reverse-engineer a codebase into components, standards and specs. */
  bootstrap: [
    'spec_match', 'create', 'update_meta', 'archive', 'section_insert', 'section_move', 'section_link_add', 'section_link_remove',
    'upload_url_create', 'architecture_get', 'code_owner', 'standard_usage', 'request_update',
  ],
  /** Audits, reviews and human decisions. */
  review: [
    'audit_plan', 'audit_start', 'audit_record_item', 'audit_complete', 'audit_abandon', 'audit_findings_to_work_orders', 'audit_recheck', 'audit_finding_relink', 'audit_findings', 'audit_overview',
    'comment_reopen', 'rule_check_plan', 'spec_diff_since_implemented', 'request_close', 'request_update', 'integrity_snooze', 'question_answer', 'work_order_touch_from_commits',
  ],
  /** Why and impact: the knowledge graph, lineage, history and code / text search. */
  lineage: [
    'graph_search', 'graph_node', 'graph_neighbors', 'graph_path', 'graph_impact', 'graph_history', 'graph_changes', 'graph_evolution', 'graph_query', 'graph_schema', 'graph_batch',
    'lineage', 'lineage_annotate', 'blast_radius', 'contributors', 'history_get', 'history_search', 'diff_get', 'related', 'metadata_query', 'text_search', 'symbol_search', 'code_search',
    'standard_where_used', 'standard_usage', 'code_rules', 'code_owner', 'architecture_get', 'project_overview',
  ],
  /** Operations: activity, Ask, index and git sync. */
  admin: ['flow_edit_allowed', 'agents_presence', 'activity_list', 'activity_subscribe', 'ask_post', 'ask_get', 'ask_cancel', 'index_status', 'git_status', 'git_push', 'git_pull', 'work_order_touch_from_commits', 'project_overview'],
};

/** `?tools=` / tools_enable value: set names (comma separated) or `all`. Unknown names are returned separately. */
export function parseToolSets(value: string | readonly string[] | undefined | null): { sets: Set<ToolSetName>; unknown: string[] } {
  const parts = (typeof value === 'string' ? value.split(/[,\s|]+/) : [...(value ?? [])]).map((s) => s.trim().toLowerCase()).filter(Boolean);
  const sets = new Set<ToolSetName>(DEFAULT_SETS);
  const unknown: string[] = [];
  for (const p of parts) {
    if (p === 'all') for (const s of SET_NAMES) sets.add(s);
    else if ((SET_NAMES as readonly string[]).includes(p)) sets.add(p as ToolSetName);
    else unknown.push(p);
  }
  return { sets, unknown };
}

/** Is a tool in one of the enabled sets? */
export function inSets(name: string, sets: ReadonlySet<string>): boolean {
  for (const s of sets) if ((TOOL_SETS as Record<string, readonly string[]>)[s]?.includes(name)) return true;
  return false;
}

/** The sets a tool belongs to. */
export const setsOf = (name: string): ToolSetName[] => SET_NAMES.filter((s) => TOOL_SETS[s].includes(name));

/** Sets enabled for a session (the default when unset). */
export const enabledSets = (state: { toolSets?: Set<string> } | undefined): Set<string> => state?.toolSets ?? new Set(DEFAULT_SETS);

export const toolsEnableTool = defineTool({
  name: 'tools_enable',
  title: 'Enable tool sets',
  kind: 'ops',
  description: `List more Mandate tools in this session (core, the whole request flow, is always on): bootstrap (/mandate-bootstrap), review (audits, comment_reopen, decisions), intake (legacy: already in core), lineage (graph_*, lineage, history, diffs, code and text search), admin (activity, Ask posting, index, git sync); all = every set. Notifies the client that the tool list changed; any tool can still be called by name. A client that does not refresh its list: add ?tools=<sets> to the MCP URL.
Example: {"sets":["intake"]}`,
  input: z.object({ sets: z.array(z.enum([...SET_NAMES, 'all'] as [string, ...string[]])).min(1).max(SET_NAMES.length + 1) }).strict(),
  run: async (a, ctx) => {
    const before = enabledSets(ctx.session);
    const next = new Set([...before, ...parseToolSets(a.sets).sets]);
    const added = [...new Set([...next].filter((s) => !before.has(s)).flatMap((s) => (TOOL_SETS as Record<string, readonly string[]>)[s] ?? []))].filter((n) => !inSets(n, before));
    if (ctx.session) ctx.session.toolSets = next;
    if (added.length && ctx.notify) await ctx.notify('notifications/tools/list_changed', {}).catch(() => undefined);
    return { enabled: SET_NAMES.filter((s) => next.has(s)), added };
  },
});

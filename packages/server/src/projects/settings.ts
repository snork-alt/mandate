/**
 * The Mandate flow for coding agents, in two layers:
 * - Project POLICY (admin; `~/.mandate/projects.json` per project): `flowPolicy` required | optional | off (default
 *   optional). Legacy `approvalPolicy` / `flow { enabled, approval }` entries are parsed and ignored (requests need no
 *   approval); legacy `flow.enabled: false` migrates to off.
 * - Per-CLIENT preference (server-state database, table `flow_clients`, both SQLite and Postgres): keyed by
 *   (project, client id). Client id: personal tokens / MCP OAuth = the user + normalised MCP client name; service-account
 *   keys (and older shared keys) = MCP client name + key name. Every client that calls the project is recorded (last seen, version), so it can be listed.
 * Effective setting = the policy when it is required / off, else the client's preference (default on).
 */
import type { ToolContext } from '../mcp/define.js';
import { migrate, type Migration } from '../db/migrate.js';
import type { Db, Dialect } from '../db/types.js';
import type { ProjectsStore } from './store.js';
import { codeRepoProblems, codeRepoSchema, type CodeRepo } from '@mandate/shared';

export type FlowPolicy = 'required' | 'optional' | 'off';
/** @deprecated Requests need no approval: stored values are parsed and ignored. */
export type ApprovalPolicy = 'required' | 'optional';
export type OnOff = 'on' | 'off';
/** Where the client's agent asks the user: through Mandate (`question_ask`, default) or in chat. */
export type QuestionsVia = 'mandate' | 'chat';
export const QUESTIONS_VIA = ['mandate', 'chat'] as const;
/** A preference change (each field optional). */
export interface PrefPatch {
  flow?: OnOff;
  questions?: QuestionsVia;
}
export const FLOW_POLICIES = ['required', 'optional', 'off'] as const;

export interface Policy {
  flowPolicy: FlowPolicy;
  /** Strict flow (opt-in): the `mandate guard` hook refuses code edits unless the agent holds a claimed work order with a step in progress. */
  strictFlow?: boolean;
}
export const DEFAULT_POLICY: Policy = { flowPolicy: 'optional' };

/** A calling coding agent: who (the user) and which client (normalised MCP clientInfo name). */
export interface ClientIdentity {
  id: string;
  /** Display label, e.g. "Claude Code". */
  label: string;
  /** Normalised client name, e.g. "claude-code". */
  client: string;
  user?: string;
  keyName?: string;
  version?: string;
}

export interface ClientRecord extends ClientIdentity {
  project: string;
  /** null: no preference (default on). */
  flow: OnOff | null;
  approval: OnOff | null;
  /** null: no preference (default mandate). */
  questions: QuestionsVia | null;
  updatedAt: string | null;
  updatedVia: 'command' | 'ui' | null;
  lastSeenAt: string;
}

export interface Effective {
  flow: OnOff;
  questions: QuestionsVia;
  /** Why (policy or preference), one sentence. */
  reason: string;
  /** Whether the project policy decides the flow (required / off) rather than this client's preference. */
  flowByPolicy: boolean;
}

/* ------------------------------------------------------------------ client identity */

const KNOWN: [RegExp, string, string][] = [
  [/claude/, 'claude-code', 'Claude Code'],
  [/codex/, 'codex', 'Codex'],
  [/cursor/, 'cursor', 'Cursor'],
  [/visual studio code|vscode|vs-code|copilot/, 'vscode', 'VS Code'],
  [/gemini/, 'gemini', 'Gemini CLI'],
  [/opencode/, 'opencode', 'opencode'],
  [/windsurf|cascade|devin/, 'windsurf', 'Windsurf'],
  [/junie/, 'junie', 'Junie'],
  [/^amp|amp-/, 'amp', 'Amp'],
  [/goose/, 'goose', 'Goose'],
  [/cline/, 'cline', 'Cline'],
  [/zed/, 'zed', 'Zed'],
  [/^mandate-web|^web$/, 'web-ui', 'Web UI'],
];

/** "Claude Code" / "claude-code" / "codex-mcp-client" → { client: "claude-code", label: "Claude Code" }. */
export function normaliseClient(name: string | undefined): { client: string; label: string } {
  const n = (name ?? '').trim().toLowerCase();
  for (const [re, client, label] of KNOWN) if (re.test(n)) return { client, label };
  const client = n.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'unknown';
  return { client, label: name?.trim().slice(0, 60) || 'Unknown client' };
}

/** The calling client of a tool call. */
export function clientIdentity(ctx: Pick<ToolContext, 'principal' | 'clientName' | 'clientVersion'>): ClientIdentity {
  const { client, label } = normaliseClient(ctx.clientName);
  const version = ctx.clientVersion ? { version: ctx.clientVersion.slice(0, 40) } : {};
  const p = ctx.principal;
  if (p?.kind === 'user') return { id: `${p.login.toLowerCase()}/${client}`, label, client, user: p.login, ...version };
  if (p?.kind === 'key') return { id: `${client}/${p.keyName}`, label, client, keyName: p.keyName, ...version };
  if (p?.kind === 'ui') return { id: `ui/${p.user.login.toLowerCase()}`, label: 'Web UI', client: 'web-ui', user: p.user.login };
  return { id: client, label, client, ...version };
}

/* ------------------------------------------------------------------ effective setting */

export function effective(policy: Policy, pref: (Pick<ClientRecord, 'flow'> & { questions?: QuestionsVia | null }) | undefined): Effective {
  const reasons: string[] = [];
  let flow: OnOff;
  if (policy.flowPolicy === 'required') {
    flow = 'on';
    reasons.push('the project policy requires the flow');
  } else if (policy.flowPolicy === 'off') {
    flow = 'off';
    reasons.push('the project policy turns the flow off (Mandate is read-only context)');
  } else {
    flow = pref?.flow ?? 'on';
    reasons.push(pref?.flow ? `this client's preference is flow ${pref.flow}` : 'no preference set for this client (default: on)');
  }
  const questions = pref?.questions ?? 'mandate';
  if (pref?.questions) reasons.push(`questions via ${pref.questions} by preference`);
  return { flow, questions, reason: `${reasons.join('; ')}.`, flowByPolicy: policy.flowPolicy !== 'optional' };
}

/**
 * What the calling agent must do FROM NOW ON, until the setting changes (flow_set, /mandate-flow, project_info). The
 * agent saves it to its memory, replacing any earlier Mandate-flow note.
 */
export function flowInstructions(eff: Effective): string {
  const save = 'Save these instructions to your memory now, replacing any earlier Mandate-flow note.';
  if (eff.flow === 'off')
    return `Mandate flow is OFF for this coding agent (${eff.reason.replace(/\.$/, '')}). From now on, until the setting changes: work directly in the code; use Mandate only to read context (search, get, list, lineage, graph, ask); do not create requests, specs, standards, components or work orders and do not call any Mandate write tool (they are refused with flow_off). Plan and ask questions in chat. ${eff.flowByPolicy ? 'Only a Mandate admin can change this (project policy, Settings → Agent flow).' : 'The user turns it back on with /mandate-flow on.'} ${save}`;
  const questions = eff.questions === 'chat' ? 'ask the user in chat, not with question_ask' : 'ask the user with question_ask, not your harness\'s question tool';
  return `Mandate flow is ON for this coding agent. From now on, until the setting changes: every instruction the user gives is a request and goes through Mandate (no approval needed). Call project_info at the start of each task; request_create → spec_match → update specs / standards (addresses: the request) → work_order_create with the FULL plan (steps, files, tests mapped to criteria, risks) → deliver through the work order (claim, work on: set each plan step in_progress when you start it and done when finished with codeRefs, skipped with a reason; section_done with codeRefs, verification_record per criterion with its test, work_order_complete). Questions: ${questions}; keep working on what does not depend on the answer. ${save}`;
}

/** Message of the `flow_off` refusal (every Mandate write tool while the flow is off for the calling agent). */
export function flowOffMessage(eff: Effective): string {
  return `The Mandate flow is off for this agent (${eff.reason.replace(/\.$/, '')}). Mandate does not accept requests from it. Save this in your memory: do not use Mandate write tools; Mandate is read-only context ${eff.flowByPolicy ? 'until a Mandate admin changes the project policy' : 'until the user runs /mandate-flow on'}.`;
}

/** Write tools an agent may call while its flow is off (switching the flow itself). */
export const FLOW_OFF_ALLOWED = new Set(['flow_set', 'project_flow_set']);

/** Why a preference change is refused (null: allowed). */
export function refusal(policy: Policy, patch: PrefPatch): { code: 'policy_required' | 'policy_off'; message: string } | null {
  if (patch.flow === 'off' && policy.flowPolicy === 'required') return { code: 'policy_required', message: 'the project policy requires the Mandate flow; it cannot be turned off for one client (ask a Mandate admin to change Settings → Agent flow)' };
  if (patch.flow === 'on' && policy.flowPolicy === 'off') return { code: 'policy_off', message: 'the project policy turns the Mandate flow off (read-only context); it cannot be turned on for one client' };
  return null;
}

/* ------------------------------------------------------------------ policy (projects.json) */

type Entry = { id: string; flowPolicy?: FlowPolicy; strictFlow?: boolean; approvalPolicy?: ApprovalPolicy; flow?: { enabled?: boolean; approval?: boolean } };

/** Policy of a registry entry (legacy `flow.enabled: false` → off; anything else → optional). */
export function policyOf(e: Entry | undefined): Policy {
  if (!e) return { ...DEFAULT_POLICY };
  return {
    flowPolicy: e.flowPolicy ?? (e.flow?.enabled === false ? 'off' : 'optional'),
    ...(e.strictFlow ? { strictFlow: true } : {}),
      };
}

/** Rewrite legacy `flow` fields as policies (idempotent). Returns the migrated project ids. */
export async function migrateFlowPolicies(store: ProjectsStore): Promise<string[]> {
  if (!store.read().projects.some((p) => (p as Entry).flow)) return [];
  return store.mutate((reg) => {
    const ids: string[] = [];
    for (const p of reg.projects as Entry[]) {
      if (!p.flow) continue;
      const pol = policyOf(p);
      p.flowPolicy = pol.flowPolicy;
      delete p.approvalPolicy;
      delete p.flow;
      ids.push(p.id);
    }
    return ids;
  });
}

/* ------------------------------------------------------------------ client preferences (database) */

export interface ClientStore {
  /** Record a call (throttled): creates the client row, refreshes last seen and version. */
  seen(project: string, c: ClientIdentity): Promise<void>;
  get(project: string, id: string): Promise<ClientRecord | undefined>;
  set(project: string, c: ClientIdentity, patch: PrefPatch, via: 'command' | 'ui'): Promise<ClientRecord>;
  /** Clients of a project (optionally one user's), most recently seen first. */
  list(project: string, filter?: { user?: string }): Promise<ClientRecord[]>;
}

const flowSchemaV1 = (d: Dialect) => `
CREATE TABLE IF NOT EXISTS ${d.table('flow_clients')} (
  project TEXT NOT NULL, client_id TEXT NOT NULL, label TEXT NOT NULL, client TEXT NOT NULL,
  user_login TEXT, user_lc TEXT, key_name TEXT, version TEXT,
  flow TEXT CHECK (flow IN ('on', 'off')), approval TEXT CHECK (approval IN ('on', 'off')),
  updated_at ${d.types.bigint}, updated_via TEXT CHECK (updated_via IN ('command', 'ui')),
  last_seen_at ${d.types.bigint} NOT NULL,
  PRIMARY KEY (project, client_id)
);
CREATE INDEX IF NOT EXISTS ${d.index('flow_clients_user')} ON ${d.table('flow_clients')} (project, user_lc);
`;
const flowSchemaV2 = (d: Dialect) => `ALTER TABLE ${d.table('flow_clients')} ADD COLUMN questions TEXT CHECK (questions IN ('mandate', 'chat'));`;
export const FLOW_MIGRATIONS: Migration[] = [
  { id: 1, name: 'flow client preferences', sqlite: flowSchemaV1, postgres: flowSchemaV1 },
  { id: 2, name: 'flow client questions preference', sqlite: flowSchemaV2, postgres: flowSchemaV2 },
];

interface Row {
  project: string;
  client_id: string;
  label: string;
  client: string;
  user_login: string | null;
  key_name: string | null;
  version: string | null;
  flow: OnOff | null;
  approval: OnOff | null;
  questions?: QuestionsVia | null;
  updated_at: number | string | null;
  updated_via: 'command' | 'ui' | null;
  last_seen_at: number | string;
}
const iso = (v: number | string | null) => (v === null || v === undefined ? null : new Date(Number(v)).toISOString());
const fromRow = (r: Row): ClientRecord => ({
  project: r.project,
  id: r.client_id,
  label: r.label,
  client: r.client,
  ...(r.user_login ? { user: r.user_login } : {}),
  ...(r.key_name ? { keyName: r.key_name } : {}),
  ...(r.version ? { version: r.version } : {}),
  flow: r.flow ?? null,
  approval: r.approval ?? null,
  questions: r.questions ?? null,
  updatedAt: iso(r.updated_at),
  updatedVia: r.updated_via ?? null,
  lastSeenAt: iso(r.last_seen_at)!,
});

/** Client preferences on the database adapter (migration scope `flow`). */
export class DbClientStore implements ClientStore {
  private readonly ready: Promise<unknown>;
  private readonly lastWrite = new Map<string, number>();

  constructor(
    readonly db: Db,
    private readonly throttleMs = 60_000,
  ) {
    this.ready = migrate(db, 'flow', FLOW_MIGRATIONS);
  }

  private t() {
    return this.db.dialect.table('flow_clients');
  }

  async seen(project: string, c: ClientIdentity, at = Date.now()): Promise<void> {
    const k = `${project}\u0000${c.id}`;
    const last = this.lastWrite.get(k);
    if (last !== undefined && at - last < this.throttleMs) return;
    this.lastWrite.set(k, at);
    await this.ready;
    const d = this.db.dialect;
    await this.db.run(
      d.upsert('flow_clients', ['project', 'client_id', 'label', 'client', 'user_login', 'user_lc', 'key_name', 'version', 'last_seen_at'], ['project', 'client_id'], ['label', 'version', 'last_seen_at']),
      [project, c.id, c.label, c.client, c.user ?? null, c.user?.toLowerCase() ?? null, c.keyName ?? null, c.version ?? null, at],
    );
  }

  async get(project: string, id: string): Promise<ClientRecord | undefined> {
    await this.ready;
    const r = await this.db.get<Row>(`SELECT * FROM ${this.t()} WHERE project = ? AND client_id = ?`, [project, id]);
    return r ? fromRow(r) : undefined;
  }

  async set(project: string, c: ClientIdentity, patch: PrefPatch, via: 'command' | 'ui'): Promise<ClientRecord> {
    await this.ready;
    const now = Date.now();
    const cur = await this.get(project, c.id);
    const d = this.db.dialect;
    await this.db.run(
      d.upsert('flow_clients', ['project', 'client_id', 'label', 'client', 'user_login', 'user_lc', 'key_name', 'version', 'flow', 'approval', 'questions', 'updated_at', 'updated_via', 'last_seen_at'], ['project', 'client_id'], ['flow', 'approval', 'questions', 'updated_at', 'updated_via']),
      [project, c.id, cur?.label ?? c.label, cur?.client ?? c.client, cur?.user ?? c.user ?? null, (cur?.user ?? c.user)?.toLowerCase() ?? null, cur?.keyName ?? c.keyName ?? null, cur?.version ?? c.version ?? null, patch.flow ?? cur?.flow ?? null, cur?.approval ?? null, patch.questions ?? cur?.questions ?? null, now, via, cur ? Date.parse(cur.lastSeenAt) : now],
    );
    return (await this.get(project, c.id))!;
  }

  async list(project: string, filter: { user?: string } = {}): Promise<ClientRecord[]> {
    await this.ready;
    const rows = filter.user
      ? await this.db.all<Row>(`SELECT * FROM ${this.t()} WHERE project = ? AND user_lc = ? ORDER BY last_seen_at DESC`, [project, filter.user.toLowerCase()])
      : await this.db.all<Row>(`SELECT * FROM ${this.t()} WHERE project = ? ORDER BY last_seen_at DESC`, [project]);
    return rows.map(fromRow);
  }
}

/** In-memory client preferences (tests, in-process contexts). */
export class MemoryClientStore implements ClientStore {
  private readonly rows = new Map<string, ClientRecord>();
  private key = (p: string, id: string) => `${p}\u0000${id}`;
  async seen(project: string, c: ClientIdentity, at = Date.now()) {
    const cur = this.rows.get(this.key(project, c.id));
    this.rows.set(this.key(project, c.id), { ...(cur ?? { flow: null, approval: null, questions: null, updatedAt: null, updatedVia: null }), ...c, ...(cur?.user ? { user: cur.user } : {}), project, lastSeenAt: new Date(at).toISOString() });
  }
  async get(project: string, id: string) {
    const r = this.rows.get(this.key(project, id));
    return r ? { ...r } : undefined;
  }
  async set(project: string, c: ClientIdentity, patch: PrefPatch, via: 'command' | 'ui') {
    const cur = this.rows.get(this.key(project, c.id));
    const next: ClientRecord = { ...(cur ?? { ...c, project, lastSeenAt: new Date().toISOString(), flow: null, approval: null, questions: null, updatedAt: null, updatedVia: null }), flow: patch.flow ?? cur?.flow ?? null, approval: cur?.approval ?? null, questions: patch.questions ?? cur?.questions ?? null, updatedAt: new Date().toISOString(), updatedVia: via };
    this.rows.set(this.key(project, c.id), next);
    return { ...next };
  }
  async list(project: string, filter: { user?: string } = {}) {
    return [...this.rows.values()].filter((r) => r.project === project && (!filter.user || r.user?.toLowerCase() === filter.user.toLowerCase())).sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));
  }
}

/* ------------------------------------------------------------------ per-project settings (ToolContext.settings) */

export interface ProjectSettings {
  /** The project these settings belong to. */
  project: string;
  policy(): Policy;
  setPolicy(patch: Partial<Policy>): Promise<Policy>;
  clients: ClientStore;
  /** Is this GitHub login a Mandate admin (policy changes)? */
  isAdmin(login: string | undefined): boolean;
  /** Registered code repositories (read fresh); absent on older in-process settings = none registered. */
  codeRepos?(): CodeRepo[];
  /** Replace the code repositories (validated: slug names, unique, not the specs repo). */
  setCodeRepos?(list: CodeRepo[]): Promise<CodeRepo[]>;
  /** The specs repository `owner/repo` (GitHub projects), else null. */
  specsRepo?(): string | null;
}

/** Validate a code repo list (throws `invalid_code_repos` with the first problem). */
export function checkCodeRepos(list: CodeRepo[], specsRepo: string | null): CodeRepo[] {
  const parsed = list.map((r) => codeRepoSchema.parse(r));
  const bad = codeRepoProblems(parsed, specsRepo);
  if (bad.length) throw Object.assign(new Error(bad[0]!.message), { statusCode: 400, code: 'invalid_code_repos', path: `codeRepos.${bad[0]!.index}.${bad[0]!.field}` });
  return parsed;
}

/** Settings of one project: policy over the registry file (read fresh on every call), preferences in `clients`. */
export function projectSettings(store: ProjectsStore, id: string, clients: ClientStore = new MemoryClientStore(), isAdmin: (login: string) => boolean = () => true): ProjectSettings {
  return {
    project: id,
    clients,
    isAdmin: (login) => !!login && isAdmin(login),
    policy: () => policyOf(store.read().projects.find((p) => p.id === id) as Entry | undefined),
    codeRepos: () => [...(store.read().projects.find((p) => p.id === id)?.codeRepos ?? [])],
    specsRepo: () => {
      const g = store.read().projects.find((p) => p.id === id)?.github;
      return g ? `${g.owner}/${g.repo}` : null;
    },
    setCodeRepos: (list) =>
      store.mutate((reg) => {
        const e = reg.projects.find((p) => p.id === id);
        if (!e) throw new Error(`project '${id}' is not in the project registry (${store.file})`);
        const next = checkCodeRepos(list, e.github ? `${e.github.owner}/${e.github.repo}` : null);
        if (next.length) e.codeRepos = next;
        else delete e.codeRepos;
        return next;
      }),
    setPolicy: (patch) =>
      store.mutate((reg) => {
        const e = reg.projects.find((p) => p.id === id) as Entry | undefined;
        if (!e) throw new Error(`project '${id}' is not in the project registry (${store.file})`);
        const next = { ...policyOf(e), ...(patch.flowPolicy ? { flowPolicy: patch.flowPolicy } : {}) };
        if (patch.strictFlow !== undefined) {
          if (patch.strictFlow) next.strictFlow = true;
          else delete next.strictFlow;
        }
        e.flowPolicy = next.flowPolicy;
        if (next.strictFlow) e.strictFlow = true;
        else delete e.strictFlow;
        delete e.approvalPolicy;
        delete e.flow;
        return next;
      }),
  };
}

/** In-memory settings (tests, in-process contexts). */
export function memorySettings(initial: Partial<Policy> = {}, project = 'test', clients: ClientStore = new MemoryClientStore(), code: { codeRepos?: CodeRepo[]; specsRepo?: string | null } = {}): ProjectSettings {
  let policy = { ...DEFAULT_POLICY, ...initial };
  let repos = [...(code.codeRepos ?? [])];
  const specs = code.specsRepo ?? null;
  return {
    project,
    clients,
    isAdmin: () => true,
    policy: () => ({ ...policy }),
    setPolicy: async (patch) => (policy = { ...policy, ...patch }),
    codeRepos: () => [...repos],
    specsRepo: () => specs,
    setCodeRepos: async (list) => (repos = checkCodeRepos(list, specs)),
  };
}

/** Who a UI-triggered write (Settings, flow toggles, project creation) is attributed to: the signed-in user. */
export function uiActor(who: { kind: string; login?: string }): { user?: string; agent: string } {
  return who.kind === 'user' && who.login ? { user: who.login, agent: 'mandate-ui' } : { agent: 'mandate-ui' };
}

/** Activity event for a flow change (policy or a client preference). */
export function flowChangedEvent(projectId: string, fields: string[], who: { agent?: string; user?: string; source?: string }, head: string) {
  if (!fields.length) return null;
  return {
    id: `settings:${Date.now()}`,
    commit: head,
    type: 'project.settings_changed' as const,
    at: new Date().toISOString(),
    ...(who.agent ? { agent: who.agent } : {}),
    ...(who.user ? { user: who.user } : {}),
    ...(who.source ? { source: who.source } : {}),
    refs: [`mandate://projects/${projectId}`],
    summary: `${who.user ?? who.agent ?? 'someone'} set ${fields.join(', ')}`,
    details: { fields },
  };
}

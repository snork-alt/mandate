/**
 * Project tools: this endpoint's project, and the Mandate flow for the CALLING client.
 * - project_info: policy (admin), this client's preference and the effective setting (with the reason).
 * - flow_set: the calling client's preference (refused when the policy forbids it). project_flow_set: deprecated alias.
 * - flow_policy_set: the project policy (web UI admins only; agents are refused).
 * - flow_clients_list: my clients (every client for team admins).
 */
import { z } from 'zod';
import { defineTool, type ToolContext } from '../define.js';
import { ToolError } from '../errors.js';
import { uploadInfo } from '../uploads.js';
import { checkCodeRepos } from '../code-claims.js';
import { INSTRUCTION_NAMES, instructionsFor, STUB_VERSION, stubUpdateNotice } from '../stubs.js';
import { codeContextLabel, codeContextSetInputSchema } from '@mandate/shared';
import { QUESTIONS_VIA, type PrefPatch, clientIdentity, DEFAULT_POLICY, effective, FLOW_POLICIES, flowInstructions, flowChangedEvent, refusal, type OnOff, type ProjectSettings } from '../../projects/settings.js';

const onOff = z.enum(['on', 'off']);

const settingsOf = (ctx: ToolContext): ProjectSettings => {
  if (!ctx.settings) throw new ToolError('unavailable', 'project settings are not available on this endpoint', 'use the per-project endpoint /p/<id>/mcp');
  return ctx.settings;
};

const stubVersion = z.number().int().min(0).max(1000).optional();

async function info(ctx: ToolContext, reportedStub?: number) {
  const policy = ctx.settings?.policy() ?? { ...DEFAULT_POLICY };
  const c = clientIdentity(ctx);
  const pref = ctx.settings ? await ctx.settings.clients.get(ctx.settings.project, c.id) : undefined;
  const eff = effective(policy, pref);
  const upload = uploadInfo(ctx);
  return {
    project: ctx.project ?? null,
    policy,
    client: { id: c.id, label: c.label, flow: pref?.flow ?? null, questions: pref?.questions ?? null },
    effective: { flow: eff.flow, questions: eff.questions },
    reason: eff.reason,
    instructions: flowInstructions(eff),
    ...(upload ? { upload } : {}),
    codeRepos: ctx.settings?.codeRepos?.() ?? [],
    codeContext: ctx.session?.codeContext ?? null,
    ...stubFields(reportedStub),
  };
}

/** `update` when the caller's installed stubs (skill / command files) are older than this server's. */
function stubFields(reported?: number) {
  const update = stubUpdateNotice(reported);
  return update ? { stubVersion: STUB_VERSION, update } : {};
}

async function setPreference(a: PrefPatch, ctx: ToolContext) {
  const s = settingsOf(ctx);
  if (a.flow === undefined && a.questions === undefined) throw new ToolError('validation', 'pass flow and/or questions', 'e.g. {"flow":"off"} or {"questions":"chat"}', 'flow');
  const policy = s.policy();
  const no = refusal(policy, a);
  if (no) throw new ToolError(no.code, no.message, 'the project policy is set by a Mandate admin in Settings → Agent flow', 'flow');
  const c = clientIdentity(ctx);
  const before = await s.clients.get(s.project, c.id);
  const rec = await s.clients.set(s.project, c, a, 'command');
  const fields = (['flow', 'questions'] as const).filter((k) => a[k] && (before?.[k] ?? (k === 'questions' ? 'mandate' : 'on')) !== a[k]).map((k) => `${k} ${k === 'questions' ? `via ${a[k]}` : a[k]} for ${c.label}`);
  const user = ctx.principal?.kind === 'user' ? ctx.principal.login : undefined;
  const e = flowChangedEvent(s.project, fields, { agent: ctx.commit?.agent ?? c.client, ...(user ? { user } : {}), ...(ctx.principal?.kind === 'key' ? { source: ctx.principal.keyName } : {}) }, (await ctx.storage.git.head().catch(() => null)) ?? '');
  if (e) ctx.activity?.emit(e);
  const eff = effective(policy, rec);
  return { policy, client: { id: c.id, label: c.label, flow: rec.flow, questions: rec.questions }, effective: { flow: eff.flow, questions: eff.questions }, reason: eff.reason, instructions: flowInstructions(eff), changed: fields };
}

const FLOW_SET_DESC = `Turn the Mandate flow on / off, or questions mandate | chat, for THIS client only. Refused (policy_required / policy_off) when the project policy forbids it. Returns policy, preference, effective and instructions (follow them; save to memory). Works with the flow off.
Example: {"flow":"off"}`;

export const projectTools = [
  defineTool({
    name: 'project_info',
    title: 'Project info',
    kind: 'read',
    description: `This project and the Mandate flow for your client: policy, client preference, effective { flow, questions }, reason, instructions (follow them), upload (the curl for large files), codeRepos (code repo short names) and your codeContext.
Call at the start of every task. flow off = read-only context (write tools refused: flow_off); questions chat = ask in chat, not question_ask. stubVersion: your local skill's (update: re-run the installer).
Example: {}`,
    input: z.object({ stubVersion }).strict(),
    run: (a, ctx) => info(ctx, a.stubVersion),
  }),
  defineTool({
    name: 'instructions_get',
    title: 'Current Mandate instructions',
    kind: 'read',
    description: `The current Mandate instructions, from the server; they override any local or remembered copy. name: core (working agreement) | bootstrap (args: its arguments, rendered as command) | flow (args: the /mandate-flow argument) | mandate (args: the /mandate argument). stubVersion: your local skill's (update: re-run the installer). Works with the flow off.
Example: {"name":"core","stubVersion":1}`,
    input: z.object({ name: z.enum(INSTRUCTION_NAMES), args: z.string().max(4000).optional(), stubVersion }).strict(),
    run: async (a) => ({ name: a.name, ...instructionsFor(a.name, a.args), stubVersion: STUB_VERSION, ...(stubUpdateNotice(a.stubVersion) ? { update: stubUpdateNotice(a.stubVersion) } : {}) }),
  }),
  defineTool({
    name: 'code_context_set',
    title: 'Set my code context',
    kind: 'ops',
    agentOnly: true,
    description: `Declare the code this session works on: repo (your short name in project_info.codeRepos: match \`git remote get-url origin\` with codeRepos[].github), commit (HEAD sha), branch, dirty (uncommitted changes). Call at task start and after each commit or branch switch. Every write of this session is stamped with it (Code-Context trailer). Session state only (no commit; works with the flow off).
Example: {"repo":"web-app","commit":"3f9c2a1","branch":"main","dirty":true}`,
    input: codeContextSetInputSchema,
    run: async (a, ctx) => {
      if (!ctx.session) throw new ToolError('unavailable', 'code context is per MCP session; this call has none', 'call it over the project MCP endpoint');
      const warnings = checkCodeRepos(ctx, [a.repo], 'repo');
      ctx.session.codeContext = { ...a, at: new Date().toISOString() };
      return { codeContext: ctx.session.codeContext, label: codeContextLabel(a), warnings };
    },
  }),
  defineTool({
    name: 'flow_set',
    title: 'Set my flow preference',
    kind: 'write',
    description: FLOW_SET_DESC,
    input: z.object({ flow: onOff.optional(), questions: z.enum(QUESTIONS_VIA).optional() }).strict(),
    run: (a, ctx) => setPreference(a, ctx),
  }),
  defineTool({
    name: 'project_flow_set',
    title: 'Set my flow preference (deprecated)',
    kind: 'write',
    description: `DEPRECATED: use flow_set. enabled → flow (boolean).
Example: {"enabled":false}`,
    input: z.object({ enabled: z.boolean().optional() }).strict(),
    run: async (a, ctx) => ({
      ...(await setPreference({ ...(a.enabled !== undefined ? { flow: a.enabled ? 'on' : 'off' } : {}) }, ctx)),
      deprecated: 'project_flow_set is deprecated: use flow_set { flow }',
    }),
  }),
  defineTool({
    name: 'flow_policy_set',
    title: 'Set the project flow policy (admin)',
    kind: 'write',
    uiOnly: true,
    description: `Web UI admins only: the project flow policy. flowPolicy: required | optional (default, each client chooses) | off (read-only); strictFlow: true = the guard hook refuses code edits outside a claimed work order step.
Example: {"flowPolicy":"required"}`,
    input: z.object({ flowPolicy: z.enum(FLOW_POLICIES).optional(), strictFlow: z.boolean().optional() }).strict(),
    run: async (a, ctx) => {
      const s = settingsOf(ctx);
      if (!a.flowPolicy && a.strictFlow === undefined) throw new ToolError('validation', 'pass flowPolicy or strictFlow', 'e.g. {"flowPolicy":"required"}', 'flowPolicy');
      const before = s.policy();
      const policy = await s.setPolicy(a);
      const fields = [...(before.flowPolicy !== policy.flowPolicy ? [`flow policy ${policy.flowPolicy}`] : []), ...(!!before.strictFlow !== !!policy.strictFlow ? [`strict flow ${policy.strictFlow ? 'on' : 'off'}`] : [])];
      const login = ctx.principal?.kind === 'ui' ? ctx.principal.user.login : undefined;
      const e = flowChangedEvent(s.project, fields, { agent: 'mandate-ui', ...(login ? { user: login } : {}) }, (await ctx.storage.git.head().catch(() => null)) ?? '');
      if (e) ctx.activity?.emit(e);
      return { policy, changed: fields };
    },
  }),
  defineTool({
    name: 'flow_clients_list',
    title: 'Flow clients',
    kind: 'read',
    description: `Agent clients seen on this project with their flow preference and effective setting (yours; team admins may pass all: true).
Example: {}`,
    input: z.object({ all: z.boolean().default(false) }).strict(),
    run: async (a, ctx) => {
      const s = settingsOf(ctx);
      const me = clientIdentity(ctx);
      const login = ctx.principal?.kind === 'user' ? ctx.principal.login : ctx.principal?.kind === 'ui' ? ctx.principal.user.login : undefined;
      if (a.all && !(ctx.principal?.kind === 'ui' && s.isAdmin(login))) throw new ToolError('forbidden', 'only Mandate admins can list every client', 'call without all to list yours', 'all');
      const filter = !a.all && login ? { user: login } : {};
      const policy = s.policy();
      const clients = (await s.clients.list(s.project, filter)).map((r) => {
        const eff = effective(policy, r);
        return { ...r, effective: { flow: eff.flow, questions: eff.questions }, you: r.id === me.id };
      });
      return { policy, clients };
    },
  }),
];

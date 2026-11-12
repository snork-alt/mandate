/**
 * Project tools: this endpoint's project, and the Mandate flow for the CALLING client.
 * - project_info: policy (admin), this client's preference and the effective setting (with the reason).
 * - flow_set: the calling client's preference (refused when the policy forbids it). project_flow_set: deprecated alias.
 * - flow_policy_set: the project policy (web UI admins only; agents are refused).
 * - flow_clients_list: my clients (every client for admins in server mode).
 */
import { z } from 'zod';
import { defineTool, type ToolContext } from '../define.js';
import { ToolError } from '../errors.js';
import { uploadInfo } from '../uploads.js';
import { APPROVAL_POLICIES, QUESTIONS_VIA, type PrefPatch, clientIdentity, DEFAULT_POLICY, effective, FLOW_POLICIES, flowChangedEvent, refusal, type OnOff, type ProjectSettings } from '../../projects/settings.js';

const onOff = z.enum(['on', 'off']);

const settingsOf = (ctx: ToolContext): ProjectSettings => {
  if (!ctx.settings) throw new ToolError('unavailable', 'project settings are not available on this endpoint', 'use the per-project endpoint /p/<id>/mcp');
  return ctx.settings;
};

async function info(ctx: ToolContext) {
  const policy = ctx.settings?.policy() ?? { ...DEFAULT_POLICY };
  const c = clientIdentity(ctx);
  const pref = ctx.settings ? await ctx.settings.clients.get(ctx.settings.project, c.id) : undefined;
  const eff = effective(policy, pref);
  const upload = uploadInfo(ctx);
  return {
    project: ctx.project ?? null,
    mode: ctx.settings?.mode ?? 'local',
    policy,
    client: { id: c.id, label: c.label, flow: pref?.flow ?? null, approval: pref?.approval ?? null, questions: pref?.questions ?? null },
    effective: { flow: eff.flow, approval: eff.approval, questions: eff.questions },
    reason: eff.reason,
    ...(upload ? { upload } : {}),
  };
}

async function setPreference(a: PrefPatch, ctx: ToolContext) {
  const s = settingsOf(ctx);
  if (a.flow === undefined && a.approval === undefined && a.questions === undefined) throw new ToolError('validation', 'pass flow, approval and/or questions', 'e.g. {"flow":"off"} or {"questions":"chat"}', 'flow');
  const policy = s.policy();
  const no = refusal(policy, a);
  if (no) throw new ToolError(no.code, no.message, 'the project policy is set by a Mandate admin in Settings → Agent flow', a.flow !== undefined ? 'flow' : 'approval');
  const c = clientIdentity(ctx);
  const before = await s.clients.get(s.project, c.id);
  const rec = await s.clients.set(s.project, c, a, 'command');
  const fields = (['flow', 'approval', 'questions'] as const).filter((k) => a[k] && (before?.[k] ?? (k === 'questions' ? 'mandate' : 'on')) !== a[k]).map((k) => `${k} ${k === 'questions' ? `via ${a[k]}` : a[k]} for ${c.label}`);
  const user = ctx.principal?.kind === 'user' ? ctx.principal.login : undefined;
  const e = flowChangedEvent(s.project, fields, { agent: ctx.commit?.agent ?? c.client, ...(user ? { user } : {}), ...(ctx.principal?.kind === 'key' ? { source: ctx.principal.keyName } : {}) }, (await ctx.storage.git.head().catch(() => null)) ?? '');
  if (e) ctx.activity?.emit(e);
  const eff = effective(policy, rec);
  return { policy, client: { id: c.id, label: c.label, flow: rec.flow, approval: rec.approval, questions: rec.questions }, effective: { flow: eff.flow, approval: eff.approval, questions: eff.questions }, reason: eff.reason, changed: fields };
}

const FLOW_SET_DESC = `Turn the Mandate flow or its approval checkpoint on / off, or questions mandate | chat, for THIS client only. Refused (policy_required / policy_off) when the project policy forbids it. Returns policy, preference and effective setting.
Example: {"flow":"off"}`;

export const projectTools = [
  defineTool({
    name: 'project_info',
    title: 'Project info',
    kind: 'read',
    description: `This project and the Mandate flow for your client: policy, client preference, effective { flow, approval, questions }, reason, and upload (the curl for large files).
Call at the start of every task. flow off = read-only context; approval off = skip the approval checkpoint; questions chat = ask in chat, not question_ask.
Example: {}`,
    input: z.object({}).strict(),
    run: (_a, ctx) => info(ctx),
  }),
  defineTool({
    name: 'flow_set',
    title: 'Set my flow preference',
    kind: 'write',
    description: FLOW_SET_DESC,
    input: z.object({ flow: onOff.optional(), approval: onOff.optional(), questions: z.enum(QUESTIONS_VIA).optional() }).strict(),
    run: (a, ctx) => setPreference(a, ctx),
  }),
  defineTool({
    name: 'project_flow_set',
    title: 'Set my flow preference (deprecated)',
    kind: 'write',
    description: `DEPRECATED: use flow_set. enabled → flow, approval → approval (booleans).
Example: {"enabled":false}`,
    input: z.object({ enabled: z.boolean().optional(), approval: z.boolean().optional() }).strict(),
    run: async (a, ctx) => ({
      ...(await setPreference({ ...(a.enabled !== undefined ? { flow: a.enabled ? 'on' : 'off' } : {}), ...(a.approval !== undefined ? { approval: a.approval ? 'on' : 'off' } : {}) }, ctx)),
      deprecated: 'project_flow_set is deprecated: use flow_set { flow, approval }',
    }),
  }),
  defineTool({
    name: 'flow_policy_set',
    title: 'Set the project flow policy (admin)',
    kind: 'write',
    uiOnly: true,
    description: `Web UI admins only: the project flow policy. flowPolicy: required | optional (default, each client chooses) | off (read-only); approvalPolicy: required | optional.
Example: {"flowPolicy":"required"}`,
    input: z.object({ flowPolicy: z.enum(FLOW_POLICIES).optional(), approvalPolicy: z.enum(APPROVAL_POLICIES).optional() }).strict(),
    run: async (a, ctx) => {
      const s = settingsOf(ctx);
      if (!a.flowPolicy && !a.approvalPolicy) throw new ToolError('validation', 'pass flowPolicy and/or approvalPolicy', 'e.g. {"flowPolicy":"required"}', 'flowPolicy');
      const before = s.policy();
      const policy = await s.setPolicy(a);
      const fields = (['flowPolicy', 'approvalPolicy'] as const).filter((k) => before[k] !== policy[k]).map((k) => `${k === 'flowPolicy' ? 'flow policy' : 'approval policy'} ${policy[k]}`);
      const login = ctx.principal?.kind === 'ui' ? ctx.principal.user.login : undefined;
      const e = flowChangedEvent(s.project, fields, { agent: 'mandate-ui', ...(s.mode === 'server' && login ? { user: login } : {}) }, (await ctx.storage.git.head().catch(() => null)) ?? '');
      if (e) ctx.activity?.emit(e);
      return { policy, changed: fields };
    },
  }),
  defineTool({
    name: 'flow_clients_list',
    title: 'Flow clients',
    kind: 'read',
    description: `Agent clients seen on this project with their flow preference and effective setting (server mode: yours; admins may pass all: true).
Example: {}`,
    input: z.object({ all: z.boolean().default(false) }).strict(),
    run: async (a, ctx) => {
      const s = settingsOf(ctx);
      const me = clientIdentity(ctx);
      const login = ctx.principal?.kind === 'user' ? ctx.principal.login : ctx.principal?.kind === 'ui' ? ctx.principal.user.login : undefined;
      if (a.all && s.mode === 'server' && !(ctx.principal?.kind === 'ui' && s.isAdmin(login))) throw new ToolError('forbidden', 'only Mandate admins can list every client', 'call without all to list yours', 'all');
      const filter = s.mode === 'server' && !a.all && login ? { user: login } : {};
      const policy = s.policy();
      const clients = (await s.clients.list(s.project, filter)).map((r) => {
        const eff = effective(policy, r);
        return { ...r, effective: { flow: eff.flow, approval: eff.approval, questions: eff.questions }, you: r.id === me.id };
      });
      return { policy, clients };
    },
  }),
];

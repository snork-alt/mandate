/**
 * `mandate guard --url <server> --project <id>`: a Claude Code PreToolUse hook for Edit | Write | MultiEdit | NotebookEdit
 * (installed by `connect --strict-flow`, only for projects with strict flow on). It reads the hook JSON from stdin, asks
 * the project's `flow_edit_allowed` tool whether the agent may edit code now (it may while it holds a claimed work order
 * with a step in progress) and blocks otherwise: exit 2 with the reason on stderr, which Claude Code shows the agent.
 * Fails OPEN (exit 0) when Mandate cannot be reached or no personal token is set: the guard never traps a session.
 * It authenticates with the project's personal token ($MANDATE_KEY_<PROJECT>, or ~/.mandate/env.sh).
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { str, type Args } from './args.js';
import { envVarFor } from './agents.js';
import type { Ctx } from './context.js';
import { readEnvKeys } from './wiring.js';

export interface HookInput {
  tool_name?: string;
  tool_input?: { file_path?: string; notebook_path?: string; path?: string };
  cwd?: string;
}

export interface GuardDeps {
  stdin: string;
  call(url: string, key: string, project: string, args: Record<string, unknown>): Promise<{ allowed: boolean; reason?: string } | null>;
  /** `owner/repo` of the checkout containing cwd (origin remote), and its root. */
  repoOf(cwd: string): { root: string; github?: string } | null;
}

/** MCP Streamable HTTP, minimal: initialize, initialized, tools/call (stateless servers need no session). */
export async function callTool(url: string, key: string, project: string, args: Record<string, unknown>): Promise<{ allowed: boolean; reason?: string } | null> {
  const endpoint = `${url.replace(/\/+$/, '')}/p/${project}/mcp`;
  const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${key}` };
  const post = async (body: unknown, extra: Record<string, string> = {}) => fetch(endpoint, { method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify(body), signal: AbortSignal.timeout(4000) });
  const parse = async (r: Response): Promise<any> => {
    const t = await r.text();
    if ((r.headers.get('content-type') ?? '').includes('text/event-stream')) {
      const data = [...t.matchAll(/^data: (.*)$/gm)].map((m) => m[1]!).reverse().find((d) => d.includes('"result"') || d.includes('"error"'));
      return data ? JSON.parse(data) : null;
    }
    return t ? JSON.parse(t) : null;
  };
  try {
    const init = await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'mandate-guard', version: '1' } } });
    if (!init.ok) return null;
    const sid = init.headers.get('mcp-session-id');
    await parse(init);
    const extra: Record<string, string> = sid ? { 'mcp-session-id': sid } : {};
    await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, extra).then((r) => r.text()).catch(() => undefined);
    const r = await post({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'flow_edit_allowed', arguments: args } }, extra);
    if (!r.ok) return null;
    const j = await parse(r);
    const out = j?.result?.structuredContent ?? (j?.result?.content?.[0]?.text ? JSON.parse(j.result.content[0].text) : null);
    return out && typeof out.allowed === 'boolean' ? out : null;
  } catch {
    return null;
  }
}

export function repoOf(cwd: string): { root: string; github?: string } | null {
  const top = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8' });
  if (top.status !== 0) return null;
  const remote = spawnSync('git', ['remote', 'get-url', 'origin'], { cwd, encoding: 'utf8' });
  const m = remote.status === 0 ? /github\.com[:/]([^/\s]+\/[^/\s]+?)(?:\.git)?\s*$/.exec(remote.stdout) : null;
  return { root: top.stdout.trim(), ...(m ? { github: m[1]! } : {}) };
}

/** The decision for one hook input: { code, message } (code 2 = block). Pure apart from `deps`. */
export async function guardDecision(ctx: Ctx, a: Args, deps: GuardDeps): Promise<{ code: 0 | 2; message?: string }> {
  const url = str(a, 'url');
  const project = str(a, 'project');
  if (!url || !project) return { code: 0, message: 'mandate guard: --url and --project are required (guard skipped)' };
  let input: HookInput;
  try {
    input = JSON.parse(deps.stdin || '{}') as HookInput;
  } catch {
    return { code: 0 };
  }
  const file = input.tool_input?.file_path ?? input.tool_input?.notebook_path ?? input.tool_input?.path;
  if (!file) return { code: 0 };
  const cwd = input.cwd ?? ctx.cwd;
  const abs = path.resolve(cwd, file);
  const repo = deps.repoOf(path.dirname(abs)) ?? deps.repoOf(cwd);
  const rel = repo ? path.relative(repo.root, abs) : abs;
  // Edits outside the repo, and Claude's own config / plans, are not code of this project.
  if (!repo || rel.startsWith('..') || rel.split(path.sep)[0] === '.claude') return { code: 0 };
  const key = ctx.env[envVarFor(project)] ?? readEnvKeys(ctx).get(envVarFor(project));
  if (!key) return { code: 0, message: `mandate guard: no personal token for '${project}' (${envVarFor(project)}); the guard cannot ask Mandate and lets the edit through (connect with --auth token)` };
  const r = await deps.call(url, key, project, { path: rel, ...(repo.github ? { repo: repo.github } : {}) });
  if (!r) return { code: 0, message: 'mandate guard: Mandate is unreachable; the edit is allowed' };
  return r.allowed ? { code: 0 } : { code: 2, message: `Mandate strict flow: ${r.reason ?? 'edits need a claimed work order with a step in progress'}` };
}

export async function cmdGuard(ctx: Ctx, a: Args, stderr: (s: string) => void, stdin: () => Promise<string>): Promise<number> {
  const r = await guardDecision(ctx, a, { stdin: await stdin(), call: callTool, repoOf });
  if (r.message) stderr(r.message);
  return r.code;
}

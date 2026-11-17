/**
 * Event delivery wiring for Claude Code (see README "Event delivery to Claude Code"), written by `connect` / the
 * installer and removed by `--remove` / `uninstall`:
 *
 * - channel (`--push channels`, default): a user-scope stdio MCP server `mandate_events_<project>` in ~/.claude.json
 *   running `mandate channel`; Claude Code must be started with it as a development channel, which `mandate claude`
 *   does (`claude --dangerously-load-development-channels server:<name>`). Org admins list it in `allowedChannelPlugins`.
 * - hooks in ~/.claude/settings.json (channels and rewake modes): SessionStart `mandate events --pending --format=claude`
 *   (catch-up of events missed while Claude Code was not running), and `mandate watch --rewake` as an asyncRewake hook on
 *   SessionStart / UserPromptSubmit / Stop (re-armed each turn). The hook is a no-op while this session's channel is
 *   active, so nothing is delivered twice.
 * - `--push rewake`: the hooks only; `--push off`: nothing (and removes an earlier setup).
 *
 * The edits are separate from the MCP entry edits (agents.ts) because they touch the same files: `connect` applies them
 * in a second step, so each starts from the file as the first one left it.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { str, type Args } from './args.js';
import { PUSH_ENV } from './channel.js';
import { BIN, type Ctx } from './context.js';
import { change, jsonGet, jsonRemove, jsonSet, readText, type Change } from './edits.js';
import { readManifest } from './wiring.js';

export type PushMode = 'channels' | 'rewake' | 'off';
export const PUSH_MODES: PushMode[] = ['channels', 'rewake', 'off'];

export function pushMode(a: Args): PushMode {
  const v = str(a, 'push');
  if (v === undefined) return 'channels';
  if (!(PUSH_MODES as string[]).includes(v)) throw new Error(`--push: expected ${PUSH_MODES.join(' | ')}`);
  return v as PushMode;
}

/** The channel's MCP server name (underscores: not mistaken for the Mandate HTTP server entries `mandate-<project>`). */
export const channelName = (project: string) => `mandate_events_${project.replace(/-/g, '_')}`;
const CHANNEL_NAME = /^mandate_events_[a-z0-9_]+$/;

const shq = (s: string) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

const claudeJson = (ctx: Ctx) => path.join(ctx.home, '.claude.json');
const settingsJson = (ctx: Ctx) => path.join(ctx.home, '.claude', 'settings.json');

/** `mcpServers` entry of the channel. */
export function channelEntry(project: string, base: string) {
  return { type: 'stdio', command: BIN, args: ['channel', '--project', project, '--url', base], env: { MCP_PROTOCOL_NEGOTIATION: 'legacy' } };
}

/** The hook commands of a project. */
export const hookCommands = (project: string, base: string) => ({
  catchup: `${BIN} events --pending --format=claude --project ${shq(project)} --url ${shq(base)}`,
  watch: `${BIN} watch --rewake --project ${shq(project)} --url ${shq(base)}`,
});

const isOurs = (cmd: unknown, project?: string) => {
  if (typeof cmd !== 'string' || !new RegExp(`^${BIN} (events|watch) `).test(cmd)) return false;
  const t = cmd.split(' ');
  return project === undefined || t[t.indexOf('--project') + 1] === shq(project);
};

type Group = { matcher?: string; hooks?: { type?: string; command?: string }[] };

/** The settings text with this project's Mandate hooks removed (`project` undefined: every Mandate hook), then `add` appended. */
function hooksText(file: string, text: string | null, project: string | undefined, add: { event: string; hook: Record<string, unknown> }[]): string | null {
  let t = text;
  const hooks = (jsonGet(file, t, ['hooks']) ?? {}) as Record<string, Group[]>;
  const next: Record<string, Group[]> = {};
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) {
      next[event] = groups;
      continue;
    }
    const kept = groups.map((g) => ({ ...g, hooks: (g.hooks ?? []).filter((h) => !isOurs(h.command, project)) })).filter((g, i) => g.hooks.length || !(groups[i]!.hooks ?? []).length);
    if (kept.length) next[event] = kept;
  }
  for (const { event, hook } of add) next[event] = [...(next[event] ?? []), { hooks: [hook] }];
  if (!Object.keys(next).length) return t === null ? null : jsonRemove(file, t, ['hooks']);
  t = jsonSet(file, t, ['hooks'], next);
  return t;
}

/** Changes for one project's event delivery (`mode` off / remove: take everything of that project out). */
export function pushChanges(ctx: Ctx, project: string, base: string, mode: PushMode, remove = false): (Change | null)[] {
  const out: (Change | null)[] = [];
  // 1. The channel server entry.
  const want = !remove && mode === 'channels';
  const cj = claudeJson(ctx);
  const ct = readText(cj);
  const name = channelName(project);
  if (want) out.push(change(cj, jsonSet(cj, ct, ['mcpServers', name], channelEntry(project, base)), `Claude Code event channel ${name}`));
  else if (ct !== null && jsonGet(cj, ct, ['mcpServers', name]) !== undefined) {
    const after = jsonRemove(cj, ct, ['mcpServers', name]);
    out.push(change(cj, after !== null && after.trim() === '{}' ? null : after, `Claude Code event channel ${name}`));
  }
  // 2. Hooks.
  const sj = settingsJson(ctx);
  const st = readText(sj);
  const hookOn = !remove && mode !== 'off';
  const cmds = hookCommands(project, base);
  const add = hookOn
    ? [
        { event: 'SessionStart', hook: { type: 'command', command: cmds.catchup, timeout: 15 } },
        { event: 'SessionStart', hook: { type: 'command', command: cmds.watch, asyncRewake: true } },
        { event: 'UserPromptSubmit', hook: { type: 'command', command: cmds.watch, asyncRewake: true } },
        { event: 'Stop', hook: { type: 'command', command: cmds.watch, asyncRewake: true } },
      ]
    : [];
  if (hookOn || st !== null) {
    const after = hooksText(sj, st, project, add);
    out.push(change(sj, after !== null && after.trim() === '{}' ? null : after, 'Claude Code event hooks'));
  }
  return out;
}

/** uninstall: every channel entry and Mandate hook of every project. */
export function pushRemoveAll(ctx: Ctx): { names: string[]; changes: (Change | null)[] } {
  const ct = readText(claudeJson(ctx));
  let names: string[] = [];
  try {
    const servers = jsonGet(claudeJson(ctx), ct, ['mcpServers']);
    if (servers && typeof servers === 'object') names = Object.keys(servers).filter((k) => CHANNEL_NAME.test(k));
  } catch {
    // JSONC: left to the manual instructions of the MCP step
  }
  const sj = settingsJson(ctx);
  const st = readText(sj);
  let changes: (Change | null)[] = [];
  if (st !== null) {
    try {
      const after = hooksText(sj, st, undefined, []);
      changes = [change(sj, after !== null && after.trim() === '{}' ? null : after, 'Claude Code event hooks')];
    } catch {
      // JSONC settings: left alone
    }
  }
  return { names, changes };
}

/* ------------------------------------------------------------------ mandate claude */

/** Channel server names to load: --project, else the projects of the repo here (connect manifest), else all. */
export function channelNames(ctx: Ctx, a: Args): string[] {
  const ct = readText(claudeJson(ctx));
  let all: string[] = [];
  try {
    const servers = jsonGet(claudeJson(ctx), ct, ['mcpServers']);
    if (servers && typeof servers === 'object') all = Object.keys(servers).filter((k) => CHANNEL_NAME.test(k));
  } catch {
    return [];
  }
  const project = str(a, 'project');
  if (project) return all.filter((n) => n === channelName(project));
  const here = readManifest(ctx).repos.filter((r) => ctx.cwd === r.repo || ctx.cwd.startsWith(`${r.repo}${path.sep}`)).map((r) => channelName(r.project));
  return here.length ? all.filter((n) => here.includes(n)) : all;
}

const OWN_FLAGS = new Set(['--project', '--push']);

/**
 * `mandate claude [args]`: Claude Code with the Mandate event channel(s) loaded
 * (`claude --dangerously-load-development-channels server:<name> ...`). `--push rewake|off` starts plain `claude`.
 * The `claude` binary: $MANDATE_CLAUDE_BIN or `claude`.
 */
export async function cmdClaude(ctx: Ctx, a: Args, err: (s: string) => void): Promise<number> {
  const mode = pushMode(a);
  const passthrough: string[] = [];
  for (let i = 0; i < a.rest.length; i++) {
    const t = a.rest[i]!;
    if (OWN_FLAGS.has(t)) i++;
    else if (!/^--(project|push)=/.test(t)) passthrough.push(t);
  }
  const names = mode === 'channels' ? channelNames(ctx, a) : [];
  if (mode === 'channels' && !names.length) err(`${BIN}: no Mandate event channel is set up (run \`${BIN} connect --url <server> --project <id>\` with Claude Code, then \`${BIN} channel login --project <id>\`); starting Claude Code without it`);
  const args = names.length ? ['--dangerously-load-development-channels', ...names.map((n) => `server:${n}`), ...passthrough] : passthrough;
  const bin = ctx.env.MANDATE_CLAUDE_BIN || 'claude';
  const child = spawn(bin, args, { stdio: 'inherit', env: { ...ctx.env, ...(names.length ? { [PUSH_ENV]: 'channels', MCP_PROTOCOL_NEGOTIATION: 'legacy' } : {}) } });
  return new Promise<number>((resolve) => {
    child.on('error', (e) => {
      err(`${BIN}: cannot start ${bin}: ${e.message}`);
      resolve(127);
    });
    child.on('exit', (code, sig) => resolve(code ?? (sig ? 128 : 1)));
  });
}

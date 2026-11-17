/**
 * Claude Code wiring for the driven flow (`/mandate`), kept apart from the MCP / skill wiring:
 * - permissions: allow rules for the project's Mandate MCP tools (`mcp__mandate-<project>__*`) in ~/.claude/settings.json,
 *   so the flow loop is not stopped by a permission prompt per tool call;
 * - the edit guard (strict flow only): a PreToolUse hook in the repo's `.claude/settings.local.json` that runs
 *   `mandate guard` before Edit | Write | MultiEdit | NotebookEdit (local settings: personal, not committed).
 * Both are reversible and only touch their own entries.
 */
import path from 'node:path';
import { BIN, type Ctx } from './context.js';
import { change, jsonGet, jsonRemove, jsonSet, readText, type Change } from './edits.js';

export const GUARD_MATCHER = 'Edit|Write|MultiEdit|NotebookEdit';
export const permissionRule = (project: string) => `mcp__mandate-${project}__*`;
export const userSettingsFile = (ctx: Ctx) => path.join(ctx.home, '.claude', 'settings.json');
export const localSettingsFile = (repo: string) => path.join(repo, '.claude', 'settings.local.json');
export const guardCommand = (url: string, project: string) => `${BIN} guard --url ${url} --project ${project}`;

const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** Add (or remove) the allow rule of one project. */
export function permissionChange(ctx: Ctx, project: string, remove = false): Change | null {
  const file = userSettingsFile(ctx);
  const text = readText(file);
  const rule = permissionRule(project);
  const current = asArray(jsonGet(file, text, ['permissions', 'allow']));
  const allow = current.filter((x) => x !== rule);
  if (remove && text === null) return null;
  if (!remove && current.includes(rule)) return null;
  const next = remove ? allow : [...allow, rule];
  if (remove && next.length === current.length) return null;
  return change(file, jsonSet(file, text, ['permissions', 'allow'], next), remove ? `remove ${rule}` : `allow the Mandate tools without prompts (${rule})`);
}

const isGuardOf = (e: unknown, project: string) =>
  JSON.stringify(e).includes(` guard `) && JSON.stringify(e).includes(`--project ${project}`) && JSON.stringify(e).includes(BIN);

/** Install (or remove) the PreToolUse edit guard of one project in a repo's local Claude Code settings. */
export function guardChange(repo: string, url: string, project: string, remove = false): Change | null {
  const file = localSettingsFile(repo);
  const text = readText(file);
  if (remove && text === null) return null;
  const pre = asArray(jsonGet(file, text, ['hooks', 'PreToolUse'])).filter((e) => !isGuardOf(e, project));
  const had = asArray(jsonGet(file, text, ['hooks', 'PreToolUse'])).length !== pre.length;
  if (remove && !had) return null;
  const next = remove ? pre : [...pre, { matcher: GUARD_MATCHER, hooks: [{ type: 'command', command: guardCommand(url, project) }] }];
  let after: string | null = jsonSet(file, text, ['hooks', 'PreToolUse'], next);
  if (remove && !next.length) {
    // Nothing of ours left: prune the empty keys, and the file when it only held our hook.
    after = jsonRemove(file, text, ['hooks', 'PreToolUse']);
    if (after !== null && !Object.keys(JSON.parse(after) as object).length) after = null;
  }
  return change(file, after, remove ? 'remove the edit guard hook' : 'edit guard hook (strict flow: code edits need a claimed work order step)');
}

/** The Claude Code changes of one project: allow rules, and the guard when strict flow is on (repo given). */
export function claudeFlowChanges(ctx: Ctx, o: { project: string; url: string; repo?: string; strict?: boolean; remove?: boolean }): (Change | null)[] {
  const out: (Change | null)[] = [permissionChange(ctx, o.project, o.remove)];
  if (o.repo && (o.strict || o.remove)) out.push(guardChange(o.repo, o.url, o.project, o.remove));
  return out;
}

/** The Claude Code part of connect (only when Claude Code is among the agents): see claudeFlowChanges. */
export function claudeFlowWiring(ctx: Ctx, agents: { id: string }[], o: { project: string; url: string; repo?: string; strict?: boolean; remove?: boolean }): (Change | null)[] {
  return agents.some((a) => a.id === 'claude-code') ? claudeFlowChanges(ctx, o) : [];
}

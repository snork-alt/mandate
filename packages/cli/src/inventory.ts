/** What each coding agent supports and what Mandate has installed for it (`mandate agents`, `mandate doctor`). */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { AGENTS, COMMANDS, mandateServersIn, SKILLS, STUB_VERSION, type AgentDef } from './agents.js';
import type { Ctx } from './context.js';
import { MANAGED_MARK, readText } from './edits.js';
import { c, type Out } from './ui.js';

export interface AgentInventory {
  id: string;
  label: string;
  detected: boolean;
  supports: AgentDef['caps'];
  installed: { mcp: string[]; skills: string[]; commands: string[] };
  /** Shared locations this agent reads (e.g. ~/.agents/skills), and which other agents read them too. */
  shared: { path: string; with: string[] }[];
  /** Installed managed files that are not the current stub (full text of an older version, or an older stub): reinstall. */
  outdated: string[];
}

const managed = (f: string) => !!readText(f)?.includes(MANAGED_MARK);
const currentStub = (f: string) => !!readText(f)?.includes(`mandate-stub v${STUB_VERSION} `);

export function inventory(ctx: Ctx, agents: AgentDef[] = AGENTS): AgentInventory[] {
  const rootsBy = new Map<string, string[]>();
  for (const a of AGENTS) for (const d of a.skillDirs(ctx)) rootsBy.set(path.dirname(d), [...(rootsBy.get(path.dirname(d)) ?? []), a.id]);
  return agents.map((a) => {
    const roots = [...new Set(a.skillDirs(ctx).map((d) => path.dirname(d)))];
    const t = a.userMcp?.(ctx);
    const skillFiles = roots.flatMap((r) => SKILLS.map((s) => path.join(r, s.name, 'SKILL.md')).filter(managed));
    const commandFiles = a.commands?.user ? COMMANDS.map((cmd) => a.commands!.user!(ctx, cmd.name)).filter(managed) : [];
    return {
      id: a.id,
      label: a.label,
      detected: a.detect(ctx),
      supports: a.caps,
      installed: {
        mcp: t && existsSync(t.file) ? mandateServersIn(a, t) : [],
        skills: roots.flatMap((r) => SKILLS.map((s) => path.join(r, s.name, 'SKILL.md')).filter(managed)).map((f) => f.replace(ctx.home, '~')),
        commands: a.commands?.user ? COMMANDS.filter((cmd) => managed(a.commands!.user!(ctx, cmd.name))).map((cmd) => `/${cmd.name}`) : [],
      },
      outdated: [...skillFiles, ...commandFiles].filter((f) => !currentStub(f)).map((f) => f.replace(ctx.home, '~')),
      shared: roots.filter((r) => (rootsBy.get(r) ?? []).length > 1).map((r) => ({ path: r.replace(ctx.home, '~'), with: (rootsBy.get(r) ?? []).filter((x) => x !== a.id) })),
    };
  });
}

const capText = (v: string) => (v === 'verified' ? c.green('yes') : v === 'unverified' ? c.yellow('unverified') : c.dim('no'));

export function printInventory(rows: AgentInventory[], out: Out): void {
  for (const r of rows) {
    out.log(`${r.detected ? c.green('●') : c.dim('○')} ${c.bold(r.label)} ${c.dim(`(${r.id})`)}${r.detected ? '' : c.dim(' not detected')}`);
    out.log(`    supports  MCP ${capText(r.supports.mcp)} · skills ${capText(r.supports.skills)} · commands ${capText(r.supports.commands)} · instructions ${r.supports.instructions.join(', ')}`);
    const i = r.installed;
    out.log(`    installed MCP ${i.mcp.join(', ') || c.dim('-')} · skills ${i.skills.length ? i.skills.join(', ') : c.dim('-')} · commands ${i.commands.join(' ') || c.dim('-')}`);
    if (r.outdated.length) out.log(c.yellow(`    outdated  ${r.outdated.join(', ')} (re-run the installer or \`getmandate connect\`)`));
    for (const s of r.shared) out.log(c.dim(`    shared    ${s.path} also read by ${s.with.join(', ')}`));
  }
}

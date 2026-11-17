/**
 * The server is the single source of truth for the agent instructions. The CLI installs only short, stable STUBS (the
 * skills `mandate` / `mandate-bootstrap` and the slash commands): what the skill is for, plus "load the current text
 * with `instructions_get`". `instructions_get` serves the exact server constants (SKILL_BODY, BOOTSTRAP_SKILL_BODY,
 * FLOW_COMMAND / BOOTSTRAP_COMMAND renders), so a server update reaches every agent without a reinstall.
 * Bump STUB_VERSION only when the stub text itself must change; agents reporting an older one are told to re-run the
 * installer (`instructions_get` / `project_info` `stubVersion`). Pure module (no server imports): the CLI bundles it.
 */
import { BOOTSTRAP_COMMAND, BOOTSTRAP_SKILL_BODY } from './bootstrap.js';
import { FLOW_COMMAND, MANDATE_COMMAND, SKILL_BODY } from './guide.js';

/** Version of the installed stub files (stamped into each one). */
export const STUB_VERSION = 4;

export const INSTRUCTION_NAMES = ['core', 'bootstrap', 'flow', 'mandate'] as const;
export type InstructionName = (typeof INSTRUCTION_NAMES)[number];

/**
 * The current text for a name: exactly the server constants. `args`: the slash-command arguments (flow: the setting,
 * default status; bootstrap: the command line, rendered as `command` before the skill text).
 */
export function instructionsFor(name: InstructionName, args?: string): { text: string; command?: string } {
  if (name === 'core') return { text: SKILL_BODY };
  if (name === 'mandate') return { text: MANDATE_COMMAND.render(args?.trim() || 'status') };
  if (name === 'flow') return { text: FLOW_COMMAND.render(args?.trim() || 'status') };
  return { text: BOOTSTRAP_SKILL_BODY, ...(args !== undefined ? { command: BOOTSTRAP_COMMAND.render(args.trim()) } : {}) };
}

/** Notice for an agent whose installed stubs are older than this server's (null when current or not reported). */
export function stubUpdateNotice(reported: number | undefined): string | null {
  if (reported === undefined || reported >= STUB_VERSION) return null;
  return `Your local Mandate skill / command files are stub v${reported}; this server ships v${STUB_VERSION}. Tell the user to re-run the Mandate installer (the install line in Connect agent, or \`getmandate connect\`) to refresh them. Meanwhile follow the text instructions_get returns.`;
}

/** When the server cannot be reached: the only rule a stub holds itself. */
export const STUB_FALLBACK = 'If that tool is missing or the Mandate server cannot be reached: stop and tell the user that Mandate is unreachable. Do not work from memory or from an older copy of these instructions.';

const load = (name: InstructionName, extra = '') => `\`instructions_get {"name":"${name}"${extra},"stubVersion":${STUB_VERSION}}\``;

/** Body of the `mandate` skill stub. */
export const SKILL_STUB = `# Mandate

Mandate (MCP server \`mandate-<project>\`) holds this project's specs, standards, components, work orders and requests.
Every feature request, change, bug fix or work order in a repository connected to Mandate follows its working agreement.

**First, every task:** load the current working agreement from Mandate and follow it. It replaces any earlier copy,
including notes in your memory:

${load('core')}

${STUB_FALLBACK}

<!-- mandate-stub v${STUB_VERSION} -->
`;

/** Body of the `mandate-bootstrap` skill stub. */
export const BOOTSTRAP_SKILL_STUB = `# Mandate bootstrap

Reverse-engineers an existing codebase into Mandate (components, standards, specs), checkpointed and resumable.

**First:** load the current bootstrap procedure from Mandate and follow it (pass the user's arguments as \`args\`, e.g.
\`"distill --run <id>"\`, or \`""\` for all stages). It replaces any earlier copy:

${load('bootstrap', ',"args":"<arguments>"')}

${STUB_FALLBACK}

<!-- mandate-stub v${STUB_VERSION} -->
`;

/** Text of a slash-command stub (`args`: the agent's argument placeholder, e.g. $ARGUMENTS). */
export function commandStub(name: 'flow' | 'bootstrap' | 'mandate', args: string): string {
  const follow = name === 'bootstrap' ? 'Follow the returned `command`, then `text` (the bootstrap procedure).' : 'Follow the returned `text`.';
  return `Load the current instructions for this command from Mandate: ${load(name, `,"args":"${args}"`)}. ${follow}
${STUB_FALLBACK}
<!-- mandate-stub v${STUB_VERSION} -->`;
}

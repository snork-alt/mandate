/**
 * The ONE switch for which coding agents Mandate supports. Everything user-facing (installer, `getmandate connect` /
 * `install`, the Connect dialog, the setup wizard) derives from this list. Other agents stay implemented but hidden;
 * add an id here to re-enable it (uninstall always cleans up every known agent).
 */
export const SUPPORTED_AGENTS: readonly string[] = ['claude-code'];

export const isSupportedAgent = (id: string, supported: readonly string[] = SUPPORTED_AGENTS): boolean => supported.includes(id);

/** Shown when someone asks for an agent that is not enabled. */
export const unsupportedAgentMessage = (label: string, supported: readonly string[] = SUPPORTED_AGENTS): string =>
  `${label}: not supported yet: Mandate currently supports ${supported.length === 1 && supported[0] === 'claude-code' ? 'Claude Code' : supported.join(', ')}`;

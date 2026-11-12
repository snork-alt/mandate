/**
 * Self-restart (Settings → Mode needs a new listener: bind, host and sign-in change).
 *
 * - supervised: a supervisor restarts the process when it exits with RESTART_EXIT_CODE (launchd / systemd service,
 *   `mandate start --foreground` and the detached process all set MANDATE_SUPERVISED=1).
 * - dev: `npm run dev` runs `tsx watch --include dev-restart.signal src/index.ts --restart-signal=dev-restart.signal`
 *   (or MANDATE_RESTART_SIGNAL=<file>); writing that file makes tsx stop and rerun the server (tsx does not rerun a
 *   process that merely exited, so exiting is not enough there).
 * - manual: nothing would bring the process back; the UI shows the command instead.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** EX_TEMPFAIL: "exit and start me again". */
export const RESTART_EXIT_CODE = 75;

export type RestartKind = 'supervised' | 'dev' | 'manual';

/** The dev restart signal file (`--restart-signal=<file>` argument or MANDATE_RESTART_SIGNAL), if any. */
export function restartSignalFile(env: NodeJS.ProcessEnv = process.env, argv: readonly string[] = process.argv): string | null {
  const arg = argv.find((a) => a.startsWith('--restart-signal='));
  const file = arg?.slice('--restart-signal='.length) || env.MANDATE_RESTART_SIGNAL;
  return file ? path.resolve(file) : null;
}

export function restartKind(env: NodeJS.ProcessEnv = process.env, argv: readonly string[] = process.argv): RestartKind {
  if (restartSignalFile(env, argv)) return 'dev';
  if (env.MANDATE_SUPERVISED === '1') return 'supervised';
  return 'manual';
}

/** What a person runs to restart this server by hand. */
export function manualRestartCommand(env: NodeJS.ProcessEnv = process.env, argv: readonly string[] = process.argv): string {
  return env.npm_lifecycle_event === 'dev' || restartSignalFile(env, argv) ? 'stop and start npm run dev' : 'mandate restart';
}

export interface Restarter {
  kind(): RestartKind;
  command(): string;
  /** Restart soon (after the HTTP reply went out). Returns false when this process cannot restart itself. */
  trigger(): boolean;
}

/** The process restarter: `exit(code)` shuts the server down gracefully and exits. */
export function processRestarter(exit: (code: number) => void, env: NodeJS.ProcessEnv = process.env, argv: readonly string[] = process.argv, delayMs = 300): Restarter {
  let pending = false;
  return {
    kind: () => restartKind(env, argv),
    command: () => manualRestartCommand(env, argv),
    trigger() {
      const kind = restartKind(env, argv);
      if (kind === 'manual') return false;
      if (pending) return true;
      pending = true;
      setTimeout(() => {
        if (kind === 'dev') {
          const file = restartSignalFile(env, argv)!;
          mkdirSync(path.dirname(file), { recursive: true });
          writeFileSync(file, `${new Date().toISOString()}\n`);
        } else exit(RESTART_EXIT_CODE);
      }, delayMs).unref?.();
      return true;
    },
  };
}

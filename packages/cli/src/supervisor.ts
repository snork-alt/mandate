/**
 * Foreground supervisor (`mandate start --foreground`, and the detached process without launchd / systemd): runs the
 * server as a child with the terminal attached and starts it again when it exits with RESTART_EXIT_CODE (the server
 * asks for that after a mode switch). Any other exit, or Ctrl-C / SIGTERM, stops both.
 */
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';

/** Must match the server's RESTART_EXIT_CODE (packages/server/src/restart.ts). */
export const RESTART_EXIT_CODE = 75;

export interface SuperviseOptions {
  node: string;
  entry: string;
  args?: string[];
  env: NodeJS.ProcessEnv;
  cwd?: string;
  /** Test seam. */
  spawn?: (cmd: string, args: string[], o: SpawnOptions) => ChildProcess;
  log?: (msg: string) => void;
  /** Pause before a restart when the child ran shorter than `fastMs` (crash-loop guard). */
  fastMs?: number;
  backoffMs?: number;
  /** Signal source (tests): defaults to this process. */
  signals?: Pick<NodeJS.Process, 'on' | 'off'>;
}

const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;

/** Resolves with the exit code to use once the server stopped for good. */
export async function supervise(o: SuperviseOptions): Promise<number> {
  const run = o.spawn ?? spawn;
  const sig = o.signals ?? process;
  let stopping = false;
  let child: ChildProcess | null = null;
  const forward = (s: NodeJS.Signals) => {
    stopping = true;
    // The terminal sends Ctrl-C to the whole process group; forwarding again is harmless (the server shuts down once).
    child?.kill(s);
  };
  for (const s of SIGNALS) sig.on(s, forward);
  try {
    for (;;) {
      const started = Date.now();
      child = run(o.node, [o.entry, ...(o.args ?? [])], { stdio: 'inherit', cwd: o.cwd, env: { ...o.env, MANDATE_SUPERVISED: '1' } });
      const code = await new Promise<number>((resolve) => {
        child!.once('error', (e) => {
          o.log?.(`could not start the server: ${e.message}`);
          resolve(1);
        });
        child!.once('exit', (c, s) => resolve(c ?? (s === 'SIGINT' || s === 'SIGTERM' ? 0 : 1)));
      });
      child = null;
      if (code !== RESTART_EXIT_CODE || stopping) return code === RESTART_EXIT_CODE ? 0 : code;
      o.log?.('Mandate is restarting…');
      if (Date.now() - started < (o.fastMs ?? 3000)) await new Promise((r) => setTimeout(r, o.backoffMs ?? 1000));
      if (stopping) return 0;
    }
  } finally {
    for (const s of SIGNALS) sig.off(s, forward);
  }
}

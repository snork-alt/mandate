/** Foreground supervisor: restarts the server child on exit 75; any other exit or a stop signal ends both. */
import { spawn, type SpawnOptions } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { RESTART_EXIT_CODE, supervise } from '../src/supervisor.js';

const dir = mkdtempSync(path.join(os.tmpdir(), 'mandate-supervisor-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** A fake server: appends a line per run (with MANDATE_SUPERVISED), exits 75 for the first `restarts` runs, then `final`. */
function fakeServer(name: string, restarts: number, final: number | 'wait'): { entry: string; runs: () => string[] } {
  const log = path.join(dir, `${name}.log`);
  const entry = path.join(dir, `${name}.mjs`);
  writeFileSync(
    entry,
    `import { appendFileSync, existsSync, readFileSync } from 'node:fs';
const log = ${JSON.stringify(log)};
appendFileSync(log, 'run supervised=' + process.env.MANDATE_SUPERVISED + '\\n');
const n = readFileSync(log, 'utf8').trim().split('\\n').length;
if (n <= ${restarts}) process.exit(${RESTART_EXIT_CODE});
${final === 'wait' ? "process.on('SIGTERM', () => process.exit(0)); setInterval(() => {}, 1000);" : `process.exit(${final});`}
`,
  );
  return { entry, runs: () => readFileSync(log, 'utf8').trim().split('\n') };
}

/** The real spawn, without the child's output in the test log. */
const quiet = (c: string, a: string[], o: SpawnOptions) => spawn(c, a, { ...o, stdio: 'ignore' });

describe('foreground supervisor', () => {
  it('restarts the child on exit 75 and returns the final exit code', async () => {
    const s = fakeServer('restart', 2, 0);
    const msgs: string[] = [];
    const code = await supervise({ node: process.execPath, entry: s.entry, env: process.env, log: (m) => msgs.push(m), fastMs: 0, spawn: quiet });
    expect(code).toBe(0);
    expect(s.runs()).toEqual(['run supervised=1', 'run supervised=1', 'run supervised=1']);
    expect(msgs).toEqual(['Mandate is restarting…', 'Mandate is restarting…']);
  });

  it('a crash (other exit code) is not restarted', async () => {
    const s = fakeServer('crash', 0, 3);
    expect(await supervise({ node: process.execPath, entry: s.entry, env: process.env, spawn: quiet })).toBe(3);
    expect(s.runs()).toHaveLength(1);
  });

  it('Ctrl-C / SIGTERM stops the child and the supervisor (no restart)', async () => {
    const s = fakeServer('stop', 0, 'wait');
    const signals = new EventEmitter();
    const done = supervise({ node: process.execPath, entry: s.entry, env: process.env, signals: signals as never, spawn: quiet });
    for (let i = 0; i < 100; i++) {
      await new Promise((r) => setTimeout(r, 20));
      try {
        if (s.runs().length) break;
      } catch {
        /* not started yet */
      }
    }
    signals.emit('SIGTERM', 'SIGTERM');
    expect(await done).toBe(0);
    expect(s.runs()).toHaveLength(1);
    expect(signals.listenerCount('SIGTERM')).toBe(0);
  });
});

/** Self-restart: supervised → exit 75 for the supervisor; dev → touch the tsx watch signal file; else manual. */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { processRestarter, restartKind, RESTART_EXIT_CODE } from '../src/restart.js';
import { cleanupTempDirs, tempDir } from './helpers.js';

afterAll(cleanupTempDirs);
const tick = () => new Promise((r) => setTimeout(r, 30));

describe('restart', () => {
  it('detects how this process restarts', () => {
    expect(restartKind({}, [])).toBe('manual');
    expect(restartKind({ MANDATE_SUPERVISED: '1' }, [])).toBe('supervised');
    expect(restartKind({}, ['node', 'src/index.ts', '--restart-signal=dev-restart.signal'])).toBe('dev');
    expect(restartKind({ MANDATE_RESTART_SIGNAL: 'x.signal', MANDATE_SUPERVISED: '1' }, [])).toBe('dev');
  });

  it('supervised: exits with 75 (once, after the reply); dev: writes the signal file; manual: refuses', async () => {
    const codes: number[] = [];
    const sup = processRestarter((c) => codes.push(c), { MANDATE_SUPERVISED: '1' }, [], 5);
    expect(sup.trigger()).toBe(true);
    expect(sup.trigger()).toBe(true);
    expect(codes).toEqual([]);
    await tick();
    expect(codes).toEqual([RESTART_EXIT_CODE]);
    const file = path.join(await tempDir(), 'sub', 'dev-restart.signal');
    const dev = processRestarter((c) => codes.push(c), {}, [`--restart-signal=${file}`], 5);
    expect(dev.command()).toBe('stop and start npm run dev');
    expect(dev.trigger()).toBe(true);
    await tick();
    expect(existsSync(file)).toBe(true);
    expect(codes).toEqual([RESTART_EXIT_CODE]); // dev never exits by itself: tsx stops and reruns it
    const manual = processRestarter((c) => codes.push(c), {}, [], 5);
    expect(manual.trigger()).toBe(false);
    expect(manual.command()).toBe('mandate restart');
  });
});

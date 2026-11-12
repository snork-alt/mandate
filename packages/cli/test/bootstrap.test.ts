/** `mandate bootstrap`: run folders (0700), manifest handling, the notes schema validator, retention cleanup. */
import { describe, expect, it } from 'vitest';
import { appendFileSync, existsSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { cleanRuns, expiredRuns, findRun, initRun, listRuns, noteSchema, validateRun } from '../src/bootstrap.js';
import { run } from '../src/cli.js';
import { NOTE_TYPES } from '../../server/src/mcp/bootstrap.js';
import { capture, tempCtx } from './helpers.js';

const note = (o: Record<string, unknown>) => JSON.stringify({ area: 'api', statement: 'handlers return {error}', evidence: ['shop:src/api/orders.ts#L40-L52'], confidence: 'high', ...o });

describe('bootstrap runs', () => {
  it('init: private run folder outside any repo, manifest with areas', () => {
    const ctx = tempCtx();
    const r = initRun(ctx, 'shop', { scope: ['src'], areas: ['api=src/api,lib/api', 'web=src/web'] });
    expect(r.dir).toBe(path.join(ctx.mandateHome, 'bootstrap', 'shop', r.runId));
    expect(statSync(r.dir).mode & 0o777).toBe(0o700);
    expect(statSync(path.join(r.dir, 'notes')).mode & 0o777).toBe(0o700);
    expect(r.manifest).toMatchObject({ version: 1, project: 'shop', stage: 'setup', retentionDays: 14, areas: [{ id: 'api', paths: ['src/api', 'lib/api'], status: 'pending', notes: 'notes/api.jsonl' }, { id: 'web' }] });
    expect(findRun(ctx, r.runId).manifest.runId).toBe(r.runId);
    expect(() => initRun(ctx, 'Bad Id', {})).toThrow(/kebab-case/);
    expect(() => initRun(ctx, 'shop', { areas: ['a=x', 'a=y'] })).toThrow(/twice/);
    expect(initRun(ctx, 'shop', { scope: ['src/api', 'web'] }).manifest.areas.map((a) => a.id)).toEqual(['src-api', 'web']);
  });

  it('status updates stage, area status and work order through the CLI', async () => {
    const ctx = tempCtx();
    const { runId } = initRun(ctx, 'shop', { areas: ['api=src/api'] });
    expect(await run(['bootstrap', 'status', runId, '--area', 'api', '--area-status', 'extracted', '--stage', 'extract', '--work-order', 'mandate://work-orders/wo-1'], ctx.env, capture(), ctx.dir)).toBe(0);
    expect(findRun(ctx, runId).manifest).toMatchObject({ stage: 'extract', workOrder: 'mandate://work-orders/wo-1', areas: [{ id: 'api', status: 'extracted' }] });
    await expect(run(['bootstrap', 'status', runId, '--area', 'nope', '--area-status', 'extracted'], ctx.env, capture(), ctx.dir)).rejects.toThrow(/no area/);
    await expect(run(['bootstrap', 'status', runId, '--stage', 'bogus'], ctx.env, capture(), ctx.dir)).rejects.toThrow(/--stage/);
  });

  it('validate: every note type, plus precise errors', async () => {
    expect(noteSchema.options.length).toBe(NOTE_TYPES.length);
    const ctx = tempCtx();
    const { runId, dir } = initRun(ctx, 'shop', { areas: ['api=src/api'] });
    const file = path.join(dir, 'notes', 'api.jsonl');
    writeFileSync(
      file,
      [
        note({ type: 'convention', conforming: 23, violating: 2 }),
        note({ type: 'component_candidate', name: 'api', paths: ['src/api/**'] }),
        note({ type: 'behavior' }),
        note({ type: 'test', test: 'orders returns 404 for unknown ids', command: 'npm test' }),
        note({ type: 'dependency', from: 'api', to: 'db' }),
        note({ type: 'api_surface' }),
        note({ type: 'data_model' }),
        note({ type: 'doc_claim', evidence: ['README.md'] }),
        note({ type: 'question', question: 'Is the retry on purpose?' }),
        '',
      ].join('\n'),
    );
    expect(validateRun(dir, findRun(ctx, runId).manifest).issues).toEqual([]);
    const out = capture();
    expect(await run(['bootstrap', 'validate', runId], ctx.env, out, ctx.dir)).toBe(0);
    expect(out.text()).toContain('notes valid: convention 1');
    appendFileSync(file, `${note({ type: 'convention' })}\n{not json\n${note({ type: 'behavior', evidence: ['nope'] })}\n${note({ type: 'behavior', area: 'web' })}\n${note({ type: 'guess' })}\n`);
    const bad = capture();
    expect(await run(['bootstrap', 'validate', runId], ctx.env, bad, ctx.dir)).toBe(1);
    const t = bad.text();
    expect(t).toMatch(/notes\/api\.jsonl:10: conforming/);
    expect(t).toMatch(/notes\/api\.jsonl:11: not JSON/);
    expect(t).toMatch(/notes\/api\.jsonl:12: evidence\.0: evidence is a code ref/);
    expect(t).toMatch(/notes\/api\.jsonl:13: area 'web' is not in manifest\.json/);
    expect(t).toMatch(/notes\/api\.jsonl:14: type/);
  });

  it('retention: only finished runs past their retention are removed (doctor --clean, start)', async () => {
    const ctx = tempCtx();
    const done = initRun(ctx, 'shop', {});
    const active = initRun(ctx, 'shop', {});
    const short = initRun(ctx, 'web', { retentionDays: 1 });
    for (const r of [done, short]) await run(['bootstrap', 'status', r.runId, '--stage', 'done'], ctx.env, capture(), ctx.dir);
    const now = Date.now();
    expect(expiredRuns(ctx, now + 2 * 86_400_000)).toEqual([short.dir]);
    expect(cleanRuns(ctx, { at: now + 15 * 86_400_000, dryRun: true }).sort()).toEqual([done.dir, short.dir].sort());
    expect(existsSync(done.dir)).toBe(true);
    expect(cleanRuns(ctx, { at: now + 15 * 86_400_000 }).length).toBe(2);
    expect(listRuns(ctx).map((r) => r.dir)).toEqual([active.dir]);
    expect(cleanRuns(ctx, { days: 0 })).toEqual([]); // active runs are never removed
  });
});

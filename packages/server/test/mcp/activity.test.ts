/** Live activity feed: event derivation, notifications to concurrent sessions, filters, backfill, outside commits, pulls. */
import { execFileSync } from 'node:child_process';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ACTIVITY_NOTIFICATION, type ActivityEvent } from '@mandate/shared';
import { EsGitStore } from '../../src/git/EsGitStore.js';
import { ActivityBus } from '../../src/events/index.js';
import { workOrderCodec } from '../../src/storage/codecs.js';
import { tempDir } from '../helpers.js';
import { connect, mcpFixture, type McpFixture } from './fixture.js';

let fx: McpFixture;
beforeAll(async () => {
  fx = await mcpFixture();
}, 120_000);
afterAll(async () => fx?.close());

const trailers = (agent: string) => `\n\nAgent: ${agent}\nBranch: feat/activity`;

/** Append text to the last section of a spec and commit through the (hooked) GitStore, like the storage layer does. */
async function editSpec(id: string, text: string, agent = 'claude-test') {
  const file = `specs/${id}.md`;
  const p = path.join(fx.dir, file);
  await writeFile(p, `${(await readFile(p, 'utf8')).trimEnd()} ${text}\n`);
  return fx.git.commit([file], `specs: update ${id}${trailers(agent)}`);
}

/** Rewrite the first work order document (through a flat view: status, note, claim, section statuses) and commit. */
async function editWorkOrder(fn: (w: Record<string, any>) => void, agent = 'claude-test') {
  const id = (await readdir(path.join(fx.dir, 'work-orders'))).filter((f) => f.endsWith('.md')).sort()[0]!.slice(0, -3);
  const file = `work-orders/${id}.md`;
  const p = path.join(fx.dir, file);
  const d = workOrderCodec.decode(await readFile(p, 'utf8'), id);
  const wos = d.sections.filter((s) => s.type === 'wo-section');
  const w: Record<string, any> = { id, status: d.status, note: d.note, claim: d.claim, sections: wos.map((s) => ({ id: s.id, status: s.status })) };
  fn(w);
  const next = { ...d, status: w.status, note: w.note, claim: w.claim, sections: d.sections.map((s) => (s.type === 'wo-section' ? { ...s, status: w.sections.find((x: { id: string }) => x.id === s.id).status } : s)) };
  if (!next.claim) delete next.claim;
  await writeFile(p, workOrderCodec.encode(next as never));
  await fx.git.commit([file], `work order: update ${id}${trailers(agent)}\nWork-Order: ${id}`);
  return w;
}

function collector(client: Awaited<ReturnType<typeof connect>>) {
  const got: ActivityEvent[] = [];
  client.fallbackNotificationHandler = async (n) => {
    if (n.method === ACTIVITY_NOTIFICATION) got.push(n.params as unknown as ActivityEvent);
  };
  return {
    got,
    async waitFor(pred: (e: ActivityEvent) => boolean, ms = 3000) {
      for (let t = 0; t < ms; t += 25) {
        const e = got.find(pred);
        if (e) return e;
        await new Promise((r) => setTimeout(r, 25));
      }
      throw new Error(`no matching event; got ${got.map((e) => e.type).join(', ')}`);
    },
  };
}

describe('activity_list (git-backed)', () => {
  it('derives every kind of event from the seeded history', async () => {
    const r = await fx.call('activity_list', { limit: 500 });
    expect(r.isError, JSON.stringify(r.body)).toBe(false);
    const types = new Set((r.body.events as ActivityEvent[]).map((e) => e.type));
    for (const t of ['spec.created', 'spec.section.updated', 'standard.created', 'work_order.created', 'request.created', 'request.closed', 'verification.recorded']) {
      expect(types, t).toContain(t);
    }
    expect(r.body.head).toBe(fx.head);
    const ev = (r.body.events as ActivityEvent[])[0]!;
    expect(ev.id).toMatch(/^[0-9a-f]{40}:\d+$/);
    expect(ev.commit).toHaveLength(40);
  });

  it('filters by ref (a document matches its sections), types and agent', async () => {
    const r = await fx.call('activity_list', { ref: '@mandate:mandate://specs/login-sso', types: ['spec.*'], limit: 200 });
    const evs = r.body.events as ActivityEvent[];
    expect(evs.length).toBeGreaterThan(0);
    expect(evs.every((e) => e.type.startsWith('spec.') && e.refs.some((x) => x.startsWith('mandate://specs/login-sso')))).toBe(true);
    expect(evs.some((e) => e.type.startsWith('spec.section.'))).toBe(true);
    const created = await fx.call('activity_list', { types: ['*.created'], limit: 500 });
    expect((created.body.events as ActivityEvent[]).every((e) => e.type.endsWith('.created'))).toBe(true);
  });

  it('validates input with structured errors', async () => {
    expect((await fx.call('activity_list', { types: ['spec..x'] })).body.error.code).toBe('invalid_input');
    expect((await fx.call('activity_list', { ref: 'nope' })).body.error.path).toBe('ref');
    expect((await fx.call('activity_list', { limit: 501 })).body.error.path).toBe('limit');
    expect((await fx.call('activity_list', { since: 'deadbee' })).body.error).toMatchObject({ code: 'not_found', detail: { kind: 'commit' }, path: 'since' });
    expect((await fx.call('activity_subscribe', { bogus: true })).body.error.code).toBe('invalid_input');
  });
});

describe('live notifications', () => {
  it('pushes a section edit to two concurrent sessions, with agent, branch and a word preview', async () => {
    const a = await connect(fx.url, 'a');
    const b = await connect(fx.url, 'b');
    const ca = collector(a);
    const cb = collector(b);
    await a.listTools();
    await b.listTools();
    await new Promise((r) => setTimeout(r, 100)); // standalone SSE streams open after initialize
    const sha = await editSpec('login-sso', 'Freshly appended words.');
    const pred = (e: ActivityEvent) => e.commit === sha && e.type === 'spec.section.updated';
    const ea = await ca.waitFor(pred);
    const eb = await cb.waitFor(pred);
    expect(eb).toEqual(ea);
    expect(ea).toMatchObject({ agent: 'claude-test', branch: 'feat/activity' });
    expect(ea.refs[0]).toMatch(/^mandate:\/\/specs\/login-sso\/sections\//);
    expect(ea.details?.preview?.some((o) => o.op === 'insert' && o.text.includes('Freshly'))).toBe(true);
    await a.close();
    await b.close();
  });

  it('applies per-session subscription filters', async () => {
    const a = await connect(fx.url, 'wo-only');
    const ca = collector(a);
    const sub = await a.callTool({ name: 'activity_subscribe', arguments: { types: ['work_order.*'] } });
    expect(sub.isError).toBeFalsy();
    await new Promise((r) => setTimeout(r, 100));
    const specSha = await editSpec('user-sessions', 'Another sentence.');
    await editWorkOrder((w) => {
      w.note = `touched ${Date.now()}`;
    });
    const e = await ca.waitFor((x) => x.type.startsWith('work_order.'));
    expect(e.type).toBe('work_order.updated');
    expect(ca.got.some((x) => x.commit === specSha)).toBe(false);
    await a.close();
  });

  it('derives claims, section_done and completion (heartbeats are not commits any more)', async () => {
    const now = () => new Date().toISOString();
    const w = await editWorkOrder((x) => {
      x.status = 'in_progress';
      x.claim = { agent: 'claude-a', startedAt: now() };
      for (const s of x.sections) s.status = 'pending';
    });
    await editWorkOrder((x) => {
      x.sections[0].status = 'done';
    });
    await editWorkOrder((x) => {
      for (const s of x.sections) s.status = 'done';
      x.status = 'done';
      delete x.claim;
    });
    const r = await fx.call('activity_list', { ref: `mandate://work-orders/${w.id}`, limit: 20 });
    const types = (r.body.events as ActivityEvent[]).map((e) => e.type);
    expect(types).toEqual(expect.arrayContaining(['work_order.section_done', 'work_order.completed']));
    expect(types.includes('work_order.claimed') || types.includes('work_order.updated')).toBe(true);
    const done = (r.body.events as ActivityEvent[]).find((e) => e.type === 'work_order.completed')!;
    expect(done.details?.progress).toEqual({ done: w.sections.length, total: w.sections.length });
    expect((await fx.call('activity_list', { ref: `mandate://work-orders/${w.id}`, includeHeartbeats: false })).body.events.some((e: ActivityEvent) => e.heartbeat)).toBe(false);
  });

  it('reconnect: backfills missed events with since = the last head', async () => {
    const before = (await fx.call('activity_list', { limit: 1 })).body.head as string;
    const s1 = await editSpec('dark-mode', 'Missed while offline one.');
    const s2 = await editSpec('dark-mode', 'Missed while offline two.');
    const c = await connect(fx.url, 'reconnected');
    const r = await c.callTool({ name: 'activity_list', arguments: { since: before } });
    const evs = (r.structuredContent as { events: ActivityEvent[]; head: string }).events;
    expect([...new Set(evs.map((e) => e.commit))]).toEqual([s2, s1]);
    expect((r.structuredContent as { head: string }).head).toBe(s2);
    await c.close();
  });

  it('picks up commits made outside Mandate (HEAD poll)', async () => {
    const outside = new EsGitStore({ dir: fx.dir, author: { name: 'Hand', email: 'hand@example.com' } });
    await outside.open();
    const p = path.join(fx.dir, 'specs/dark-mode.md');
    await writeFile(p, `${(await readFile(p, 'utf8')).trimEnd()} Edited by hand.\n`);
    const sha = await outside.commit(['specs/dark-mode.md'], 'hand edit');
    const events = await fx.activity.catchUp();
    expect(events.some((e) => e.commit === sha && e.type === 'spec.section.updated' && !e.agent)).toBe(true);
    expect(fx.activity.recent()[0]!.commit).toBe(sha);
  });
});

describe('git.pulled', () => {
  it('emits the pulled commits and a git.pulled event', async () => {
    const root = await tempDir();
    const upstream = path.join(root, 'upstream');
    const local = path.join(root, 'local');
    execFileSync('git', ['clone', '-q', fx.dir, upstream]);
    execFileSync('git', ['clone', '-q', upstream, local]);
    const branch = execFileSync('git', ['-C', upstream, 'branch', '--show-current']).toString().trim();
    const git = new EsGitStore({ dir: local, branch, remote: { url: upstream, branch }, author: { name: 'T', email: 't@example.com' } });
    await git.open();
    const bus = new ActivityBus(git, { pollMs: 0 });
    await bus.start();
    const got: ActivityEvent[] = [];
    bus.subscribe((e) => got.push(e));
    const f = path.join(upstream, 'specs/login-sso.md');
    await writeFile(f, `${(await readFile(f, 'utf8')).trimEnd()} Upstream change.\n`);
    execFileSync('git', ['-C', upstream, '-c', 'user.name=U', '-c', 'user.email=u@example.com', 'commit', '-qam', 'upstream edit\n\nAgent: remote-agent']);
    expect(await git.pull()).toBe(true);
    const pulled = got.find((e) => e.type === 'git.pulled')!;
    expect(pulled.details?.commits).toHaveLength(1);
    expect(got.find((e) => e.type === 'spec.section.updated')?.agent).toBe('remote-agent');
    expect((await bus.list({ types: ['git.pulled'] })).events).toHaveLength(1);
    bus.stop();
  });
});

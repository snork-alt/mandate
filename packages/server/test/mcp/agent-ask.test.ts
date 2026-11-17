/**
 * Ask is answered by agents: ask_post routing (the only online agent, a handle, any, nobody -> waits and is delivered
 * to the first agent that connects), the ask_question event, ask_pending catch-up, ask_answer chunks / done / first
 * answerer owns it, ask_cancel, and that the old server-side Ask is gone.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { newsFallback, type NewsService } from '../../src/news/index.js';
import { connect, mcpFixture, type McpFixture } from './fixture.js';

vi.setConfig({ testTimeout: 60_000 });

let fx: McpFixture;
let news: NewsService;
let bob: Client;
let carol: Client;
let bobId: string;
let carolId: string;
beforeAll(async () => {
  fx = await mcpFixture();
  news = newsFallback('test', fx.activity);
  const key = fx.served.keys.list()[0]!.name;
  bobId = `codex/${key}`;
  carolId = `gemini/${key}`;
  bob = await connect(fx.url, 'codex');
  carol = await connect(fx.url, 'gemini');
}, 120_000);
afterAll(async () => {
  await bob?.close().catch(() => undefined);
  await carol?.close().catch(() => undefined);
  await fx?.close();
});

const call = async (c: Client, name: string, args: Record<string, unknown> = {}) => {
  const r = await c.callTool({ name, arguments: args });
  return { isError: !!r.isError, body: (r.structuredContent ?? {}) as Record<string, any> };
};
const items = async (client: string) => (await news.store.items('test', client)).filter((i) => i.kind === 'ask_question');

describe('Ask threads', () => {
  it('the server-side Ask is gone: no ask / ask_status tools', async () => {
    const names = (await fx.client.listTools()).tools.map((t) => t.name);
    expect(names).not.toContain('ask');
    expect(names).not.toContain('ask_status');
    expect(names).toEqual(expect.arrayContaining(['ask_pending', 'ask_answer']));
    expect((await call(fx.client as Client, 'ask', { question: 'x' })).isError).toBe(true);
  });

  it('nobody online: the question waits; the first agent that connects gets it as an event and can answer in chunks', async () => {
    const posted = await call(fx.client as Client, 'ask_post', { question: 'What blocks login-sso?', context: ['mandate://specs/login-sso'] });
    expect(posted.isError).toBe(false);
    expect(posted.body).toMatchObject({ status: 'waiting', waiting: true, to: null });
    const id = posted.body.id as string;
    // bob connects (a tool call): the waiting question is delivered to him
    await call(bob, 'project_info');
    await vi.waitFor(async () => expect((await items(bobId)).length).toBeGreaterThan(0));
    const ev = (await items(bobId))[0]!;
    expect(ev.summary).toContain(id);
    expect(ev.summary).toContain('What blocks login-sso?');
    expect(ev.ref).toBe(`mandate://ask/${id}`);
    // catch-up
    const pending = await call(bob, 'ask_pending');
    expect(pending.body.items.map((t: any) => t.id)).toContain(id);
    // chunks
    const a1 = await call(bob, 'ask_answer', { id, text: 'Part one. ', done: false });
    expect(a1.body).toMatchObject({ status: 'answering', answer: 'Part one. ' });
    const progress = await call(fx.client as Client, 'ask_get', { id });
    expect(progress.body).toMatchObject({ status: 'answering', answer: 'Part one. ' });
    // another agent cannot take it over
    const stolen = await call(carol, 'ask_answer', { id, text: 'mine' });
    expect(stolen.isError).toBe(true);
    expect(stolen.body.error.code).toBe('ask_taken');
    const a2 = await call(bob, 'ask_answer', { id, text: 'Part two.' });
    expect(a2.body).toMatchObject({ status: 'done', answer: 'Part one. Part two.' });
    expect((await call(bob, 'ask_answer', { id, text: 'again' })).body.error.code).toBe('ask_closed');
    expect((await call(bob, 'ask_pending')).body.items.map((t: any) => t.id)).not.toContain(id);
    // answering read the event
    expect((await items(bobId)).filter((i) => i.ref.endsWith(id) && !i.readAt)).toHaveLength(0);
  });

  it('addressed to a handle, or any online agent; auto when exactly one is online', async () => {
    const one = await call(fx.client as Client, 'ask_post', { question: 'to carol', to: 'gemini' });
    expect(one.body.delivered).toBe(1);
    expect((await items(carolId)).some((i) => i.summary.includes('to carol'))).toBe(true);
    expect((await items(bobId)).some((i) => i.summary.includes('to carol'))).toBe(false);
    const any = await call(fx.client as Client, 'ask_post', { question: 'to anyone', to: 'any' });
    expect(any.body.to).toBe('any');
    expect(any.body.delivered).toBeGreaterThanOrEqual(2);
    // a conversation groups questions
    const follow = await call(fx.client as Client, 'ask_post', { question: 'follow-up', to: 'codex', conversationId: any.body.conversationId });
    const conv = await call(fx.client as Client, 'ask_get', { conversationId: any.body.conversationId });
    expect(conv.body.items.map((t: any) => t.id)).toEqual([any.body.id, follow.body.id]);
  });

  it('cancel: the question is closed and cannot be answered', async () => {
    const p = await call(fx.client as Client, 'ask_post', { question: 'never mind', to: 'codex' });
    const c = await call(fx.client as Client, 'ask_cancel', { id: p.body.id });
    expect(c.body.status).toBe('cancelled');
    const a = await call(bob, 'ask_answer', { id: p.body.id, text: 'x' });
    expect(a.body.error.code).toBe('ask_closed');
    expect((await call(fx.client as Client, 'ask_get', { id: 'ask-nope' })).body.error.code).toBe('not_found');
  });
});

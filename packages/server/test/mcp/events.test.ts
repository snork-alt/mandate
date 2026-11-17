/** Push event stream (mcp/events.ts): SSE with Last-Event-ID resume, claiming (no double delivery), pending catch-up, ack, auth. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newsFallback, type NewsService } from '../../src/news/index.js';
import { mcpFixture, type McpFixture } from './fixture.js';

let fx: McpFixture;
let news: NewsService;
let base: string;
let client: string;
beforeAll(async () => {
  fx = await mcpFixture();
  news = newsFallback('test', fx.activity);
  base = `${fx.url.origin}/p/test`;
  client = `claude-code/${fx.served.keys.list()[0]!.name}`;
}, 120_000);
afterAll(async () => fx?.close());

const auth = () => ({ authorization: `Bearer ${fx.served.key('test')}` });
const add = (kind: string, n = 1) => news.addClientWide(client, kind, 'mandate://projects/test', `${kind} ${n}`);
const top = async () => (await news.store.items('test', client)).reduce((m, i) => Math.max(m, i.seq), 0);

/** Read SSE events from a fetch until `n` data events arrived (or the timeout). */
async function sse(url: string, n: number, headers: Record<string, string> = {}, ms = 3000) {
  const ctl = new AbortController();
  const r = await fetch(url, { headers: { ...auth(), ...headers }, signal: ctl.signal });
  const out: { id: string; event: string; data: any }[] = [];
  let hb = 0;
  const reader = r.body!.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    while (out.length < n) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value);
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (block.includes(': hb')) hb++;
        const f = Object.fromEntries(block.split('\n').filter((l) => /^(id|event|data): /.test(l)).map((l) => [l.slice(0, l.indexOf(':')), l.slice(l.indexOf(': ') + 2)]));
        if (f.data) out.push({ id: f.id!, event: f.event!, data: JSON.parse(f.data) });
      }
    }
  } catch {
    // aborted
  }
  clearTimeout(timer);
  await reader.cancel().catch(() => undefined);
  ctl.abort();
  await new Promise((r) => setTimeout(r, 50)); // the server notices the disconnect
  return { r, events: out, hb };
}

describe('events stream', () => {
  it('needs a token', async () => {
    expect((await fetch(`${base}/events`)).status).toBe(401);
    expect((await fetch(`${base}/events/pending`, { headers: { authorization: 'Bearer nope' } })).status).toBe(401);
  });

  it('streams new items live with id = seq, then resumes from Last-Event-ID without repeats', async () => {
    const q = `${base}/events?consumer=c1`;
    const live = sse(q, 2);
    await new Promise((r) => setTimeout(r, 200));
    await add('flow_changed', 1);
    await add('claim_released', 2);
    const { r, events } = await live;
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toMatch(/text\/event-stream/);
    expect(events.map((e) => e.data.kind)).toEqual(['flow_changed', 'claim_released']);
    expect(events[0]).toMatchObject({ event: 'news', id: String(events[0]!.data.seq), data: { ref: 'mandate://projects/test', summary: 'flow_changed 1' } });
    expect(events[1]!.data.seq).toBeGreaterThan(events[0]!.data.seq);

    await add('comment', 3);
    const resumed = await sse(q, 1, { 'last-event-id': events[1]!.id });
    expect(resumed.events.map((e) => e.data.kind)).toEqual(['comment']);
  });

  it('delivers an item to one consumer only; and never again to that consumer on reconnect', async () => {
    const mark = await top();
    await add('drift', 4);
    const a = await sse(`${base}/events?consumer=A&since=${mark}`, 1);
    expect(a.events.map((e) => e.data.kind)).toEqual(['drift']);
    const b = await sse(`${base}/events?consumer=B&since=${mark}`, 1, {}, 400);
    expect(b.events).toEqual([]);
    const a2 = await sse(`${base}/events?consumer=A&since=${mark}`, 1);
    expect(a2.events).toEqual([]);
    expect(await news.pushable(client, 'A', { since: mark })).toEqual([]);
  });

  it('only the client identity of the caller', async () => {
    await news.addClientWide('someone/else', 'flow_changed', 'mandate://projects/test', 'not yours');
    const r = await sse(`${base}/events?consumer=own&since=${await top()}`, 1, {}, 400);
    expect(r.events).toEqual([]);
  });
});

describe('events pending and ack', () => {
  const get = async (qs: string) => (await (await fetch(`${base}/events/pending?${qs}`, { headers: auth() })).json()) as { items: { seq: number; kind: string }[]; next: number };

  it('pending claims like a stream (second consumer gets nothing), peek does not claim, ack marks read', async () => {
    const mark = await top();
    await add('flow_changed', 5);
    await add('comment', 6);
    expect((await get(`since=${mark}&consumer=P&peek=1`)).items).toHaveLength(2);
    expect((await get(`since=${mark}&consumer=Q&peek=1`)).items).toHaveLength(2);
    const p = await get(`since=${mark}&consumer=P`);
    expect(p.items.map((i) => i.kind)).toEqual(['flow_changed', 'comment']);
    expect(p.next).toBe(p.items[1]!.seq);
    expect((await get(`since=${mark}&consumer=Q`)).items).toEqual([]);

    const post = (ids: unknown[]) => fetch(`${base}/events/ack`, { method: 'POST', headers: { ...auth(), 'content-type': 'application/json' }, body: JSON.stringify({ ids }) });
    expect(await (await post([p.items[0]!.seq])).json()).toEqual({ acked: 1 });
    expect((await get(`since=${mark}&consumer=P`)).items).toEqual([]); // delivered once: not again to P
    expect((await post(['x'])).status).toBe(400);
  });

  it('an item pushed but still unread long after is pushed again', async () => {
    const mark = await top();
    await add('drift', 7);
    const [pushed] = await news.pushable(client, 'old', { since: mark });
    expect(await news.pushable(client, 'other', { since: mark })).toEqual([]);
    // age the claim (re-stamp it by its own consumer an hour ago)
    await news.store.claim('test', client, [pushed!.seq], 'old', new Date(Date.now() + 1000).toISOString(), new Date(Date.now() - 3_600_000));
    expect((await news.pushable(client, 'other', { since: mark })).map((i) => i.seq)).toEqual([pushed!.seq]);
  });

  it('a delivered item is re-pushed after the delay at most twice more, then only listed', async () => {
    const mark = await top();
    await add('drift', 8);
    const [first] = await news.pushable(client, 'rw', { since: mark });
    const seq = first!.seq;
    const age = () => news.store.claim('test', client, [seq], 'rw', new Date(Date.now() + 1000).toISOString(), new Date(Date.now() - 3_600_000));
    expect(await news.pushable(client, 'rw', { since: mark })).toEqual([]); // same consumer: not again at once
    await age(); // 2nd push (re-stamped old)
    expect((await news.pushable(client, 'rw', { since: mark })).map((i) => i.seq)).toEqual([seq]); // 2nd delivery of the same item to the same consumer after the delay
    await age();
    expect((await news.pushable(client, 'rw', { since: mark })).map((i) => i.seq)).toEqual([]); // 3 pushes used up
    await age();
    expect(await news.pushable(client, 'other', { since: mark })).toEqual([]);
    expect((await news.store.items('test', client, { unread: true })).some((i) => i.seq === seq)).toBe(true); // still listed
  });
});

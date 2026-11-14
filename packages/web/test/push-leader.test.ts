// @vitest-environment jsdom
/** One push stream per origin: cross-tab leader election (Web Locks / heartbeat fallback), the stream gate, and the UI MCP client. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPushLeader, type ChannelLike, type LeaderEnv, type LocksLike, type PushMessage } from '../src/mcp/pushLeader';
import { createStreamGate } from '../src/mcp/client';

/* ---------------- fakes ---------------- */

class Bus {
  chans = new Set<FakeChannel>();
}
class FakeChannel implements ChannelLike {
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  constructor(
    private bus: Bus,
    readonly name: string,
  ) {
    bus.chans.add(this);
  }
  postMessage(msg: unknown) {
    const data = structuredClone(msg);
    for (const c of this.bus.chans) if (c !== this && c.name === this.name) setTimeout(() => c.onmessage?.({ data }), 0);
  }
  close() {
    this.bus.chans.delete(this);
  }
}

/** Exclusive locks, granted FIFO; a waiting request is dropped when its signal aborts. */
class FakeLocks implements LocksLike {
  private held = new Map<string, boolean>();
  private queue = new Map<string, { cb: () => Promise<unknown>; signal?: AbortSignal; resolve: (v: unknown) => void; reject: (e: unknown) => void }[]>();
  request(name: string, options: { signal?: AbortSignal }, cb: (lock: unknown) => Promise<unknown>) {
    return new Promise((resolve, reject) => {
      const q = this.queue.get(name) ?? [];
      this.queue.set(name, q);
      const entry = { cb: () => cb({ name }), signal: options.signal, resolve, reject };
      q.push(entry);
      options.signal?.addEventListener('abort', () => {
        const i = q.indexOf(entry);
        if (i >= 0) {
          q.splice(i, 1);
          reject(new DOMException('aborted', 'AbortError'));
        }
      });
      this.pump(name);
    });
  }
  private pump(name: string) {
    if (this.held.get(name)) return;
    const next = this.queue.get(name)?.shift();
    if (!next) return;
    this.held.set(name, true);
    void next
      .cb()
      .then(next.resolve, next.reject)
      .finally(() => {
        this.held.set(name, false);
        this.pump(name);
      });
  }
}

class Tab {
  visible = true;
  private visCbs = new Set<() => void>();
  leads = 0;
  follows = 0;
  got: PushMessage[] = [];
  leader;
  constructor(bus: Bus | null, locks: LocksLike | null, opts = {}) {
    const env: LeaderEnv = {
      locks,
      channel: bus ? (name) => new FakeChannel(bus, name) : null,
      visible: () => this.visible,
      onVisibility: (cb) => {
        this.visCbs.add(cb);
        return () => this.visCbs.delete(cb);
      },
      onUnload: () => () => undefined,
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
      now: () => Date.now(),
      random: () => Math.random(),
    };
    this.leader = createPushLeader('p1', { onLead: () => this.leads++, onFollow: () => this.follows++, onMessage: (m) => this.got.push(m) }, env, { hiddenGraceMs: 1_000, ...opts });
  }
  setVisible(v: boolean) {
    this.visible = v;
    for (const cb of this.visCbs) cb();
  }
}

const leaders = (tabs: Tab[]) => tabs.filter((t) => t.leader.isLeader());

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('push leader (Web Locks)', () => {
  it('elects exactly one leader, relays to the others, hands over on close', async () => {
    const bus = new Bus();
    const locks = new FakeLocks();
    const tabs = Array.from({ length: 8 }, () => new Tab(bus, locks));
    await vi.advanceTimersByTimeAsync(10);
    expect(leaders(tabs)).toEqual([tabs[0]]);
    tabs[0]!.leader.publish({ t: 'ev', n: { method: 'notifications/mandate/activity', params: { id: 'a1' } } });
    tabs[3]!.leader.publish({ t: 'ev', n: { method: 'x' } }); // followers cannot publish
    await vi.advanceTimersByTimeAsync(10);
    for (const t of tabs.slice(1)) expect(t.got).toEqual([{ t: 'ev', n: { method: 'notifications/mandate/activity', params: { id: 'a1' } } }]);
    expect(tabs[0]!.got).toEqual([]);
    tabs[0]!.leader.stop();
    await vi.advanceTimersByTimeAsync(10);
    expect(tabs[0]!.follows).toBe(1);
    expect(leaders(tabs)).toEqual([tabs[1]]);
    expect(tabs[1]!.leads).toBe(1);
  });

  it('hidden tabs do not compete; a hidden leader steps down after the grace period', async () => {
    const bus = new Bus();
    const locks = new FakeLocks();
    const a = new Tab(bus, locks);
    const b = new Tab(bus, locks);
    const c = new Tab(bus, locks);
    await vi.advanceTimersByTimeAsync(10);
    expect(a.leader.isLeader()).toBe(true);
    b.setVisible(false); // b gives up its place in the queue
    a.setVisible(false);
    await vi.advanceTimersByTimeAsync(500);
    expect(a.leader.isLeader()).toBe(true); // grace period
    await vi.advanceTimersByTimeAsync(600);
    expect(leaders([a, b, c])).toEqual([c]);
    // All hidden: nobody holds a stream.
    c.setVisible(false);
    await vi.advanceTimersByTimeAsync(1_100);
    expect(leaders([a, b, c])).toEqual([]);
    b.setVisible(true);
    await vi.advanceTimersByTimeAsync(10);
    expect(leaders([a, b, c])).toEqual([b]);
  });

  it('a leader that comes back before the grace period keeps the lead', async () => {
    const bus = new Bus();
    const locks = new FakeLocks();
    const a = new Tab(bus, locks);
    const b = new Tab(bus, locks);
    await vi.advanceTimersByTimeAsync(10);
    a.setVisible(false);
    await vi.advanceTimersByTimeAsync(500);
    a.setVisible(true);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(leaders([a, b])).toEqual([a]);
    expect(a.follows).toBe(0);
  });
});

describe('push leader (heartbeat fallback, no Web Locks)', () => {
  it('elects one leader, resolves conflicts, takes over on bye and on silence', async () => {
    const bus = new Bus();
    const tabs = Array.from({ length: 4 }, () => new Tab(bus, null));
    await vi.advanceTimersByTimeAsync(3_000);
    expect(leaders(tabs)).toHaveLength(1);
    const first = leaders(tabs)[0]!;
    first.leader.stop(); // posts bye
    await vi.advanceTimersByTimeAsync(3_000);
    const second = leaders(tabs);
    expect(second).toHaveLength(1);
    expect(second[0]).not.toBe(first);
    // A late tab joins as follower.
    const late = new Tab(bus, null);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(late.leader.isLeader()).toBe(false);
    expect(leaders([...tabs, late])).toHaveLength(1);
    second[0]!.leader.publish({ t: 'up', src: 's1' });
    await vi.advanceTimersByTimeAsync(10);
    expect(late.got).toContainEqual({ t: 'up', src: 's1' });
  });

  it('without BroadcastChannel a visible tab leads alone', async () => {
    const t = new Tab(null, null);
    expect(t.leader.isLeader()).toBe(true);
    t.setVisible(false);
    await vi.advanceTimersByTimeAsync(1_100);
    expect(t.leader.isLeader()).toBe(false);
  });
});

describe('stream gate', () => {
  const sse = () => new Response(new ReadableStream({ start: () => undefined }), { status: 200, headers: { 'content-type': 'text/event-stream' } });

  it('answers a GET locally with 405 when not allowed; passes POSTs through', async () => {
    const base = vi.fn(async () => new Response('{}', { status: 200 }));
    const gate = createStreamGate({ allow: () => false, fetch: base as unknown as typeof fetch });
    expect((await gate.fetch('http://x/p/a/mcp', { method: 'GET' })).status).toBe(405);
    expect(base).not.toHaveBeenCalled();
    await gate.fetch('http://x/p/a/mcp', { method: 'POST', body: '{}' });
    expect(base).toHaveBeenCalledTimes(1);
  });

  it('allows one stream at a time and reports its life', async () => {
    vi.useRealTimers();
    const base = vi.fn(async () => sse());
    const up = vi.fn();
    const down = vi.fn();
    const gate = createStreamGate({ allow: () => true, fetch: base as unknown as typeof fetch, onUp: up, onDown: down });
    const r = await gate.fetch('http://x/p/a/mcp', { method: 'GET' });
    expect(r.status).toBe(200);
    expect(up).toHaveBeenCalledTimes(1);
    expect(gate.busy()).toBe(true);
    expect((await gate.fetch('http://x/p/a/mcp', { method: 'GET' })).status).toBe(405);
    expect(base).toHaveBeenCalledTimes(1);
    gate.abort();
    expect(down).toHaveBeenCalledTimes(1);
    expect(gate.busy()).toBe(false);
  });
});

describe('UI MCP client', () => {
  /** A minimal Streamable HTTP server: JSON responses, records every GET (standalone stream). */
  function fakeServer() {
    const gets: string[] = [];
    const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      const method = (init?.method ?? 'GET').toUpperCase();
      if (method === 'GET') {
        gets.push(new URL(url).pathname);
        return new Response(new ReadableStream({ start: () => undefined }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
      }
      if (method === 'DELETE') return new Response(null, { status: 200 });
      const msg = JSON.parse(String(init?.body)) as { id?: number; method: string };
      if (msg.id === undefined) return new Response(null, { status: 202 });
      const json = (result: unknown) => new Response(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }), { status: 200, headers: { 'content-type': 'application/json', 'mcp-session-id': 'sid-1' } });
      if (msg.method === 'initialize') return json({ protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '0' } });
      return json({ content: [{ type: 'text', text: '{"ok":true}' }], structuredContent: { ok: true } });
    });
    return { gets, fetchFn };
  }
  const env = (locks: LocksLike | null, granted: boolean): LeaderEnv => ({
    locks: granted ? locks : { request: () => new Promise(() => undefined) }, // never granted: another tab leads
    channel: (name) => new FakeChannel(new Bus(), name),
    visible: () => true,
    onVisibility: () => () => undefined,
    onUnload: () => () => undefined,
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
    now: () => Date.now(),
    random: () => Math.random(),
  });

  beforeEach(() => {
    vi.useRealTimers();
    vi.resetModules();
  });
  afterEach(() => vi.unstubAllGlobals());

  it('follower tab: tool calls (project, side project, unscoped) open no standalone GET stream', async () => {
    const srv = fakeServer();
    vi.stubGlobal('fetch', srv.fetchFn);
    const mod = await import('../src/mcp/client');
    mod.__setLeaderEnv(env(null, false));
    mod.setMcpProject('alpha');
    await expect(mod.callTool('spec_list', {})).resolves.toEqual({ ok: true });
    await expect(mod.callProjectTool('beta', 'spec_list', {})).resolves.toEqual({ ok: true });
    await expect(mod.callProjectTool('gamma', 'spec_list', {})).resolves.toEqual({ ok: true });
    await expect(mod.callRootTool('project_list')).resolves.toEqual({ ok: true });
    await new Promise((r) => setTimeout(r, 200));
    expect(srv.gets).toEqual([]);
    mod.setMcpProject(null);
  });

  it('leader tab: exactly one stream, for the current project only', async () => {
    const srv = fakeServer();
    vi.stubGlobal('fetch', srv.fetchFn);
    const mod = await import('../src/mcp/client');
    mod.__setLeaderEnv(env(new FakeLocks(), true));
    mod.setMcpProject('alpha');
    await mod.callTool('spec_list', {});
    await mod.callProjectTool('beta', 'spec_list', {});
    await mod.callRootTool('project_list');
    await new Promise((r) => setTimeout(r, 300));
    expect(srv.gets).toEqual(['/p/alpha/mcp']);
    mod.setMcpProject(null);
  });
});

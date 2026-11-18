/** Presence after a server restart: agents known from the persisted directory are `reconnecting`, not offline (lastSeen real, no 1970). */
import { describe, expect, it } from 'vitest';
import { AgentPresence, RECONNECT_MS } from '../../src/agents/presence.js';
import { seedKnownClients } from '../../src/comments/route.js';
import { MemoryClientStore } from '../../src/projects/settings.js';

const me = { id: 'ada/claude-code', label: 'Claude Code', client: 'claude-code', user: 'ada' };

describe('presence seeding', () => {
  it('seeds from flow_clients.last_seen_at: recently seen -> reconnecting with the real lastSeen; long ago / never -> offline', async () => {
    const clients = new MemoryClientStore();
    const now = Date.now();
    await clients.seen('p', me, now - 2 * 60_000);
    await clients.seen('p', { id: 'bob/claude-code', label: 'Claude Code', client: 'claude-code', user: 'bob' }, now - RECONNECT_MS - 60_000);
    const presence = new AgentPresence();
    await seedKnownClients({ settings: { project: 'p', clients } } as never, presence);
    const views = presence.list([], now);
    const ada = views.find((v) => v.id === 'ada/claude-code')!;
    expect(ada.state).toBe('reconnecting');
    expect(ada.lastSeen).toBe(new Date(now - 2 * 60_000).toISOString());
    expect(views.find((v) => v.id === 'bob/claude-code')!.state).toBe('offline');
    expect(views[0]!.id).toBe('ada/claude-code'); // reconnecting sorts before offline
    // Never a 1970 timestamp.
    const p2 = new AgentPresence();
    p2.know(me);
    expect(p2.list([])[0]!.lastSeen).toBeUndefined();
    expect(p2.list([])[0]!.state).toBe('offline');
  });

  it('a call or stream makes it online again; once online and idle past the window it is offline (reconnecting is only the restart gap)', () => {
    const presence = new AgentPresence();
    const now = Date.now();
    presence.know(me, now - 60_000);
    expect(presence.list([], now)[0]!.state).toBe('reconnecting');
    presence.note(me);
    expect(presence.list([])[0]!.state).toBe('online');
    expect(presence.list([], Date.now() + 10 * 60_000)[0]!.state).toBe('offline');
  });
});

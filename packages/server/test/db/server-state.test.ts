/** Server state on every backend: sessions, GitHub tokens, personal tokens, OAuth, login tokens, idempotency, legacy import. */
import { randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { AgentTokens } from '../../src/auth/agent-tokens.js';
import { OAuthStore } from '../../src/auth/mcp-oauth.js';
import { AuthStore } from '../../src/auth/sessions.js';
import { DbIdempotencyStore } from '../../src/db/idempotency.js';
import { importLegacyJson, ServerState } from '../../src/db/state.js';
import { LocalLoginTokens } from '../../src/setup/files.js';
import { describeBackends, useBackendCleanup } from './backends.js';

useBackendCleanup();
const home = () => mkdtempSync(path.join(os.tmpdir(), 'mandate-state-'));

describeBackends('server state', (b) => {
  const open = async () => ServerState.open(await b.open());

  it('migrations are idempotent', async () => {
    const st = await open();
    await expect(ServerState.open(st.db)).resolves.toBeInstanceOf(ServerState);
  });

  it('sessions: create, read, expire, delete, forged cookies refused', async () => {
    const st = await open();
    let now = 1_000_000;
    const store = new AuthStore(home(), randomBytes(32), 60_000, () => now, st);
    await store.ready;
    const c = await store.createSession({ login: 'octo', name: 'Octo', avatarUrl: 'a', kind: 'github' });
    expect(await store.session(c)).toEqual({ login: 'octo', name: 'Octo', avatarUrl: 'a', kind: 'github' });
    expect(await store.session(`${c}x`)).toBeNull();
    expect(await store.session(undefined)).toBeNull();
    now += 60_001;
    expect(await store.session(c)).toBeNull();
    now -= 60_001;
    await store.deleteSession(c);
    expect(await store.session(c)).toBeNull();
    const local = await store.createSession({ login: 'me', avatarUrl: '', kind: 'local' });
    expect((await store.session(local))?.kind).toBe('local');
    // Another "instance" (a second store on the same database) sees the session; prune removes expired rows.
    const other = new AuthStore(home(), randomBytes(32), 60_000, () => now, st);
    expect(await other.session(local)).toBeNull(); // different secret: the MAC fails
    await st.prune(now + 10 * 86_400_000);
    expect((await st.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${st.t('sessions')}`))!.n).toBe(0);
  });

  it('GitHub tokens: encrypted at rest, revocation, cached synchronous status', async () => {
    const st = await open();
    const store = new AuthStore(home(), randomBytes(32), 60_000, Date.now, st);
    await store.ready;
    await store.saveToken('Octo', 'gho_secret_value', ['repo']);
    const row = await st.db.get<{ enc: string }>(`SELECT enc FROM ${st.t('github_tokens')} WHERE login_lc = 'octo'`);
    expect(row!.enc).not.toContain('gho_secret');
    expect(await store.token('octo')).toEqual({ token: 'gho_secret_value', scopes: ['repo'] });
    expect(store.tokenStatus('OCTO')).toBe('ok');
    await store.markRevoked('octo');
    expect(await store.token('octo')).toBeNull();
    expect(await store.scopes('octo')).toEqual([]);
    expect(store.tokenStatus('octo')).toBe('reconnect');
    await store.saveToken('octo', 'gho_new', ['repo', 'read:org']);
    expect(store.tokenCached('octo')?.token).toBe('gho_new');
  });

  it('personal agent tokens: hashed, project-bound, revocable immediately', async () => {
    const st = await open();
    const t = new AgentTokens(home(), st);
    const { token, record } = await t.create('octo', 'specs', 'laptop');
    expect(JSON.stringify(await st.db.all(`SELECT * FROM ${st.t('agent_tokens')}`))).not.toContain(token);
    expect((await t.verify(token))?.project).toBe('specs');
    expect((await t.verify(token))?.lastUsedAt).toBeTruthy();
    expect(await t.verify(`${token}x`)).toBeNull();
    expect((await t.list('OCTO')).map((r) => r.id)).toEqual([record.id]);
    expect(await t.revoke('mallory', record.id)).toBe(false);
    expect(await t.revoke('octo', record.id)).toBe(true);
    expect(await t.verify(token)).toBeNull();
    await expect(t.create('octo', 'specs', '')).rejects.toThrow(/token name/);
  });

  it('OAuth: one-time codes, refresh rotation, family revocation, user revocation, client cap', async () => {
    const st = await open();
    const o = new OAuthStore(home(), st);
    const c = await o.register(['https://app.example/cb'], 'Agent');
    expect((await o.client(c.client_id))?.redirect_uris).toEqual(['https://app.example/cb']);
    const code = await o.newCode({ clientId: c.client_id, redirectUri: 'x', challenge: 'y', login: 'octo', project: 'specs', exp: Date.now() + 60_000 });
    const [a, b2] = await Promise.all([o.takeCode(code), o.takeCode(code)]);
    expect([a, b2].filter(Boolean)).toHaveLength(1);
    const t1 = await o.issue(c.client_id, 'octo', 'specs');
    expect((await o.access(t1.access_token))?.login).toBe('octo');
    expect(await o.refresh(t1.refresh_token, 'other-client')).toBeNull();
    const old = await o.refresh(t1.refresh_token, c.client_id);
    expect(old?.family).toBeTruthy();
    expect(await o.refresh(t1.refresh_token, c.client_id)).toBeNull(); // rotated
    const t2 = await o.issue(c.client_id, 'octo', 'specs', old!.family);
    await o.revoke(t2.refresh_token);
    expect(await o.access(t1.access_token)).toBeNull(); // whole family
    const t3 = await o.issue(c.client_id, 'Octo', 'specs');
    await o.revokeUser('octo');
    expect(await o.access(t3.access_token)).toBeNull();
  });

  it('local login tokens are single use and expire', async () => {
    const st = await open();
    const l = new LocalLoginTokens(home(), st);
    const t = await l.issue();
    const [x, y] = await Promise.all([l.consume(t), l.consume(t)]);
    expect([x, y].sort()).toEqual([false, true]);
    expect(await l.consume(await l.issue(-1))).toBe(false);
    expect(await l.consume(undefined)).toBe(false);
  });

  it('idempotency results replay per project for 24 h', async () => {
    const st = await open();
    const a = new DbIdempotencyStore(st, 'a');
    const bb = new DbIdempotencyStore(st, 'b');
    const result = { content: [{ type: 'text' as const, text: 'ok' }] };
    await a.set('k1', { args: '{}', at: Date.now(), result });
    expect((await a.get('k1'))?.result).toEqual(result);
    expect(await bb.get('k1')).toBeUndefined();
    await a.set('k1', { args: '{"x":1}', at: Date.now(), result });
    expect((await a.get('k1'))?.args).toBe('{"x":1}');
    await a.set('old', { args: '{}', at: Date.now() - 25 * 3600_000, result });
    expect(await a.get('old')).toBeUndefined();
    await a.delete('k1');
    expect(await a.get('k1')).toBeUndefined();
  });

  it('imports legacy JSON state once and leaves the files', async () => {
    const st = await open();
    const h = home();
    const future = new Date(Date.now() + 3600_000).toISOString();
    writeFileSync(path.join(h, 'sessions.json'), JSON.stringify({ sessions: [{ id: 'abc', login: 'octo', avatarUrl: 'a', createdAt: future, expiresAt: future }, { id: 'old', login: 'x', avatarUrl: 'a', createdAt: future, expiresAt: '2000-01-01T00:00:00Z' }] }));
    writeFileSync(path.join(h, 'agent-tokens.json'), JSON.stringify({ tokens: [{ id: 'pat_1', login: 'octo', project: 'p', name: 'n', hash: 'h1', createdAt: future }] }));
    writeFileSync(path.join(h, 'oauth.json'), JSON.stringify({ clients: [{ client_id: 'mcp_1', redirect_uris: ['https://x/cb'], client_id_issued_at: 1 }], tokens: [] }));
    writeFileSync(path.join(h, 'idem.json'), JSON.stringify({ key1: { args: '{}', at: Date.now(), result: { content: [] } } }));
    expect((await importLegacyJson(st, h)).sort()).toEqual(['agent-tokens.json', 'oauth.json', 'sessions.json']);
    expect(await importLegacyJson(st, h)).toEqual([]);
    expect((await st.db.all(`SELECT id FROM ${st.t('sessions')}`)).map((r) => (r as { id: string }).id)).toEqual(['abc']);
    expect(await st.db.get(`SELECT id FROM ${st.t('agent_tokens')} WHERE hash = 'h1'`)).toEqual({ id: 'pat_1' });
    const idem = new DbIdempotencyStore(st, 'p', path.join(h, 'idem.json'));
    expect((await idem.get('key1'))?.args).toBe('{}');
  });
});

describeBackends('db copy (SQLite → this backend)', (b) => {
  it('copies every server-state table, keeps existing rows, and is idempotent', async () => {
    const { SqliteDb } = await import('../../src/db/sqlite.js');
    const { copyServerState } = await import('../../src/db/copy.js');
    const src = SqliteDb.open(':memory:');
    const s1 = await ServerState.open(src);
    const store = new AuthStore(home(), randomBytes(32), 60_000, Date.now, s1);
    await store.createSession({ login: 'octo', avatarUrl: 'a' });
    await new AgentTokens(home(), s1).create('octo', 'specs', 'laptop');
    await new OAuthStore(home(), s1).register(['https://x/cb'], 'Agent');
    const dst = await b.open();
    const r = await copyServerState(src, dst);
    expect(r.sessions).toEqual({ read: 1, written: 1 });
    expect(r.agent_tokens!.written).toBe(1);
    expect((await copyServerState(src, dst)).sessions!.written).toBe(0);
    const s2 = await ServerState.open(dst);
    expect((await s2.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${s2.t('oauth_clients')}`))!.n).toBe(1);
    await src.close();
  });
});

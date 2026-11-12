/**
 * Server mode: personal agent tokens (the fallback to MCP OAuth). Created by a signed-in user in the Connect dialog,
 * scoped to (user, project), shown once, stored only as SHA-256 hashes in the server-state database (`agent_tokens`),
 * revocable, with a last-used time. The bearer acts AS the user: GitHub repo permissions decide read / write.
 */
import { createHash, randomBytes } from 'node:crypto';
import { stateForHome, type ServerState } from '../db/state.js';

export interface AgentTokenRecord {
  id: string;
  login: string;
  project: string;
  name: string;
  hash: string;
  createdAt: string;
  lastUsedAt?: string;
}

export const AGENT_TOKEN_PREFIX = 'mndp_';
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

interface Row {
  id: string;
  login: string;
  project: string;
  name: string;
  hash: string;
  created_at: number;
  last_used_at: number | null;
}
const rec = (r: Row): AgentTokenRecord => ({ id: r.id, login: r.login, project: r.project, name: r.name, hash: r.hash, createdAt: new Date(Number(r.created_at)).toISOString(), ...(r.last_used_at ? { lastUsedAt: new Date(Number(r.last_used_at)).toISOString() } : {}) });

export class AgentTokens {
  private readonly state: Promise<ServerState>;

  constructor(home: string, state?: ServerState | Promise<ServerState>) {
    this.state = state ? Promise.resolve(state) : stateForHome(home);
  }

  /** New token: the value is returned once and never stored. */
  async create(login: string, project: string, name: string): Promise<{ token: string; record: Omit<AgentTokenRecord, 'hash'> }> {
    if (!/^[A-Za-z0-9][A-Za-z0-9 ._@:-]{0,59}$/.test(name)) throw new Error('token name: 1-60 chars of letters, digits, space . _ @ : -');
    const token = `${AGENT_TOKEN_PREFIX}${project}_${randomBytes(32).toString('base64url')}`;
    const now = Date.now();
    const id = `pat_${randomBytes(6).toString('hex')}`;
    const st = await this.state;
    await st.db.run(`INSERT INTO ${st.t('agent_tokens')} (id, login, login_lc, project, name, hash, created_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`, [id, login, login.toLowerCase(), project, name, sha(token), now]);
    return { token, record: { id, login, project, name, createdAt: new Date(now).toISOString() } };
  }

  async list(login: string, project?: string): Promise<Omit<AgentTokenRecord, 'hash'>[]> {
    const st = await this.state;
    const rows = await st.db.all<Row>(`SELECT * FROM ${st.t('agent_tokens')} WHERE login_lc = ?${project ? ' AND project = ?' : ''} ORDER BY created_at, id`, project ? [login.toLowerCase(), project] : [login.toLowerCase()]);
    return rows.map((r) => {
      const { hash: _h, ...t } = rec(r);
      return t;
    });
  }

  /** Revoke one of the user's own tokens. */
  async revoke(login: string, id: string): Promise<boolean> {
    const st = await this.state;
    return (await st.db.run(`DELETE FROM ${st.t('agent_tokens')} WHERE id = ? AND login_lc = ?`, [id, login.toLowerCase()])).changes > 0;
  }

  /** The token's record (lookup by the SHA-256 of a 256-bit secret); records lastUsedAt (at most once a minute). */
  async verify(presented: string): Promise<AgentTokenRecord | null> {
    if (!presented.startsWith(AGENT_TOKEN_PREFIX)) return null;
    const st = await this.state;
    const r = await st.db.get<Row>(`SELECT * FROM ${st.t('agent_tokens')} WHERE hash = ?`, [sha(presented)]);
    if (!r) return null;
    const now = Date.now();
    if (!r.last_used_at || now - Number(r.last_used_at) > 60_000) {
      await st.db.run(`UPDATE ${st.t('agent_tokens')} SET last_used_at = ? WHERE id = ?`, [now, r.id]);
      r.last_used_at = now;
    }
    return rec(r);
  }
}

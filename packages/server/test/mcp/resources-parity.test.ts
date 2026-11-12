/** MCP resources (every template) and search parity (MCP results equal the direct service-function results). */
import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RESOURCE_TEMPLATES } from '../../src/mcp/resources.js';
import { mcpFixture, type McpFixture } from './fixture.js';

let fx: McpFixture;
let woId: string;
let fbId: string;

beforeAll(async () => {
  fx = await mcpFixture();
  woId = (await fx.storage.workOrderService.list())[0]!.id;
  fbId = (await fx.storage.feedback.list())[0]!.id;
}, 120_000);
afterAll(async () => fx?.close());

const read = async (uri: string) => {
  const r = await fx.client.readResource({ uri });
  return r.contents[0] as { uri: string; mimeType: string; text: string };
};

describe('resources', () => {
  it('lists templates and concrete resources', async () => {
    const { resourceTemplates } = await fx.client.listResourceTemplates();
    expect(resourceTemplates.map((t) => t.uriTemplate)).toEqual(RESOURCE_TEMPLATES.map((t) => t.uriTemplate));
    const { resources } = await fx.client.listResources();
    const uris = resources.map((r) => r.uri);
    expect(uris).toContain('mandate://specs/login-sso');
    expect(uris).toContain('mandate://specs/login-sso/sections/auth-flow');
    expect(uris).toContain('mandate://standards/security-baseline');
    expect(uris).toContain(`mandate://work-orders/${woId}`);
  });

  /** One concrete URI per template (same order as RESOURCE_TEMPLATES). */
  const examples = () => {
    const sha = fx.older.slice(0, 7);
    const out: Record<string, { uri: string; check: (c: { mimeType: string; text: string }) => void }> = {};
    for (const [k, id, sid] of [
      ['specs', 'login-sso', 'auth-flow'],
      ['standards', 'security-baseline', 'rules'],
      ['components', 'auth-service', 'sessions-api'],
    ] as const) {
      // Components are newer than fx.older: pin them at the commit that last changed the file.
      const pinned = k === 'components' ? execFileSync('git', ['-C', fx.dir, 'log', '-1', '--format=%H', '--', `components/${id}.md`], { encoding: 'utf8' }).trim() : fx.older;
      const sha = pinned.slice(0, 7);
      out[`mandate://${k}/{id}`] = { uri: `mandate://${k}/${id}`, check: (c) => expect(c.text).toContain(`<!-- @section ${sid} -->`) };
      out[`mandate://${k}/{id}/sections/{section}`] = {
        uri: `mandate://${k}/${id}/sections/${sid}`,
        check: (c) => {
          expect(c.mimeType).toBe('text/markdown');
          expect(c.text).toMatch(/^---\n/);
          expect(c.text).toContain(`section: ${sid}`);
          expect(c.text).toContain('commit: HEAD');
          expect(c.text).toContain('\n## ');
        },
      };
      out[`mandate://${k}/{id}@{sha}`] = { uri: `mandate://${k}/${id}@${sha}`, check: (c) => expect(c.text.startsWith('---')).toBe(true) };
      out[`mandate://${k}/{id}@{sha}/sections/{section}`] = { uri: `mandate://${k}/${id}@${sha}/sections/${sid}`, check: (c) => expect(c.text).toContain(`commit: ${pinned}`) };
      out[`mandate://${k}/{id}/sections/{section}#L{start}-L{end}`] = {
        uri: `mandate://${k}/${id}/sections/${sid}#L2-L4`,
        check: (c) => {
          expect(c.text).toContain('excerpt: L2-L4');
          expect(c.text.split('---\n')[2]!.trim().split('\n').length).toBeLessThanOrEqual(3);
        },
      };
    }
    out['mandate://architecture{?focus}'] = {
      uri: 'mandate://architecture?focus=auth-service',
      check: (c) => (expect(JSON.parse(c.text).mermaid).toContain('flowchart'), expect(JSON.parse(c.text).ref).toContain('focus=auth-service')),
    };
    out['mandate://architecture@{sha}{?focus}'] = { uri: `mandate://architecture@${sha}`, check: (c) => expect(JSON.parse(c.text).commit).toBe(fx.older) };
    out['mandate://work-orders/{id}'] = { uri: `mandate://work-orders/${woId}`, check: (c) => expect(JSON.parse(c.text).item.id).toBe(woId) };
    out['mandate://feedback/{id}'] = { uri: `mandate://feedback/${fbId}`, check: (c) => expect(JSON.parse(c.text).feedback.id).toBe(fbId) };
    out['mandate://{kind}/{name}'] = { uri: 'mandate://symbols/AuthService.login', check: (c) => expect(JSON.parse(c.text).node.kind).toBe('symbol') };
    return out;
  };

  it('has an example for every template', () => {
    expect(Object.keys(examples()).sort()).toEqual(RESOURCE_TEMPLATES.map((t) => t.uriTemplate).sort());
  });

  for (const t of RESOURCE_TEMPLATES) {
    it(`reads ${t.uriTemplate}`, async () => {
      const ex = examples()[t.uriTemplate]!;
      const c = await read(ex.uri);
      expect(c.uri).toBe(ex.uri);
      ex.check(c);
    });
  }

  it('resolves @mandate: mentions and the legacy queue alias', async () => {
    const c = await read('@mandate:mandate://specs/login-sso/sections/auth-flow');
    expect(c.text).toContain('section: auth-flow');
    const q = await read(`mandate://queue/${woId}`);
    expect(JSON.parse(q.text).uri).toBe(`mandate://work-orders/${woId}`);
  });

  it('errors for unknown or malformed references', async () => {
    await expect(fx.client.readResource({ uri: 'mandate://specs/no-such-spec' })).rejects.toThrow(/does not exist/);
    await expect(fx.client.readResource({ uri: 'mandate://specs/login-sso/sections/nope' })).rejects.toThrow(/no section/);
    await expect(fx.client.readResource({ uri: 'https://example.com/x' })).rejects.toThrow(/not a mandate/);
    await expect(fx.client.readResource({ uri: 'mandate://specs/login-sso@deadbeef' })).rejects.toThrow(/unknown commit/);
  });
});

describe('search parity: MCP equals the service functions', () => {
  const strip = (v: unknown) => JSON.parse(JSON.stringify(v));
  const cases: [tool: string, method: string, args: Record<string, unknown>][] = [
    ['search', 'search', { q: 'refresh token rotation' }],
    ['search', 'search', { q: 'session', mode: 'text', kinds: ['section'], limit: 5 }],
    ['search', 'search', { q: 'how do users stay logged in', mode: 'semantic' }],
    ['search', 'search', { q: 'token', within: 'mandate://specs/login-sso' }],
    ['text_search', 'textSearch', { q: 'PKCE', caseSensitive: true }],
    ['text_search', 'textSearch', { q: 'token(s)?', regex: true, limit: 10 }],
    ['symbol_search', 'symbolSearch', { name: 'Auth', match: 'prefix' }],
    ['code_search', 'codeSearch', { repo: 'app', glob: 'src/**/*.ts' }],
    ['related', 'related', { uri: 'mandate://specs/user-sessions/sections/overview' }],
    ['metadata_query', 'metadataQuery', { kinds: ['spec'], status: ['draft', 'ready'] }],
    ['history_search', 'historySearch', { q: 'close', limit: 10 }],
    ['graph_search', 'graphSearch', { q: 'stripe' }],
  ];
  for (const [tool, method, args] of cases) {
    it(`${tool} ${JSON.stringify(args)}`, async () => {
      const r = await fx.call(tool, args);
      expect(r.isError, JSON.stringify(r.body)).toBe(false);
      const direct = await (fx.index as unknown as Record<string, (a: unknown) => Promise<unknown>>)[method]!.call(fx.index, args);
      expect(r.body).toEqual(strip(direct));
    });
  }
});

import { afterEach, describe, expect, it } from 'vitest';
import { agentGuides, agentSnippets, connectCommand, genericSnippet, keyEnvVar, maskKey, mcpUrlFor, serverName } from '../src/connect/snippets';
import { appPathname, legacyTarget, parseProjectPath, projectBase, setCurrentProject, withBase } from '../src/project';

const KEY = 'mnd_demo_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_xyz9';
const URL_ = 'http://localhost:4000/p/demo/mcp';

describe('project paths', () => {
  afterEach(() => setCurrentProject(null));

  it('parses /p/<id>/...', () => {
    expect(parseProjectPath('/p/demo/specs/x')).toEqual({ id: 'demo', rest: '/specs/x' });
    expect(parseProjectPath('/p/demo')).toEqual({ id: 'demo', rest: '/' });
    expect(parseProjectPath('/p/demo/')).toEqual({ id: 'demo', rest: '/' });
    expect(parseProjectPath('/specs/x')).toBeNull();
    expect(parseProjectPath('/')).toBeNull();
    expect(projectBase('a b')).toBe('/p/a%20b');
  });

  it('maps legacy URLs into a project, keeping search and hash', () => {
    expect(legacyTarget('default', '/specs/login-sso', '?version=abc', '#section-goals')).toBe('/p/default/specs/login-sso?version=abc#section-goals');
    expect(legacyTarget('default', '/work-orders/wo-1')).toBe('/p/default/work-orders/wo-1');
    expect(legacyTarget('default', '/queue/wo-1')).toBe('/p/default/queue/wo-1');
    expect(legacyTarget('demo', '/')).toBe('/p/demo');
  });

  it('prefixes app paths with the current project', () => {
    expect(withBase('/specs/x')).toBe('/specs/x');
    setCurrentProject('demo');
    expect(withBase('/specs/x#section-a')).toBe('/p/demo/specs/x#section-a');
    expect(withBase('/p/other/specs')).toBe('/p/other/specs');
    expect(withBase('https://example.com/x')).toBe('https://example.com/x');
    expect(withBase('#section-a')).toBe('#section-a');
    expect(withBase('//evil.example/x')).toBe('//evil.example/x');
    expect(appPathname('/p/demo/feedback/fb-1')).toBe('/feedback/fb-1');
    expect(appPathname('/specs')).toBe('/specs');
  });
});

describe('connect-agent snippets', () => {
  const input = { project: 'demo', url: URL_, key: KEY };

  it('masks keys, keeping the project prefix and last 4', () => {
    const m = maskKey(KEY);
    expect(m.startsWith('mnd_demo_')).toBe(true);
    expect(m.endsWith('xyz9')).toBe(true);
    expect(m).not.toContain('AbCdEf');
    expect(maskKey('mnd_demo_ab')).toBe('mnd_demo_••');
  });

  it('generic JSON: url + Authorization header', () => {
    const g = JSON.parse(genericSnippet(input).code);
    expect(g).toEqual({ mcpServers: { 'mandate-demo': { type: 'http', url: URL_, headers: { Authorization: `Bearer ${KEY}` } } } });
  });

  it('per-agent formats', () => {
    const by = Object.fromEntries(agentSnippets(input).map((s) => [s.id, s]));
    expect(Object.keys(by)).toEqual(['claude-code', 'codex', 'cursor', 'vscode', 'gemini', 'windsurf', 'opencode']);
    expect(by['claude-code']!.code).toBe(`claude mcp add --transport http mandate-demo ${URL_} \\\n  --header "Authorization: Bearer ${KEY}"`);
    expect(JSON.parse(by.cursor!.code).mcpServers['mandate-demo']).toEqual({ url: URL_, headers: { Authorization: `Bearer ${KEY}` } });
    expect(JSON.parse(by.vscode!.code).servers['mandate-demo'].type).toBe('http');
    expect(by.codex!.code).toBe(`[mcp_servers.mandate-demo]\nurl = "${URL_}"\nhttp_headers = { "Authorization" = "Bearer ${KEY}" }`);
    expect(JSON.parse(by.gemini!.code).mcpServers['mandate-demo'].httpUrl).toBe(URL_);
    expect(JSON.parse(by.windsurf!.code).mcpServers['mandate-demo'].serverUrl).toBe(URL_);
    expect(JSON.parse(by.opencode!.code).mcp['mandate-demo']).toMatchObject({ type: 'remote', url: URL_ });
    // Display copies never leak the real key when given the masked one.
    for (const s of agentSnippets({ ...input, key: maskKey(KEY) })) expect(s.code).not.toContain(KEY);
    expect(serverName('x')).toBe('mandate-x');
  });

  it('MCP URL points agents at the API server, not the Vite dev port', () => {
    expect(mcpUrlFor({ protocol: 'http:', hostname: 'localhost', origin: 'http://localhost:5173' }, '/p/demo/mcp', '4000')).toBe('http://localhost:4000/p/demo/mcp');
    expect(mcpUrlFor({ protocol: 'http:', hostname: '127.0.0.1', origin: 'http://127.0.0.1:4000' }, '/p/demo/mcp')).toBe('http://127.0.0.1:4000/p/demo/mcp');
  });

  it('agent guides: Claude Code and Codex first, key from an env var', () => {
    const g = agentGuides(input);
    expect(g.map((x) => x.id).slice(0, 2)).toEqual(['claude-code', 'codex']);
    expect(keyEnvVar('team-a')).toBe('MANDATE_KEY_TEAM_A');
    expect(g[0]!.env).toBe(`export MANDATE_KEY_DEMO=${KEY}`);
    expect(g[0]!.register.code).toContain('--header "Authorization: Bearer $MANDATE_KEY_DEMO"');
    expect(g[0]!.register.code).not.toContain(KEY);
    expect(g[1]!.register.code).toBe(`[mcp_servers.mandate-demo]\nurl = "${URL_}"\nbearer_token_env_var = "MANDATE_KEY_DEMO"`);
    expect(g[1]!.verify).toContain('codex mcp list');
    expect(connectCommand('demo')).toBe('mandate connect --project demo');
  });
});

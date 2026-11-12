import { describe, expect, it } from 'vitest';
import { oauthGuides, tokenEnvVar, agentGuides } from '../src/connect/snippets';
import { accessLabel } from '../src/connect/projects';
import { actorLabel } from '../src/components/activity/ActivityPanel';

const URL_ = 'https://mandate.example.com/p/demo/mcp';

describe('server-mode access', () => {
  it('labels project access', () => {
    expect(accessLabel('read')).toBe('Read only');
    expect(accessLabel('write')).toBe('Can write');
    expect(accessLabel(undefined)).toBeNull();
  });
  it('shows "<user> via <agent>" for server-mode activity, only "via <agent>" in local mode', () => {
    expect(actorLabel({ user: 'octo', agent: 'claude-code' }, true)).toBe('octo via claude-code');
    expect(actorLabel({ agent: 'claude-code' }, true)).toBe('via claude-code');
    expect(actorLabel({ user: 'octo' }, true)).toBe('octo');
    expect(actorLabel({ user: 'octo', agent: 'octo' }, true)).toBe('octo');
    // Local mode (the default): never a user.
    expect(actorLabel({ user: 'octo', agent: 'claude-code' })).toBe('via claude-code');
    expect(actorLabel({ user: 'octo' })).toBe('');
  });
  it('OAuth guides need no header or key', () => {
    const g = oauthGuides('demo', URL_);
    expect(g.map((x) => x.id)).toEqual(['claude-code', 'codex', 'cursor', 'vscode']);
    expect(g[0]!.steps[0]!.code).toBe(`claude mcp add --transport http mandate-demo ${URL_}`);
    expect(g[1]!.steps.map((s) => s.code)).toEqual([`codex mcp add mandate-demo --url ${URL_}`, 'codex mcp login mandate-demo']);
    for (const x of g) for (const s of x.steps) expect(s.code).not.toMatch(/Authorization|Bearer/);
  });
  it('personal-token guides use their own env var', () => {
    expect(tokenEnvVar('team-a')).toBe('MANDATE_KEY_TEAM_A');
    const g = agentGuides({ project: 'demo', url: URL_, key: 'mnd_tok', envVar: tokenEnvVar('demo') });
    expect(g[0]!.env).toBe('export MANDATE_KEY_DEMO=mnd_tok');
    expect(g[1]!.register.code).toContain('bearer_token_env_var = "MANDATE_KEY_DEMO"');
  });
});

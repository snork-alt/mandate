/**
 * Demo data for attribution / contributors screenshots (server mode), written into a DATA REPO COPY you pass in —
 * never the live data repo: `npx tsx scripts/attribution-demo-seed.ts <data-dir-clone> [home-dir]`.
 * Writes, as different GitHub users (`Mandate-User` trailers via the normal MCP write path):
 *   alice files feedback on the Security baseline session-cookie rule; bob accepts it; carol's coding agent edits the
 *   rule (cause: the feedback); dave creates a work order on login-sso (cause: the feedback), claims it on a branch
 *   with an open PR; bob comments on it; erin records a verification.
 * With [home-dir], alice / bob / carol are recorded in that home's user directory (users.json).
 */
import path from 'node:path';
import { EsGitStore } from '../src/git/EsGitStore.js';
import { createStorage } from '../src/storage/index.js';
import { DocReadService } from '../src/storage/read.js';
import { DocViewService } from '../src/storage/views.js';
import { callTool, type ToolContext } from '../src/mcp/define.js';
import { TOOLS } from '../src/mcp/server.js';
import { memorySettings } from '../src/projects/settings.js';
import { setUserDirectory, UserDirectory } from '../src/auth/users.js';
import type { Principal } from '../src/auth/http.js';

async function main() {
  const [dir, home] = process.argv.slice(2);
  if (!dir) throw new Error('usage: tsx scripts/attribution-demo-seed.ts <data-dir-clone> [home-dir]');
  if (path.resolve(dir) === path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../../data/repo')) throw new Error('refusing to write the live data repo; pass a clone');
  if (home) {
    const d = new UserDirectory(path.join(home, 'users.json'));
    for (const [login, name] of [['alice', 'Alice Martin'], ['bob', 'Bob Chen'], ['carol', 'Carol Diaz'], ['dave', 'Dave Okafor'], ['erin', 'Erin Novak']] as const) d.record({ login, name, avatarUrl: `https://avatars.githubusercontent.com/${login}?s=80` });
    setUserDirectory(d);
  }
  const git = new EsGitStore({ dir, author: { name: 'Mandate', email: 'mandate@example.com' } });
  await git.open();
  const storage = createStorage(git);
  const as = (login: string, agent: string): ToolContext =>
    ({ storage, index: null, reads: new DocReadService(storage), views: new DocViewService(storage), settings: memorySettings(), clientName: agent, principal: { kind: 'user', login, project: 'default', via: 'oauth', tokenId: 'demo', tokenName: agent } as Principal }) as ToolContext;
  const call = async (ctx: ToolContext, name: string, args: Record<string, unknown>) => {
    const r = await callTool(TOOLS.find((t) => t.name === name)!, args, ctx);
    const body = r.structuredContent as Record<string, any>;
    if (r.isError) throw new Error(`${name}: ${JSON.stringify(body.error)}`);
    return body;
  };
  const rule = 'mandate://standards/security-baseline/sections/sec-session-cookies';
  const fb = (await call(as('alice', 'claude-code'), 'feedback_create', { targets: [rule], kind: 'improvement', body: 'Session cookies should also use the __Host- prefix so subdomains cannot overwrite them.' })).ref;
  await call(as('bob', 'codex'), 'feedback_accept', { ref: fb });
  // Standard writes need the user's confirmation: carol's agent asks, bob answers in the web UI (a UI decision needs
  // repo write access), and the change cites the answered question as its cause.
  const ui = (login: string, name: string): ToolContext =>
    ({ storage, index: null, reads: new DocReadService(storage), views: new DocViewService(storage), settings: memorySettings(), clientName: 'web-ui', uiAccess: 'write', principal: { kind: 'ui', user: { login, name, avatarUrl: `https://avatars.githubusercontent.com/${login}?s=80` } } as Principal }) as ToolContext;
  const q = await call(as('carol', 'claude-code'), 'question_ask', { purpose: 'standard_confirmation', context: [rule], questions: [{ header: 'Cookies', question: 'Add the __Host- prefix requirement to the session-cookie rule of Security baseline?', options: [{ label: 'Yes, add it', description: 'Secure, Path=/, no Domain' }, { label: 'Not now', description: 'Keep the rule as is' }], recommended: 'Yes, add it' }] });
  await call(ui('bob', 'Bob Chen'), 'question_answer', { id: q.question.id, answers: { q1: 'Yes, add it' } });
  const std = await storage.standards.get('security-baseline');
  const sec = std.sections.find((s) => s.id === 'sec-session-cookies')!;
  await call(as('carol', 'claude-code'), 'standard_section_update', { ref: rule, body: `${sec.body ?? ''}\n\nSession cookies use the \`__Host-\` prefix (Secure, Path=/, no Domain), so subdomains cannot set or overwrite them.`, cause: [fb, q.ref] });
  const wo = (await call(as('dave', 'cursor'), 'work_order_create', { spec: 'login-sso', kind: 'update', sections: [(await storage.specs.get('login-sso')).sections[0]!.id], plan: '1. Rename the session cookie to __Host-session.\n2. Update the tests.', cause: fb })).ref;
  await call(as('dave', 'cursor'), 'work_order_claim', { ref: wo, git: [{ repo: 'app', branch: 'wo/host-cookie', baseBranch: 'main', pr: { number: 412, status: 'open', url: 'https://github.com/acme/app/pull/412' } }] });
  await call(as('bob', 'codex'), 'comment_add', { target: wo, body: 'Remember the logout path clears the old cookie name too.' });
  console.log(`seeded: feedback ${fb}, rule ${rule}, work order ${wo}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

/**
 * `npm run mandate -- key create <project> [--name <name>] [--service <name>]` | `key list` | `key revoke <key-id>`
 *   (`--service <name>`: a named service account for CI, the only kind of project key a team accepts; its writes
 *   are attributed to `service:<name>`)
 * `npm run mandate -- doctor [project]`: who wrote recently (user / agent / credential), unattributed and service writes.
 * `npm run mandate -- session create <github-login> [--ttl-minutes 60]`: a web UI session for headless checks (prints the
 * cookie once). Same power as signing in: it needs read access to ~/.mandate (the session secret) and the login must
 * be in auth.github.allowedUsers. The session is read-only like any UI session; `session revoke <cookie>` ends it.
 * `--out <file>` writes a Playwright `addCookies` list (0600) instead of printing the cookie; `session revoke --file <file>`.
 * Agent keys live in ~/.mandate/keys.json (0600). Projects are created in the web UI (New project), not here.
 * A new key is printed once to stdout (copy it into your coding agent's MCP config); listings are masked.
 */
import { loadSecrets } from '../src/secrets.js';
import { loadConfig } from '../src/config.js';
import { KeyStore, maskKey } from '../src/auth/keys.js';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { recentWriters } from '../src/storage/writers.js';
import { projectIntegrity } from '../src/storage/doctor.js';
import path from 'node:path';
import { AuthStore, loadServerSecret, writeSecretJson } from '../src/auth/sessions.js';
import { SESSION_COOKIE } from '../src/auth/http.js';
import { preconfigured, SetupState } from '../src/setup/files.js';
import { openConfiguredState, type ServerState } from '../src/db/state.js';
import { DEFAULT_DATABASE_CONFIG, openServerDb, redactUrl, resolveDatabase, SqliteDb } from '../src/db/index.js';
import { copyServerState } from '../src/db/copy.js';

export async function main(argv: string[], env: NodeJS.ProcessEnv = process.env, out = (s: string) => console.log(s)): Promise<number> {
  // Sessions and login tokens live in the configured server-state database (opened on demand, closed on exit).
  let state: ServerState | undefined;
  const stateOf = async (config: ReturnType<typeof loadConfig>) => (state ??= await openConfiguredState(config.database, config.home));
  try {
    return await run(argv, env, out, stateOf);
  } finally {
    await state?.close();
  }
}

async function run(argv: string[], env: NodeJS.ProcessEnv, out: (s: string) => void, stateOf: (config: ReturnType<typeof loadConfig>) => Promise<ServerState>): Promise<number> {
  const [group, cmd, ...rest] = argv;
  const flag = (n: string) => {
    const i = rest.indexOf(`--${n}`);
    return i >= 0 ? rest[i + 1] : undefined;
  };
  const positional = rest.filter((a, i) => !a.startsWith('--') && !(i > 0 && rest[i - 1]!.startsWith('--')));
  const usage = 'usage: npm run mandate -- setup-url | open | key create <project> [--name <name>] [--service <name>] | key list | doctor [project] | key revoke <key-id> | session create <github-login> [--ttl-minutes N] [--out <cookie.json>] | session revoke <cookie> | session revoke --file <cookie.json>';
  if (group === 'setup-url' || group === 'open') {
    loadSecrets(env);
    const config = loadConfig(env);
    // The UI URL: server.publicUrl, or MANDATE_UI_URL (development: http://localhost:5173, the Vite proxy).
    const ui = (env.MANDATE_UI_URL || config.publicUrl).replace(/\/+$/, '');
    if (group === 'setup-url') {
      const setup = new SetupState(config.home, () => preconfigured(config));
      const token = setup.token();
      if (!token) {
        out('Setup is already complete; change settings in the web UI (Settings).');
        return 0;
      }
      out(`${ui}/auth/setup?token=${token}`);
      out('# one-time setup link: on this machine, or over HTTPS / an SSH tunnel (ssh -L 4000:localhost:4000 <server>)');
      return 0;
    }
    // Sign-in is always GitHub: `open` prints the UI address.
    out(ui);
    return 0;
  }
  if (group === 'doctor') {
    loadSecrets(env);
    const config = loadConfig(env);
    const id = cmd ?? config.defaultProject;
    const p = config.projects.find((x) => x.id === id);
    if (!p) {
      out(`unknown project '${id}' (projects: ${config.projects.map((x) => x.id).join(', ')})`);
      return 1;
    }
    const log = async (limit: number) => {
      const raw = execFileSync('git', ['-C', p.dataDir, 'log', `-n${limit}`, '--format=%H%x1f%an <%ae>%x1f%aI%x1f%B%x1e', '--', '.'], { encoding: 'utf8', maxBuffer: 64 << 20 });
      return raw
        .split('\x1e')
        .map((r) => r.trim())
        .filter(Boolean)
        .map((r) => {
          const [id, author, date, message] = r.split('\x1f');
          return { id: id!, author: author!, date: date!, message: message ?? '' };
        });
    };
    const w = await recentWriters({ log } as never, 500);
    out(`GitHub sign-in${config.legacyAuth ? ' (OAuth App, sign-in allow-list)' : ''}; project ${id}; last ${w.scanned} commits`);
    // Agent configs on this machine that still send a project key (refused: per-user access).
    for (const f of sharedKeyConfigs(env)) out(`warning: ${f.file} uses a shared project key (${f.masked}); this server refuses it. Re-run \`mandate connect\` (MCP sign-in, or a personal token from the Connect dialog); CI: mandate key create <project> --service <name>`);
    out(`unattributed (no user): ${w.unattributed}; service accounts: ${w.service}`);
    for (const r of w.writers.slice(0, 30)) out(`${(r.user ?? '(no user)').padEnd(24)} via ${(r.agent ?? '?').padEnd(28)} ${(r.source ?? '').padEnd(22)} ${String(r.commits).padStart(5)} commits  last ${r.last}`);
    const report = await projectIntegrity({ dataDir: p.dataDir, branch: p.branch, git: p.git, github: p.github }).catch((e: Error) => (out(`integrity: cannot lint (${e.message})`), null));
    if (report) {
      const warnings = report.issues.filter((i) => i.severity === 'warning').length;
      out(`integrity: ${report.issues.length} issue(s), ${warnings} of them warnings`);
      for (const i of report.issues) out(`  ${i.severity ?? 'issue'} ${i.rule} ${i.uri}: ${i.message}${i.hint ? `\n    fix: ${i.hint}` : ''}`);
    }
    return 0;
  }
  if (group === 'db') {
    if (cmd !== 'copy') {
      out('usage: npm run mandate -- db copy [--from <state.sqlite>] [--replace]   (SQLite server state -> the configured Postgres)');
      return 2;
    }
    loadSecrets(env);
    const config = loadConfig(env);
    if (config.database.driver !== 'postgres') {
      out('db copy: set database.driver to "postgres" (and its URL in secrets.env) first; the SQLite state is the source');
      return 1;
    }
    const def = resolveDatabase(DEFAULT_DATABASE_CONFIG, env, config.home);
    const fromFile = path.resolve(flag('from') ?? (def.driver === 'sqlite' ? def.path : path.join(config.home, 'state.sqlite')));
    const src = SqliteDb.open(fromFile);
    let dst: Awaited<ReturnType<typeof openServerDb>> | undefined;
    try {
      dst = await openServerDb(config.database);
      const r = await copyServerState(src, dst, { replace: rest.includes('--replace') });
      for (const [t, n] of Object.entries(r)) out(`${t}: ${n.written} of ${n.read} row(s) copied`);
      out(`server state copied from ${fromFile} to ${redactUrl(config.database.url)} (schema mandate_server); the search index is rebuilt from git by the server`);
      return 0;
    } catch (e) {
      out(`db copy failed: ${(e as Error).message}`);
      return 1;
    } finally {
      await src.close();
      await dst?.close();
    }
  }
  if ((group !== 'key' && group !== 'session') || !cmd) {
    out(usage);
    return group === 'help' || group === '--help' ? 0 : 2;
  }
  loadSecrets(env);
  const config = loadConfig(env);
  if (group === 'session') {
    const store = new AuthStore(config.home, loadServerSecret(config.home, env), 3600_000, Date.now, await stateOf(config));
    if (cmd === 'revoke') {
      const file = flag('file');
      let v = positional[0]?.replace(new RegExp(`^${SESSION_COOKIE}=`), '');
      if (file) {
        try {
          v = (JSON.parse(readFileSync(file, 'utf8')) as { name: string; value: string }[]).find((c) => c.name === SESSION_COOKIE)?.value;
        } catch {
          v = undefined;
        }
      }
      if (!v) {
        out('usage: session revoke <cookie> | session revoke --file <cookie.json>');
        return 2;
      }
      await store.deleteSession(v);
      out('session revoked');
      return 0;
    }
    if (cmd !== 'create') {
      out(usage);
      return 2;
    }
    const login = positional[0];
    const allowed = config.auth.github?.allowedUsers ?? [];
    if (!login || !allowed.some((u) => u.toLowerCase() === login.toLowerCase())) {
      out(`'${login ?? ''}' is not in auth.github.allowedUsers (${allowed.join(', ') || 'empty'}); sessions are only minted for allowed users`);
      return 1;
    }
    const minutes = Number(flag('ttl-minutes') ?? 60);
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 24 * 60) {
      out('--ttl-minutes: 1..1440');
      return 2;
    }
    const outFile = flag('out');
    const cookie = await store.createSession({ login, avatarUrl: `https://github.com/${login}.png` }, minutes * 60_000);
    const stored = config.database.driver === 'sqlite' ? config.database.path : 'the Postgres server state (mandate_server.sessions)';
    if (outFile) {
      // Playwright-ready cookie list, written 0600; the value is never printed.
      const expires = Math.floor(Date.now() / 1000) + minutes * 60;
      writeSecretJson(path.resolve(outFile), [{ name: SESSION_COOKIE, value: cookie, domain: 'localhost', path: '/', httpOnly: true, sameSite: 'Lax', expires }]);
      out(`# read-only UI session for ${login}, expires in ${minutes} min, stored in ${stored}.`);
      out(`# Wrote ${path.resolve(outFile)} (0600). Playwright: await context.addCookies(JSON.parse(fs.readFileSync(file, 'utf8'))). Revoke: npm run mandate -- session revoke --file ${outFile}`);
      return 0;
    }
    out(`${SESSION_COOKIE}=${cookie}`);
    out(`# read-only UI session for ${login}, expires in ${minutes} min, stored in ${stored} (as sha256 of the part before the last '.').`);
    out(`# The line above is a Cookie header pair: the cookie VALUE is everything after '${SESSION_COOKIE}=' (not including the name). Playwright: context.addCookies([{ name: '${SESSION_COOKIE}', value, domain: 'localhost', path: '/', httpOnly: true, sameSite: 'Lax' }]). Easier: --out <cookie.json>. Revoke: npm run mandate -- session revoke <cookie>`);
    return 0;
  }
  const keys = new KeyStore(config.keysPath);
  switch (cmd) {
    case 'create': {
      const project = positional[0];
      if (!project || !config.projects.some((p) => p.id === project)) {
        out(`unknown project '${project ?? ''}' (projects: ${config.projects.map((p) => p.id).join(', ')})`);
        return 1;
      }
      const service = flag('service');
      const k = keys.create(project, service ?? flag('name') ?? `key-${new Date().toISOString().slice(0, 10)}`, { service: !!service });
      out(`created ${service ? 'service account ' : ''}${k.id} "${k.name}" for ${project}${service ? ` (writes attributed to service:${k.name})` : ''}:\n${k.key}\nSend it as: Authorization: Bearer <key>  (MCP endpoint /p/${project}/mcp). Stored in ${keys.file}.`);
      return 0;
    }
    case 'list': {
      const all = keys.list();
      const problem = keys.status();
      if (problem) out(`warning: ${problem}`);
      if (!all.length) out('no keys');
      for (const k of all) out(`${k.id}  ${k.project.padEnd(20)} ${k.name.padEnd(24)} ${maskKey(k.key)}${k.service ? '  [service]' : ''}  created ${k.createdAt}${k.lastUsedAt ? `  last used ${k.lastUsedAt}` : ''}`);
      return 0;
    }
    case 'revoke': {
      const id = positional[0];
      if (!id) {
        out('usage: key revoke <key-id>');
        return 2;
      }
      if (!keys.revoke(id)) {
        out(`no key '${id}'`);
        return 1;
      }
      out(`revoked ${id} (effective immediately)`);
      return 0;
    }
    default:
      out(`unknown command 'key ${cmd}'`);
      return 2;
  }
}

if (process.argv[1] && /mandate\.ts$/.test(process.argv[1])) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e: Error) => {
      console.error(`mandate: ${e.message}`);
      process.exit(1);
    },
  );
}

/** MCP config files of coding agents on this machine that contain a shared project key (masked; never printed). */
export function sharedKeyConfigs(env: NodeJS.ProcessEnv = process.env): { file: string; masked: string }[] {
  const home = env.HOME ?? '';
  const files = [
    path.join(home, '.claude.json'),
    path.join(home, '.cursor', 'mcp.json'),
    path.join(home, '.codex', 'config.toml'),
    path.join(home, '.gemini', 'settings.json'),
    path.join(home, '.config', 'opencode', 'opencode.json'),
    path.join(home, 'Library', 'Application Support', 'Code', 'User', 'mcp.json'),
    path.join(home, '.config', 'Code', 'User', 'mcp.json'),
    path.join(process.cwd(), '.mcp.json'),
  ];
  const out: { file: string; masked: string }[] = [];
  for (const file of files) {
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const m = /mnd_[a-z0-9-]+_[A-Za-z0-9_-]{43,}/.exec(text);
    if (m) out.push({ file, masked: maskKey(m[0]) });
  }
  return out;
}

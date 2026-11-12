/**
 * `npm run mandate -- key create <project> [--name <name>]` | `key list` | `key revoke <key-id>`
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
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { AuthStore, loadServerSecret, writeSecretJson } from '../src/auth/sessions.js';
import { SESSION_COOKIE } from '../src/auth/http.js';

export async function main(argv: string[], env: NodeJS.ProcessEnv = process.env, out = (s: string) => console.log(s)): Promise<number> {
  const [group, cmd, ...rest] = argv;
  const flag = (n: string) => {
    const i = rest.indexOf(`--${n}`);
    return i >= 0 ? rest[i + 1] : undefined;
  };
  const positional = rest.filter((a, i) => !a.startsWith('--') && !(i > 0 && rest[i - 1]!.startsWith('--')));
  const usage = 'usage: npm run mandate -- key create <project> [--name <name>] | key list | key revoke <key-id> | session create <github-login> [--ttl-minutes N] [--out <cookie.json>] | session revoke <cookie> | session revoke --file <cookie.json>';
  if ((group !== 'key' && group !== 'session') || !cmd) {
    out(usage);
    return group === 'help' || group === '--help' ? 0 : 2;
  }
  loadSecrets(env);
  const config = loadConfig(env);
  if (group === 'session') {
    const store = new AuthStore(config.home, loadServerSecret(config.home, env), 3600_000);
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
      store.deleteSession(v);
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
    const cookie = store.createSession({ login, avatarUrl: `https://github.com/${login}.png` }, minutes * 60_000);
    const stored = path.join(config.home, 'sessions.json');
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
      const k = keys.create(project, flag('name') ?? `key-${new Date().toISOString().slice(0, 10)}`);
      out(`created ${k.id} "${k.name}" for ${project}:\n${k.key}\nSend it as: Authorization: Bearer <key>  (MCP endpoint /p/${project}/mcp). Stored in ${keys.file}.`);
      return 0;
    }
    case 'list': {
      const all = keys.list();
      const problem = keys.status();
      if (problem) out(`warning: ${problem}`);
      if (!all.length) out('no keys');
      for (const k of all) out(`${k.id}  ${k.project.padEnd(20)} ${k.name.padEnd(24)} ${maskKey(k.key)}  created ${k.createdAt}${k.lastUsedAt ? `  last used ${k.lastUsedAt}` : ''}`);
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

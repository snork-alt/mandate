import { loadSecrets } from './secrets.js';
import { loadConfig } from './config.js';
import { buildApp } from './app.js';
import { registerMcp } from './mcp/index.js';
import { KeyStore } from './auth/keys.js';
import { AuthStore, loadServerSecret } from './auth/sessions.js';
import { AuthConfigSource, GITHUB, GithubClient, registerAuthRoutes } from './auth/github.js';
import { LOOPBACK_HOSTS, hostName } from './auth/http.js';
import { ProjectRegistry, projectOpener } from './projects/registry.js';
import { githubRemote, registerAdminRoutes, TokenChecker } from './projects/admin.js';

// Secrets (~/.mandate/secrets.env) fill unset env vars before the config is resolved.
const secrets = loadSecrets();
const config = loadConfig();
const app = buildApp({
  logger: true,
  health: async () => {
    const def = config.projects.find((p) => p.id === config.defaultProject)!;
    return { ok: true, version: '0.1.0', dataDir: def.dataDir, remote: def.remote?.url.replace(/\/\/[^/@]*@/, '//***@') ?? null };
  },
});
for (const w of config.warnings) app.log.warn(w);
if (secrets.problem) app.log.warn(`secrets file ${secrets.file}: ${secrets.problem}`);

// Sign-in: agent keys (keys.json, one per project, generated on startup) + GitHub sessions for the web UI.
const keys = new KeyStore(config.keysPath, { log: app.log });
const created = keys.ensureProjectKeys(config.projects.map((p) => p.id));
if (created.length) app.log.info(`agent keys created for ${created.join(', ')} in ${config.keysPath}`);
const store = new AuthStore(config.home, loadServerSecret(config.home), config.auth.sessionTtlHours * 3600_000);
const source = new AuthConfigSource(config.configPath, config.auth, process.env, app.log);
// GitHub Enterprise / test doubles: MANDATE_GITHUB_URL (OAuth) and MANDATE_GITHUB_API_URL (REST).
const github = new GithubClient({ ...GITHUB, web: process.env.MANDATE_GITHUB_URL || GITHUB.web, api: process.env.MANDATE_GITHUB_API_URL || GITHUB.api });
const cloneBase = process.env.MANDATE_GITHUB_CLONE_BASE || (process.env.MANDATE_GITHUB_URL ? null : 'https://github.com');
const auth = { keys, store, uiOrigins: config.uiOrigins };
if (!source.current().configured) app.log.warn(`GitHub sign-in is not configured (${source.current().missing.join('; ')}); the web UI shows the setup page, agent keys work`);

const projects = new ProjectRegistry(config.projects, projectOpener(config, { log: app.log, githubRemote: githubRemote(store, (repo) => `${cloneBase ?? process.env.MANDATE_GITHUB_URL}/${repo}.git`),
    // GitHub projects push with the connectedBy user's token; a revoked token pauses pushing ("Reconnect GitHub").
    pushGate: (p) => (p.github && store.tokenStatus(p.github.connectedBy) === 'reconnect' ? { state: 'reconnect', message: `Reconnect GitHub: sign in again as ${p.github.connectedBy}; commits stay local meanwhile` } : null),
    onPushAuthError: (p) => {
      if (p.github) store.markRevoked(p.github.connectedBy);
    },
  }), config.defaultProject);
const tokens = new TokenChecker(store, github);
projects.tokenStatus = (login) => store.tokenStatus(login);
projects.refreshTokens = (logins) => tokens.check(logins);

// MCP (Streamable HTTP) per project at /p/<id>/mcp (+ /mcp: project_list); activity → notifications/mandate/activity.
export const mcpHub = registerMcp(app, { projects, auth, allowedHosts: [config.host] });
registerAuthRoutes(app, { auth, source, github, log: app.log });
const allowed = new Set([...LOOPBACK_HOSTS, config.host]);
registerAdminRoutes(app, {
  auth,
  source,
  hostOk: (req) => allowed.has(hostName(req.headers.host ?? '')),
  registry: projects,
  keys,
  store,
  github,
  home: config.home,
  configPath: config.configPath,
  resolveProject: (id) => {
    const p = loadConfig().projects.find((x) => x.id === id);
    if (!p) throw new Error(`project '${id}' not found in ${config.configPath}`);
    return p;
  },
  log: app.log,
});

const shutdown = async () => {
  await app.close();
  await projects.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await app.listen({ port: config.port, host: config.host });
app.log.info(`projects: ${config.projects.map((p) => `${p.id} (${p.dataDir})`).join(', ')}; config: ${config.configPath}`);
// The default project opens eagerly (index sync starts now); the others on first use.
projects.open(config.defaultProject).catch((e: Error) => app.log.error(e.message));

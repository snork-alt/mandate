import { loadSecrets, refreshSecrets } from './secrets.js';
import path from 'node:path';
import { setUserDirectory, UserDirectory } from './auth/users.js';
import { loadConfig, mandateHome } from './config.js';
import { buildApp } from './app.js';
import { registerMcp } from './mcp/index.js';
import { UploadService } from './mcp/uploads.js';
import { KeyStore } from './auth/keys.js';
import { AuthStore, loadServerSecret } from './auth/sessions.js';
import { AuthConfigSource, GITHUB, GithubClient, registerAuthRoutes } from './auth/github.js';
import { RepoPermissions } from './auth/github-perms.js';
import { AgentTokens } from './auth/agent-tokens.js';
import { OAuthStore, registerMcpOAuth } from './auth/mcp-oauth.js';
import { LOOPBACK_HOSTS, agentAuthPolicy, hostName } from './auth/http.js';
import { ProjectRegistry, projectOpener } from './projects/registry.js';
import { ProjectsStore, reloadProjects, watchProjectsFile } from './projects/store.js';
import { ConfigFile, preconfigured, SetupState } from './setup/files.js';
import { FolderBrowser } from './setup/fs.js';
import { adminClaimHook, registerSetupRoutes, setupStatus } from './setup/routes.js';
import { registerInstallRoutes } from './install/routes.js';
import { buildFromSource, CliTarball, findCliPackage, findSourceCliPackage } from './install/cli-package.js';
import { githubRemote, registerAdminRoutes, TokenChecker } from './projects/admin.js';
import { registerStaticUi, resolveWebDir } from './static.js';
import { DbClientStore, migrateFlowPolicies, projectSettings } from './projects/settings.js';
import { registerFlowRoutes } from './projects/flow-routes.js';
import { registerCodeRepoRoutes } from './projects/code-repos-routes.js';
import { openConfiguredState, switchServerDatabase } from './db/state.js';
import { redactUrl, type ResolvedDatabase } from './db/config.js';
import { openServerDb } from './db/index.js';
import { unwrapDb } from './db/swappable.js';
import { processRestarter } from './restart.js';
import { dropIndexSchema } from './db/pg-index/mirror.js';
import type { PostgresDb } from './db/postgres.js';

// Secrets (~/.mandate/secrets.env) fill unset env vars before the config is resolved.
const secrets = loadSecrets();
const config = loadConfig();
const startedAt = Date.now();
const app = buildApp({
  logger: true,
  health: async () => {
    const def = config.projects.find((p) => p.id === config.defaultProject)!;
    // startedAt: the UI waits for the restarted server (a new public URL / bind address) by polling this.
    return { ok: true, version: process.env.MANDATE_VERSION ?? '0.1.0', dataDir: def.dataDir, remote: def.remote?.url.replace(/\/\/[^/@]*@/, '//***@') ?? null, startedAt };
  },
});
for (const w of config.warnings) app.log.warn(w);
// Server state (sessions, tokens, OAuth, idempotency): SQLite ~/.mandate/state.sqlite (default) or Postgres.
const serverState = await openConfiguredState(config.database, config.home);
// The database in use (Settings → Database switches it live: applyDatabase).
let activeDb: ResolvedDatabase = config.database;
const pgIndexOf = (r: ResolvedDatabase) => (r.driver === 'postgres' && r.publishIndex ? { schemaPerProject: r.schemaPerProject } : undefined);
serverState.startPruning();
app.log.info(`server state: ${config.database.driver === 'sqlite' ? config.database.path : `postgres ${redactUrl(config.database.url)} (schema mandate_server${config.database.pooler === 'transaction' ? '; transaction pooler: prepared statements off' : ''})`}`);
if (secrets.problem) app.log.warn(`secrets file ${secrets.file}: ${secrets.problem}`);

// Sign-in: agent keys (keys.json, one per project, generated on startup) + GitHub sessions for the web UI.
const keys = new KeyStore(config.keysPath, { log: app.log });
// Mandate always signs in with GitHub. Agents authenticate per GitHub user (MCP OAuth or personal tokens); project
// keys are refused except named service accounts (CI). Older OAuth App installs keep the allow-list (`legacyAuth`).
const { repoAuth } = agentAuthPolicy(config);
setUserDirectory(new UserDirectory(path.join(config.home, 'users.json')));
const store = new AuthStore(config.home, loadServerSecret(config.home), config.auth.sessionTtlHours * 3600_000, Date.now, serverState);
await store.ready;
// Team (explicit): per-user access from GitHub repo permissions. Older installs keep the sign-in allow-list.
const source = new AuthConfigSource(config.configPath, config.auth, process.env, app.log, `${config.publicUrl}/auth/github/callback`, !repoAuth);
// GitHub Enterprise / test doubles: MANDATE_GITHUB_URL (OAuth) and MANDATE_GITHUB_API_URL (REST).
const github = new GithubClient({ ...GITHUB, web: process.env.MANDATE_GITHUB_URL || GITHUB.web, api: process.env.MANDATE_GITHUB_API_URL || GITHUB.api });
// GitHub App user tokens expire (8 h) and rotate a refresh token: refreshed on read and by a background sweep, so
// pushes (synchronous credential getters) always find a valid token. OAuth App tokens do not expire.
store.refresher = async (refreshToken) => {
  const g = source.current().github;
  if (!g) throw new Error('GitHub sign-in is not configured');
  return github.refreshUserToken(g, refreshToken);
};
setInterval(() => void store.refreshDue().catch((e: Error) => app.log.warn(`GitHub token refresh: ${e.message}`)), 5 * 60_000).unref();
void store.refreshDue().catch(() => undefined);
const cloneBase = process.env.MANDATE_GITHUB_CLONE_BASE || (process.env.MANDATE_GITHUB_URL ? null : 'https://github.com');
const auth = {
  keys,
  store,
  uiOrigins: config.uiOrigins,
  sharedKeys: false,
  agentTokens: new AgentTokens(config.home, serverState),
  oauth: new OAuthStore(config.home, serverState),
  // Admins (create projects, Settings): auth.github.allowedUsers (older OAuth App installs: every signed-in user).
  ...(repoAuth ? { isAdmin: (login: string) => source.allowedUsers().some((u) => u.toLowerCase() === login.toLowerCase()) } : {}),
};
const perms = new RepoPermissions(store, github);
// Local-folder projects of older installs: admins write, other signed-in users read.
if (auth.isAdmin) perms.isAdmin = auth.isAdmin;
if (!source.current().configured) app.log.warn(`GitHub sign-in is not configured (${source.current().missing.join('; ')}); the web UI shows the setup wizard (mandate setup-url)`);
app.log.info(`GitHub sign-in${config.legacyAuth ? ' (OAuth App, sign-in allow-list)' : ''}; public URL ${config.publicUrl}`);

// projects.json: server-owned registry (config.json is never written); external edits are hot-reloaded.
const projectsStore = new ProjectsStore(config.projectsPath);
// Legacy `flow { enabled, approval }` entries become policies (enabled false → off, else optional).
const migratedFlow = await migrateFlowPolicies(projectsStore).catch((e: Error) => (app.log.error(`flow policy migration failed: ${e.message}`), []));
if (migratedFlow.length) app.log.info(`flow settings migrated to policies: ${migratedFlow.join(', ')}`);
const flowClients = new DbClientStore(serverState.db);
const flowSettings = (id: string) => projectSettings(projectsStore, id, flowClients, (login) => auth.isAdmin?.(login) !== false);
const projects = new ProjectRegistry(config.projects, projectOpener(config, { log: app.log, serverState, pgIndex: () => pgIndexOf(activeDb), settings: (p) => flowSettings(p.id), githubRemote: githubRemote(store, (repo) => `${cloneBase ?? process.env.MANDATE_GITHUB_URL}/${repo}.git`),
    // GitHub projects push with the connectedBy user's token; a revoked token pauses pushing ("Reconnect GitHub").
    pushGate: (p) => (p.github && store.tokenStatus(p.github.connectedBy) === 'reconnect' ? { state: 'reconnect', message: `Reconnect GitHub: sign in again as ${p.github.connectedBy}; commits stay local meanwhile` } : null),
    onPushAuthError: (p) => {
      if (p.github) void store.markRevoked(p.github.connectedBy);
    },
  }), config.defaultProject);
// A project deleted from projects.json: its Postgres index schema goes too (derived; rebuilt from git if re-added).
projects.onProjectRemoved = async (id) => {
  const pg = pgIndexOf(activeDb);
  if (!pg || serverState.db.driver !== 'postgres') return;
  await dropIndexSchema(unwrapDb(serverState.db) as PostgresDb, id, pg.schemaPerProject);
  app.log.info(`project '${id}' removed: dropped its Postgres index`);
};
const tokens = new TokenChecker(store, github);
projects.tokenStatus = (login) => store.tokenStatus(login);
projects.refreshTokens = (logins) => tokens.check(logins);

// MCP (Streamable HTTP) per project at /p/<id>/mcp (+ /mcp: project_list); activity → notifications/mandate/activity.
// Section uploads (curl): one-time URLs signed with the server secret, used tokens tracked in the server-state db.
const uploads = new UploadService({ secret: loadServerSecret(config.home), state: serverState });
export const mcpHub = registerMcp(app, { projects, auth, allowedHosts: [config.host, new URL(config.publicUrl).hostname], baseUrl: config.publicUrl, uploads, perms, publicUrl: config.publicUrl });
registerMcpOAuth(app, { publicUrl: config.publicUrl, auth, projects, perms, oauth: auth.oauth, log: app.log });
// Setup wizard state: a legacy GitHub config (or a configured server) counts as set up.
const setup = new SetupState(config.home, () => preconfigured(config));
if (!setup.complete()) {
  setup.token();
  app.log.warn('Mandate is not set up yet: open the wizard with `npm run mandate -- setup-url` (or `getmandate setup-url`)');
}
const publicHost = new URL(config.publicUrl).hostname.toLowerCase();
const allowed = new Set([...LOOPBACK_HOSTS, config.host, publicHost]);
const hostOk = (req: { headers: { host?: string } }) => allowed.has(hostName(req.headers.host ?? ''));
const setupDeps = {
  repoAuth,
  github,
  publicUrl: config.publicUrl,
  trustProxy: config.trustProxy,
  port: config.port,
  home: config.home,
  localBaseDir: config.localBaseDir,
  auth,
  source,
  setup,
  config: new ConfigFile(config.configPath),
  secretsFile: secrets.file,
  browser: new FolderBrowser(),
  get activeDatabase() {
    return activeDb.driver;
  },
  apply: { git: applyGit, database: applyDatabase, databaseUrlEnv: () => (activeDb.driver === 'postgres' ? activeDb.urlEnv : null) },
  restarter: processRestarter((code) => void shutdown(code)),
  nextPublicUrl: () => loadConfig().publicUrl,
  hostOk,
  local: { registry: projects },
  log: app.log,
};
registerAuthRoutes(app, {
  auth,
  source,
  github,
  log: app.log,
  statusExtra: setupStatus(setupDeps),
  onSignIn: (login) => perms.forget(login),
  claimAdmin: adminClaimHook(setupDeps),
});
registerSetupRoutes(app, setupDeps);
// One-line installer for developer machines: `curl -fsSL <url>/p/<project>/install.sh | sh` (no secrets in it).
// The installer installs this server's own CLI package, served as /getmandate.tgz (packed once into ~/.mandate/cache/cli).
// From source (npm run dev) the repo's CLI is built on demand, so the installer works without `npm run build`.
const cliSource = findSourceCliPackage();
const cliPackage = cliSource ?? findCliPackage();
if (!cliPackage) app.log.info('install: no built CLI package found; /getmandate.tgz is unavailable (npm run build)');
else if (cliSource) app.log.info('install: running from source; /getmandate.tgz is built on demand from the repo');
registerInstallRoutes(app, {
  url: config.publicUrl,
  version: process.env.MANDATE_VERSION ?? '0.1.0',
  trustProxy: config.trustProxy,
  hostOk,
  hasProject: (id) => !!projects.config(id),
  strictFlow: (id) => !!flowSettings(id).policy().strictFlow,
  cli: cliPackage ? new CliTarball(cliPackage, path.join(mandateHome(), 'cache', 'cli'), undefined, cliSource ? () => buildFromSource(cliSource.dir) : undefined) : null,
});
// Agent flow: project policy (projects.json) + per-client preferences (server-state database).
registerFlowRoutes(app, { auth, hostOk, registry: projects, settings: flowSettings, access: (login, p) => perms.access(login, p) as Promise<'none' | 'read' | 'write'> });
registerCodeRepoRoutes(app, { auth, hostOk, registry: projects, settings: flowSettings, access: (login, p) => perms.access(login, p) as Promise<'none' | 'read' | 'write'> });
function resolveProject(id: string) {
  const p = loadConfig().projects.find((x) => x.id === id);
  if (!p) throw new Error(`project '${id}' not found in ${config.projectsPath}`);
  return p;
}
registerAdminRoutes(app, {
  auth,
  source,
  hostOk,
  registry: projects,
  keys,
  store,
  github,
  home: config.home,
  projects: projectsStore,
  resolveProject,
  log: app.log,
});

const stopWatching = watchProjectsFile(config.projectsPath, () => {
  void reloadProjects(projects, () => loadConfig().projects, app.log, () => undefined);
});

/** Settings → Git backend: switch every project's git store live (all-or-nothing). */
async function applyGit(): Promise<string[]> {
  const ids = await projects.reconfigureGit(loadConfig().projects);
  if (ids.length) app.log.info(`git backend switched live for ${ids.join(', ')}`);
  return ids;
}

/**
 * Settings → Database (or a new URL secret): open and verify the new database, swap it in (writes drain), close the
 * old one, reload cached tokens, and reopen the projects when the Postgres index mirror is involved (it publishes to
 * the new database). Server state is not copied (people sign in again; `mandate db copy` copies it).
 */
async function applyDatabase(): Promise<{ changed: boolean }> {
  refreshSecrets();
  const next = loadConfig().database;
  if (JSON.stringify(next) === JSON.stringify(activeDb)) return { changed: false };
  await switchServerDatabase(serverState, () => openServerDb(next), { home: config.home });
  const prev = activeDb;
  activeDb = next;
  await store.loadTokens().catch((e: Error) => app.log.warn(`token cache reload failed: ${e.message}`));
  app.log.info(`server state switched live to ${next.driver === 'sqlite' ? next.path : `postgres ${redactUrl(next.url)}`} (sessions and tokens are not copied: sign in again, or mandate db copy)`);
  if (pgIndexOf(prev) || pgIndexOf(next)) await projects.reopen();
  return { changed: true };
}

let stopping = false;
const shutdown = async (code = 0) => {
  if (stopping) return;
  stopping = true;
  // Open streams (MCP SSE, a client not reading a response) would keep app.close() waiting forever.
  setTimeout(() => process.exit(code), 5000).unref();
  stopWatching();
  await app.close();
  await projects.close();
  await serverState.close().catch(() => undefined);
  process.exit(code);
};
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());

// Production: the built web UI on the same port (SPA fallback); dev has no web dir (Vite serves the UI).
const webDir = resolveWebDir();
if (webDir) registerStaticUi(app, webDir);
else {
  // Dev: Vite serves the UI on its own port. Browser pages the CLI opens on this server (the channel login approval)
  // are sent there: the first configured UI origin, else MANDATE_UI_URL, else Vite's default.
  const uiBase = (config.uiOrigins[0] ?? process.env.MANDATE_UI_URL ?? 'http://localhost:5173').replace(/\/+$/, '');
  app.get('/cli-login', async (req, reply) => reply.redirect(`${uiBase}${req.url}`, 302));
}
await app.listen({ port: config.port, host: config.host });
app.log.info(`projects: ${config.projects.map((p) => `${p.id} (${p.dataDir})`).join(', ')}; registry: ${config.projectsPath}; config: ${config.configPath}`);
// The default project opens eagerly (index sync starts now); the others on first use.
projects.open(config.defaultProject).catch((e: Error) => app.log.error(e.message));

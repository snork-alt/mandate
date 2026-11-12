import { loadSecrets } from './secrets.js';
import path from 'node:path';
import { setUserDirectory, UserDirectory } from './auth/users.js';
import { loadConfig } from './config.js';
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
import { ConfigFile, LocalLoginTokens, SetupState } from './setup/files.js';
import { FolderBrowser } from './setup/fs.js';
import { registerSetupRoutes, setupStatus } from './setup/routes.js';
import { githubRemote, registerAdminRoutes, TokenChecker } from './projects/admin.js';
import { registerStaticUi, resolveWebDir } from './static.js';
import { DbClientStore, migrateFlowPolicies, projectSettings } from './projects/settings.js';
import { registerFlowRoutes } from './projects/flow-routes.js';
import { openConfiguredState } from './db/state.js';
import { redactUrl } from './db/config.js';
import { dropIndexSchema } from './db/pg-index/mirror.js';
import type { PostgresDb } from './db/postgres.js';

// Secrets (~/.mandate/secrets.env) fill unset env vars before the config is resolved.
const secrets = loadSecrets();
const config = loadConfig();
const app = buildApp({
  logger: true,
  health: async () => {
    const def = config.projects.find((p) => p.id === config.defaultProject)!;
    return { ok: true, version: process.env.MANDATE_VERSION ?? '0.1.0', dataDir: def.dataDir, remote: def.remote?.url.replace(/\/\/[^/@]*@/, '//***@') ?? null };
  },
});
for (const w of config.warnings) app.log.warn(w);
// Server state (sessions, tokens, OAuth, idempotency): SQLite ~/.mandate/state.sqlite (default) or Postgres.
const serverState = await openConfiguredState(config.database, config.home);
serverState.startPruning();
app.log.info(`server state: ${config.database.driver === 'sqlite' ? config.database.path : `postgres ${redactUrl(config.database.url)} (schema mandate_server${config.database.pooler === 'transaction' ? '; transaction pooler: prepared statements off' : ''})`}`);
if (secrets.problem) app.log.warn(`secrets file ${secrets.file}: ${secrets.problem}`);

// Sign-in: agent keys (keys.json, one per project, generated on startup) + GitHub sessions for the web UI.
const keys = new KeyStore(config.keysPath, { log: app.log });
// Agents authenticate PER USER in server mode, including legacy installs (auth.github without server.mode): MCP OAuth
// or personal tokens; shared project keys are refused except named service accounts (`key create --service`).
// Local mode keeps the shared per-project key (single user, agent-only attribution).
const { perUserAgents, sharedKeys, repoAuth } = agentAuthPolicy(config);
const created = sharedKeys ? keys.ensureProjectKeys(config.projects.map((p) => p.id)) : [];
if (created.length) app.log.info(`agent keys created for ${created.join(', ')} in ${config.keysPath}`);
setUserDirectory(new UserDirectory(path.join(config.home, 'users.json')));
const store = new AuthStore(config.home, loadServerSecret(config.home), config.auth.sessionTtlHours * 3600_000, Date.now, serverState);
await store.ready;
// Server mode (explicit): per-user access from GitHub repo permissions; agents use MCP OAuth or personal tokens.
// Local mode and legacy installs keep the shared per-project keys.
const source = new AuthConfigSource(config.configPath, config.auth, process.env, app.log, `${config.publicUrl}/auth/github/callback`, !repoAuth);
// GitHub Enterprise / test doubles: MANDATE_GITHUB_URL (OAuth) and MANDATE_GITHUB_API_URL (REST).
const github = new GithubClient({ ...GITHUB, web: process.env.MANDATE_GITHUB_URL || GITHUB.web, api: process.env.MANDATE_GITHUB_API_URL || GITHUB.api });
const cloneBase = process.env.MANDATE_GITHUB_CLONE_BASE || (process.env.MANDATE_GITHUB_URL ? null : 'https://github.com');
const auth = {
  keys,
  store,
  uiOrigins: config.uiOrigins,
  mode: config.mode,
  sharedKeys,
  ...(perUserAgents ? { agentTokens: new AgentTokens(config.home, serverState), oauth: new OAuthStore(config.home, serverState) } : {}),
  // Admins (create projects, Settings): auth.github.allowedUsers (explicit server mode; legacy: every signed-in user).
  ...(repoAuth ? { isAdmin: (login: string) => source.allowedUsers().some((u) => u.toLowerCase() === login.toLowerCase()) } : {}),
};
const perms = config.mode === 'server' ? new RepoPermissions(store, github) : undefined;
if (config.mode === 'server' && !source.current().configured) app.log.warn(`GitHub sign-in is not configured (${source.current().missing.join('; ')}); the web UI shows the setup page, agent keys work`);
app.log.info(`mode: ${config.mode}${config.legacyMode ? ' (inferred from auth.github)' : ''}; public URL ${config.publicUrl}`);
if (config.legacyMode) app.log.warn('legacy server install (auth.github without server.mode): treated as server mode for agent auth, so shared project keys are refused (use MCP sign-in or a personal token; CI: mandate key create <project> --service <name>). Set server.mode: "server" in config.json to make it explicit.');

// projects.json: server-owned registry (config.json is never written); external edits are hot-reloaded.
const projectsStore = new ProjectsStore(config.projectsPath);
// Legacy `flow { enabled, approval }` entries become policies (enabled false → off, else optional).
const migratedFlow = await migrateFlowPolicies(projectsStore).catch((e: Error) => (app.log.error(`flow policy migration failed: ${e.message}`), []));
if (migratedFlow.length) app.log.info(`flow settings migrated to policies: ${migratedFlow.join(', ')}`);
const flowClients = new DbClientStore(serverState.db);
const flowSettings = (id: string) => projectSettings(projectsStore, id, config.mode, flowClients, (login) => auth.isAdmin?.(login) !== false);
const projects = new ProjectRegistry(config.projects, projectOpener(config, { log: app.log, serverState, ...(config.database.driver === 'postgres' && config.database.publishIndex ? { pgIndex: { schemaPerProject: config.database.schemaPerProject } } : {}), settings: (p) => flowSettings(p.id), githubRemote: githubRemote(store, (repo) => `${cloneBase ?? process.env.MANDATE_GITHUB_URL}/${repo}.git`),
    // GitHub projects push with the connectedBy user's token; a revoked token pauses pushing ("Reconnect GitHub").
    pushGate: (p) => (p.github && store.tokenStatus(p.github.connectedBy) === 'reconnect' ? { state: 'reconnect', message: `Reconnect GitHub: sign in again as ${p.github.connectedBy}; commits stay local meanwhile` } : null),
    onPushAuthError: (p) => {
      if (p.github) void store.markRevoked(p.github.connectedBy);
    },
  }), config.defaultProject);
if (config.database.driver === 'postgres' && config.database.publishIndex) {
  const mode = config.database.schemaPerProject;
  // A project deleted from projects.json: its Postgres index schema goes too (derived; rebuilt from git if re-added).
  projects.onProjectRemoved = async (id) => {
    await dropIndexSchema(serverState.db as PostgresDb, id, mode);
    app.log.info(`project '${id}' removed: dropped its Postgres index`);
  };
}
const tokens = new TokenChecker(store, github);
projects.tokenStatus = (login) => store.tokenStatus(login);
projects.refreshTokens = (logins) => tokens.check(logins);

// MCP (Streamable HTTP) per project at /p/<id>/mcp (+ /mcp: project_list); activity → notifications/mandate/activity.
// Section uploads (curl): one-time URLs signed with the server secret, used tokens tracked in the server-state db.
const uploads = new UploadService({ secret: loadServerSecret(config.home), state: serverState });
export const mcpHub = registerMcp(app, { projects, auth, allowedHosts: [config.host, new URL(config.publicUrl).hostname], baseUrl: config.publicUrl, uploads, ...(perms ? { perms } : {}), ...(perUserAgents ? { publicUrl: config.publicUrl } : {}) });
if (perUserAgents && perms && auth.oauth) registerMcpOAuth(app, { publicUrl: config.publicUrl, auth, projects, perms, oauth: auth.oauth, log: app.log });
// Setup wizard state: a legacy GitHub config (or a configured server) counts as set up.
const setup = new SetupState(config.home, () => config.legacyMode || (config.mode === 'server' && !!config.auth.github?.clientId));
if (!setup.complete()) {
  setup.token();
  app.log.warn('Mandate is not set up yet: open the wizard with `npm run mandate -- setup-url` (or `getmandate setup-url`)');
}
const publicHost = new URL(config.publicUrl).hostname.toLowerCase();
const allowed = new Set([...LOOPBACK_HOSTS, config.host, publicHost]);
const hostOk = (req: { headers: { host?: string } }) => allowed.has(hostName(req.headers.host ?? ''));
const setupDeps = {
  mode: config.mode,
  repoAuth,
  legacyMode: config.legacyMode,
  publicUrl: config.publicUrl,
  trustProxy: config.trustProxy,
  port: config.port,
  home: config.home,
  localBaseDir: config.localBaseDir,
  auth,
  source,
  setup,
  logins: new LocalLoginTokens(config.home, serverState),
  config: new ConfigFile(config.configPath),
  secretsFile: secrets.file,
  browser: new FolderBrowser(),
  activeDatabase: config.database.driver,
  hostOk,
  local: { registry: projects, projects: projectsStore, keys, resolveProject: (id: string) => resolveProject(id), log: app.log },
  log: app.log,
};
registerAuthRoutes(app, { auth, source, github, log: app.log, githubEnabled: config.mode === 'server', statusExtra: setupStatus(setupDeps), onSignIn: (login) => perms?.forget(login) });
registerSetupRoutes(app, setupDeps);
// Agent flow: project policy (projects.json) + per-client preferences (server-state database).
registerFlowRoutes(app, { mode: config.mode, auth, hostOk, registry: projects, settings: flowSettings, ...(perms ? { access: (login, p) => perms.access(login, p) as Promise<'none' | 'read' | 'write'> } : {}) });
function resolveProject(id: string) {
  const p = loadConfig().projects.find((x) => x.id === id);
  if (!p) throw new Error(`project '${id}' not found in ${config.projectsPath}`);
  return p;
}
if (config.mode === 'server') registerAdminRoutes(app, {
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
  void reloadProjects(projects, () => loadConfig().projects, app.log, (ids) => (sharedKeys ? keys.ensureProjectKeys(ids) : undefined));
});

const shutdown = async () => {
  // Open streams (MCP SSE, a client not reading a response) would keep app.close() waiting forever.
  setTimeout(() => process.exit(0), 5000).unref();
  stopWatching();
  await app.close();
  await projects.close();
  await serverState.close().catch(() => undefined);
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Production: the built web UI on the same port (SPA fallback); dev has no web dir (Vite serves the UI).
const webDir = resolveWebDir();
if (webDir) registerStaticUi(app, webDir);
await app.listen({ port: config.port, host: config.host });
app.log.info(`projects: ${config.projects.map((p) => `${p.id} (${p.dataDir})`).join(', ')}; registry: ${config.projectsPath}; config: ${config.configPath}`);
// The default project opens eagerly (index sync starts now); the others on first use.
projects.open(config.defaultProject).catch((e: Error) => app.log.error(e.message));

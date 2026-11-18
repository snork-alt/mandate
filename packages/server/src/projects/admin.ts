/**
 * Project administration: the ONE write path of the web UI (documents stay read-only there). Signed-in UI session
 * only (never agent keys), `X-Mandate-UI: 1`, same-origin `Origin` on POSTs.
 * - `GET  /ui/github/repos?q=`  the user's GitHub repos (stored OAuth token, REST API)
 * - `POST /ui/github/repos`     create a repo (private by default)
 * - `POST /ui/projects`         create a project stored in a GitHub repo (folder optional):
 *   clone (HTTPS, token via credential callback / helper, never in URLs or argv) into `<home>/projects/<id>/repo`,
 *   init the Mandate layout if absent, commit + push (never force), register in config.json, generate its agent
 *   key, open it.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { LEGACY_USER_TRAILER, USER_TRAILER } from '@mandate/shared';
import { projectIdSchema, type ProjectConfig, type RemoteConfig } from '../config.js';
import { idFromTitle, uniqueId } from '@mandate/shared';
import type { ProjectsStore } from './store.js';
import type { AuthStore } from '../auth/sessions.js';
import { appInstallUrl, GithubClient, GithubError, type AuthConfigSource, type GithubRepo } from '../auth/github.js';
import { originOk, type AuthOptions } from '../auth/http.js';
import type { KeyStore } from '../auth/keys.js';
import type { ProjectRegistry } from './registry.js';
import { projectSummary, uiGate } from '../mcp/http.js';

export class AdminError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly path?: string,
    readonly hint?: string,
  ) {
    super(message);
  }
}

const folderSchema = z
  .string()
  .trim()
  .transform((s) => s.replace(/^\/+|\/+$/g, ''))
  .pipe(z.string().max(200).regex(/^$|^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/, 'a relative folder like docs/mandate').refine((p) => !p.split('/').some((s) => s === '.' || s === '..' || s === '.git'), 'no . / .. / .git segments'));

export const createProjectInputSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    description: z.string().trim().max(500).optional(),
    repo: z.string().regex(/^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/, 'owner/name'),
    branch: z.string().trim().regex(/^(?!-)(?!.*\.\.)[A-Za-z0-9._/-]{1,100}$/, 'a branch name').optional(),
    path: folderSchema.optional(),
  })
  .strict();
export type CreateProjectInput = z.input<typeof createProjectInputSchema>;

const createRepoInputSchema = z
  .object({
    name: z.string().regex(/^[A-Za-z0-9._-]{1,100}$/, 'a repository name'),
    private: z.boolean().default(true),
    description: z.string().trim().max(350).optional(),
    /** Organization login to create the repo in (default: the signed-in user). */
    owner: z.string().regex(/^[A-Za-z0-9-]{1,39}$/, 'a GitHub owner').optional(),
  })
  .strict();

/**
 * Project ids are assigned by Mandate: a slug of the name (max 40 chars), unique among registered projects and
 * existing folders (`-2`, `-3`, ...). A request that sends an id gets a clear error.
 */
export async function assignProjectId(name: string, taken: (id: string) => boolean): Promise<string> {
  let base = idFromTitle(name, 'project').slice(0, 36).replace(/-+$/, '');
  if (!projectIdSchema.safeParse(base).success) base = 'project';
  return uniqueId(base, taken);
}

/** Parse a create-project body; `id` is refused with the "ids are assigned by Mandate" hint. */
export function parseProjectInput<S extends z.ZodType>(schema: S, raw: unknown): z.output<S> {
  if (raw && typeof raw === 'object' && 'id' in raw) throw new AdminError(400, 'invalid_input', 'id: ids are assigned by Mandate; omit id', 'id', 'the project id is generated from the name and returned in the result');
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const i = parsed.error.issues[0]!;
    throw new AdminError(400, 'invalid_input', `${i.path.join('.') || 'body'}: ${i.message}`, String(i.path[0] ?? ''));
  }
  return parsed.data;
}

/** Mandate's repo layout: document folders plus the jsonl files. */
export const LAYOUT_DIRS = ['specs', 'standards', 'components'];
export const LAYOUT_FILES = ['work-orders.jsonl', 'feedback.jsonl', 'verifications.jsonl'];

/** Two folders of one repo overlap when equal or nested ('' = the whole repo). */
export function foldersOverlap(a: string, b: string): boolean {
  if (!a || !b || a === b) return true;
  return a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

export interface AdminDeps {
  registry: ProjectRegistry;
  keys: KeyStore;
  store: AuthStore;
  github: GithubClient;
  /** `~/.mandate` (clones go to `<home>/projects/<id>/repo`). */
  home: string;
  /** projects.json (the server-owned registry). */
  projects: ProjectsStore;
  /** Resolve a project as `loadConfig` would (index path etc.) after it was written to config.json. */
  resolveProject: (id: string) => ProjectConfig;
  log?: { info(m: string): void; warn(m: string): void };
}

/** HTTPS remote for a GitHub-backed project: the token is read from the store on every use (hot after re-login). */
export function githubRemote(store: AuthStore, cloneUrl: (repo: string) => string = (r) => `https://github.com/${r}.git`) {
  return (p: ProjectConfig): RemoteConfig | undefined => {
    if (!p.github) return undefined;
    const login = p.github.connectedBy;
    const auth = { type: 'https' as const, username: 'x-access-token', token: '' };
    Object.defineProperty(auth, 'token', { enumerable: true, get: () => store.tokenCached(login)?.token ?? '' });
    return { url: cloneUrl(p.github.repo), branch: p.branch, auth };
  };
}

/** OAuth App tokens need the repo / public_repo scope; GitHub App tokens have no scopes (installation permissions). */
const needScope = (tok: { scopes: string[]; app?: boolean }, isPrivate: boolean) => !tok.app && needScopeOf(tok.scopes, isPrivate);
const needScopeOf = (scopes: string[], isPrivate: boolean) => (isPrivate ? !scopes.includes('repo') : !scopes.includes('repo') && !scopes.includes('public_repo'));

export type CreateStep = 'clone' | 'init' | 'push' | 'key';
export type ProgressFn = (step: CreateStep, status: 'start' | 'done') => void;

export async function createProject(deps: AdminDeps, login: string, raw: unknown, progress: ProgressFn = () => undefined) {
  const data = parseProjectInput(createProjectInputSchema, raw);
  const known = new Set(deps.projects.read().projects.map((p) => p.id));
  const id = await assignProjectId(data.name, (c) => known.has(c) || !!deps.registry.config(c) || existsSync(path.join(deps.home, 'projects', c)));
  const input = { ...data, id };
  const folder = input.path ?? '';
  const { registry } = deps;
  if (registry.config(input.id)) throw new AdminError(409, 'project_exists', `a project '${input.id}' already exists`, 'id', 'pick another id');
  const dataDir = path.join(deps.home, 'projects', input.id, 'repo');
  if (existsSync(dataDir)) throw new AdminError(409, 'project_exists', `${dataDir} already exists`, 'id', 'pick another id (Mandate never overwrites a folder)');
  for (const p of registry.list()) {
    if (p.github && p.github.repo.toLowerCase() === input.repo.toLowerCase() && foldersOverlap(folder, p.github.path ?? '')) {
      throw new AdminError(409, 'folder_overlap', `project '${p.id}' already uses ${p.github.repo}${p.github.path ? `/${p.github.path}` : ' (whole repo)'}`, 'path', 'use a separate folder that is not inside (or around) another project’s folder');
    }
  }
  const tok = await deps.store.token(login);
  if (!tok) throw new AdminError(401, 'needs_scope', 'no usable GitHub token for your account', 'repo', 'sign in with GitHub again');
  let repo;
  try {
    repo = await deps.github.repo(tok.token, input.repo);
  } catch (e) {
    if (e instanceof GithubError && e.status === 401) void deps.store.markRevoked(login);
    throw new AdminError(e instanceof GithubError && e.status === 404 ? 404 : 502, 'github_error', (e as Error).message, 'repo');
  }
  if (!repo.canPush) throw new AdminError(403, 'github_error', `you cannot push to ${repo.fullName}`, 'repo', 'pick a repo you can write to');
  if (needScope(tok, repo.private)) throw new AdminError(403, 'needs_scope', `storing a project in ${repo.private ? 'a private' : 'a public'} repo needs the GitHub '${repo.private ? 'repo' : 'public_repo'}' scope`, 'repo', 'grant the scope (New project → consent step)');
  const branch = input.branch ?? repo.defaultBranch ?? 'main';
  if (!repo.empty && repo.defaultBranch && branch !== repo.defaultBranch) {
    throw new AdminError(400, 'invalid_input', `only the default branch (${repo.defaultBranch}) is supported for an existing repo`, 'branch');
  }

  // Register in projects.json (serialized; id and folder overlap re-checked under the store's lock), then resolve
  // the runtime config (index path, git backend) and open: the opener clones. config.json is never written.
  const [owner, name] = repo.fullName.split('/') as [string, string];
  try {
    await deps.projects.mutate((reg) => {
      if (reg.projects.some((p) => p.id === input.id)) throw new AdminError(409, 'project_exists', `a project '${input.id}' already exists`, 'id', 'pick another id');
      for (const p of reg.projects) {
        if (p.github && `${p.github.owner}/${p.github.repo}`.toLowerCase() === repo.fullName.toLowerCase() && foldersOverlap(folder, p.github.path ?? '')) {
          throw new AdminError(409, 'folder_overlap', `project '${p.id}' already uses ${repo.fullName}${p.github.path ? `/${p.github.path}` : ' (whole repo)'}`, 'path', 'use a separate folder that is not inside (or around) another project’s folder');
        }
      }
      reg.projects.push({
        id: input.id,
        name: input.name,
        ...(input.description ? { description: input.description } : {}),
        dataDir,
        github: { owner, repo: name, branch, ...(folder ? { path: folder } : {}) },
        connectedBy: login,
        createdAt: new Date().toISOString(),
      });
    });
  } catch (e) {
    throw e instanceof AdminError ? e : new AdminError(500, 'invalid_input', (e as Error).message);
  }
  let resolved: ProjectConfig;
  try {
    resolved = deps.resolveProject(input.id);
  } catch (e) {
    await deps.projects.remove(input.id).catch(() => undefined);
    throw new AdminError(500, 'invalid_input', (e as Error).message);
  }
  const rollback = async () => {
    await registry.remove(input.id).catch(() => undefined);
    await deps.projects.remove(input.id).catch(() => undefined);
    await rm(path.dirname(dataDir), { recursive: true, force: true }).catch(() => undefined);
  };
  if (!registry.config(input.id)) registry.add(resolved);
  let rt;
  progress('clone', 'start');
  try {
    rt = await registry.open(input.id);
    progress('clone', 'done');
  } catch (e) {
    await rollback();
    throw new AdminError(502, 'clone_failed', `cloning ${repo.fullName} failed: ${(e as Error).message.replace(/x-access-token:[^@\s]*@/g, '')}`, 'repo');
  }
  // Mandate layout (only what is absent), one commit, pushed (normal push, never force).
  progress('init', 'start');
  try {
    const root = rt.git.dir;
    const added: string[] = [];
    for (const d of LAYOUT_DIRS) {
      if (!existsSync(path.join(root, d))) {
        mkdirSync(path.join(root, d), { recursive: true });
        writeFileSync(path.join(root, d, '.gitkeep'), '');
        added.push(`${d}/.gitkeep`);
      }
    }
    for (const f of LAYOUT_FILES) {
      if (!existsSync(path.join(root, f))) {
        mkdirSync(root, { recursive: true });
        writeFileSync(path.join(root, f), '');
        added.push(f);
      }
    }
    if (added.length) {
      await rt.storage.lock.run(() => rt.git.commit(added, `mandate: initialize project ${input.id}\n\nAgent: mandate-ui\n${USER_TRAILER}: ${login}\n${LEGACY_USER_TRAILER}: ${login}\n`));
    }
  } catch (e) {
    await rollback();
    throw new AdminError(500, 'clone_failed', `initializing the layout failed: ${(e as Error).message}`);
  }
  progress('init', 'done');
  progress('push', 'start');
  try {
    await rt.git.push();
    progress('push', 'done');
  } catch (e) {
    const msg = (e as Error).message;
    if (/401|403|auth/i.test(msg)) void deps.store.markRevoked(login);
    await rollback();
    throw new AdminError(502, 'push_failed', `pushing to ${repo.fullName} failed: ${msg.replace(/x-access-token:[^@\s]*@/g, '')}`, 'repo', 'check that you can push to the branch (protected branches reject direct pushes)');
  }
  progress('key', 'start');
  deps.keys.ensureProjectKeys([input.id]);
  progress('key', 'done');
  deps.log?.info(`project '${input.id}' created by ${login} in ${repo.fullName}${folder ? `/${folder}` : ''} (${dataDir})`);
  return projectSummary(rt, registry.info(input.id)!);
}

/** Validates GitHub tokens of connected projects (401 → revoked → "Reconnect GitHub"); cached 5 minutes per login. */
export class TokenChecker {
  private readonly checked = new Map<string, number>();
  constructor(
    private readonly store: AuthStore,
    private readonly github: GithubClient,
  ) {}

  async check(logins: string[]): Promise<void> {
    await Promise.all(
      [...new Set(logins)].map(async (login) => {
        if (Date.now() - (this.checked.get(login) ?? 0) < 300_000) return;
        this.checked.set(login, Date.now());
        const t = await this.store.token(login);
        if (!t) return;
        try {
          await this.github.user(t.token);
        } catch (e) {
          if (e instanceof GithubError && e.status === 401) void this.store.markRevoked(login);
        }
      }),
    );
  }

  forget(login: string) {
    this.checked.delete(login);
  }
}

export function registerAdminRoutes(app: FastifyInstance, deps: AdminDeps & { auth: AuthOptions; source: AuthConfigSource; hostOk: (req: FastifyRequest) => boolean }) {
  const send = (reply: FastifyReply, e: unknown) => {
    if (e instanceof AdminError) return reply.code(e.status).send({ error: { code: e.code, message: e.message, ...(e.path ? { path: e.path } : {}), ...(e.hint ? { hint: e.hint } : {}) } });
    deps.log?.warn(`admin: ${(e as Error).message}`);
    return reply.code(500).send({ error: { code: 'internal', message: (e as Error).message } });
  };
  const notAdmin = (reply: FastifyReply, login: string) => {
    if (deps.auth.isAdmin?.(login) === false) {
      reply.code(403).send({ error: { code: 'forbidden', message: 'only Mandate admins (auth.github.allowedUsers) can create projects', hint: 'ask an admin to add your GitHub login to allowedUsers' } });
      return true;
    }
    return false;
  };
  const post = async (req: FastifyRequest, reply: FastifyReply) => {
    const p = await uiGate(req, reply, deps, deps.hostOk);
    if (!p || p.kind !== 'ui') return null;
    if (notAdmin(reply, p.user.login)) return null;
    if (!originOk(req, deps.auth.uiOrigins)) {
      reply.code(403).send({ error: { code: 'forbidden', message: 'Origin must be same-origin' } });
      return null;
    }
    return p.user.login;
  };
  const appInfo = (slug: string | null, installations: { account: string; type: string; selection: string }[]) => ({
    slug,
    /** Install the app on more accounts / repositories, then refresh the list. */
    installUrl: slug ? appInstallUrl(deps.github.webBase, slug) : null,
    installations,
  });
  const upgrade = (scope: string) => `/auth/github/login?scope=${scope}&returnTo=${encodeURIComponent('/?new=1')}`;

  app.get('/ui/github/repos', async (req, reply) => {
    const p = await uiGate(req, reply, deps, deps.hostOk);
    if (!p || p.kind !== 'ui') return reply;
    if (notAdmin(reply, p.user.login)) return reply;
    const login = p.user.login;
    const q = req.query as { q?: string; owner?: string };
    const needle = String(q.q ?? '').slice(0, 100);
    const owner = typeof q.owner === 'string' && /^[A-Za-z0-9-]{1,39}$/.test(q.owner) ? q.owner : 'all';
    const tok = await deps.store.token(login);
    const scopes = tok?.scopes ?? [];
    const clientId = deps.source.current().github?.clientId;
    const base = {
      scopes,
      needsScope: scopes.includes('repo') ? null : ('repo' as const),
      upgradeUrl: upgrade('repo'),
      upgradeUrlPublic: upgrade('public_repo'),
      /** Re-run OAuth: GitHub's consent screen shows per-org Grant / Request buttons. */
      reauthUrl: upgrade('repo'),
      /** Where the user grants (or requests) an org's approval of this OAuth App. */
      grantUrl: clientId ? `https://github.com/settings/connections/applications/${clientId}` : null,
      owner,
    };
    const app = deps.source.current().github?.app;
    if (!tok) return { ...base, needsScope: app ? null : 'repo', owners: [], items: [], ...(app ? { app: appInfo(app.slug, []) } : {}) };
    // GitHub App: the user's token sees only repositories where the app is installed (∩ the user's own access), so
    // the picker lists installations and offers "Install Mandate on more repos / organizations".
    if (app || tok.app) {
      try {
        const insts = await deps.github.installations(tok.token);
        const lists = await Promise.all(insts.filter((i) => owner === 'all' || i.account.toLowerCase() === owner.toLowerCase()).map((i) => deps.github.installationRepos(tok.token, i.id, needle).catch(() => [] as GithubRepo[])));
        const byName = new Map<string, GithubRepo>();
        for (const r of lists.flat()) byName.set(r.fullName.toLowerCase(), r);
        const items = [...byName.values()].sort((x, y) => (y.pushedAt ?? '').localeCompare(x.pushedAt ?? ''));
        const owners = insts.map((i) => ({ login: i.account, name: null, avatarUrl: i.avatarUrl, type: i.accountType === 'Organization' ? ('org' as const) : ('user' as const), canCreateRepos: false, restricted: false, selection: i.selection }));
        return { ...base, needsScope: null, owners, items, app: appInfo(app?.slug ?? null, insts.map((i) => ({ account: i.account, type: i.accountType, selection: i.selection }))) };
      } catch (e) {
        if (e instanceof GithubError && e.status === 401) void deps.store.markRevoked(login);
        return send(reply, new AdminError(502, 'github_error', (e as Error).message));
      }
    }
    try {
      const [orgs, mine] = await Promise.all([deps.github.orgs(tok.token).catch(() => []), deps.github.repos(tok.token, needle)]);
      const seen = new Set(mine.items.map((r) => r.owner.toLowerCase()));
      // An org whose repos are missing from /user/repos may restrict OAuth Apps: probe it.
      const probes = await Promise.all(
        orgs.map(async (o) => {
          if (owner !== o.login && (owner !== 'all' || seen.has(o.login.toLowerCase()))) return { org: o, restricted: false, items: [] as GithubRepo[] };
          const r = await deps.github.orgRepos(tok.token, o.login, needle).catch(() => ({ items: [] as GithubRepo[], restricted: false }));
          return { org: o, ...r };
        }),
      );
      const restricted = new Set(probes.filter((x) => x.restricted).map((x) => x.org.login.toLowerCase()));
      const owners = [
        { login, name: p.user.name ?? null, avatarUrl: p.user.avatarUrl, type: 'user' as const, canCreateRepos: true, restricted: false },
        ...orgs.map((o) => ({ login: o.login, name: o.name, avatarUrl: o.avatarUrl, type: 'org' as const, role: o.role, canCreateRepos: o.canCreateRepos && !restricted.has(o.login.toLowerCase()), restricted: restricted.has(o.login.toLowerCase()) })),
      ];
      const byName = new Map<string, GithubRepo>();
      for (const r of [...mine.items, ...probes.flatMap((x) => x.items)]) byName.set(r.fullName.toLowerCase(), r);
      let items = [...byName.values()];
      if (owner !== 'all') items = items.filter((r) => r.owner.toLowerCase() === owner.toLowerCase());
      items.sort((x, y) => (y.pushedAt ?? '').localeCompare(x.pushedAt ?? ''));
      return { ...base, owners, items };
    } catch (e) {
      if (e instanceof GithubError && e.status === 401) void deps.store.markRevoked(login);
      return send(reply, new AdminError(502, 'github_error', (e as Error).message));
    }
  });

  // Settings → Admins: look a GitHub login up (avatar, name) before adding it. Admins only, with their own token.
  app.get('/ui/github/users/:login', async (req, reply) => {
    const p = await uiGate(req, reply, deps, deps.hostOk);
    if (!p || p.kind !== 'ui') return reply;
    if (notAdmin(reply, p.user.login)) return reply;
    const login = (req.params as { login: string }).login;
    if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(login)) return send(reply, new AdminError(400, 'invalid_input', 'not a GitHub login', 'login'));
    const tok = await deps.store.token(p.user.login);
    if (!tok) return send(reply, new AdminError(401, 'needs_scope', 'no usable GitHub token for your account', 'login', 'sign in with GitHub again'));
    try {
      const u = await deps.github.userByLogin(tok.token, login);
      if (!u || u.type !== 'User') return send(reply, new AdminError(404, 'not_found', `no GitHub user '${login}'`, 'login'));
      reply.header('Cache-Control', 'no-store');
      return { login: u.login, name: u.name, avatarUrl: u.avatarUrl };
    } catch (e) {
      if (e instanceof GithubError && e.status === 401) void deps.store.markRevoked(p.user.login);
      return send(reply, new AdminError(502, 'github_error', (e as Error).message, 'login'));
    }
  });

  app.post('/ui/github/repos', async (req, reply) => {
    const login = await post(req, reply);
    if (!login) return reply;
    const r = createRepoInputSchema.safeParse(req.body);
    if (!r.success) return send(reply, new AdminError(400, 'invalid_input', r.error.issues[0]!.message, String(r.error.issues[0]!.path[0] ?? 'name')));
    const tok = await deps.store.token(login);
    if (!tok || needScope(tok, r.data.private)) return send(reply, new AdminError(403, 'needs_scope', `creating a ${r.data.private ? 'private' : 'public'} repo needs the '${r.data.private ? 'repo' : 'public_repo'}' scope`, 'repo'));
    const owner = r.data.owner && r.data.owner.toLowerCase() !== login.toLowerCase() ? r.data.owner : undefined;
    try {
      return { repo: await deps.github.createRepo(tok.token, { name: r.data.name, private: r.data.private, ...(r.data.description ? { description: r.data.description } : {}), ...(owner ? { owner } : {}) }) };
    } catch (e) {
      const st = e instanceof GithubError ? e.status : 502;
      const restricted = /OAuth App access restrictions/i.test((e as Error).message);
      // A GitHub App cannot create repositories (it asks only for contents + metadata): create it on GitHub instead.
      const app = tok.app && (st === 403 || st === 404);
      return send(reply, new AdminError(st === 422 ? 409 : st === 403 ? 403 : 502, 'github_error', (e as Error).message, restricted ? 'owner' : 'name', restricted ? 'grant this app access to the organization, then retry' : app ? 'create the repository on GitHub, install Mandate on it, then refresh the list' : undefined));
    }
  });

  app.post('/ui/projects', async (req, reply) => {
    const login = await post(req, reply);
    if (!login) return reply;
    // `Accept: application/x-ndjson`: stream progress lines `{ step, status }`, then `{ project }` or `{ error }`.
    if (String(req.headers.accept ?? '').includes('application/x-ndjson')) {
      reply.hijack();
      const res = reply.raw;
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store' });
      const line = (o: unknown) => res.write(`${JSON.stringify(o)}\n`);
      try {
        const project = await createProject(deps, login, req.body, (step, status) => line({ step, status }));
        line({ project });
      } catch (e) {
        const err = e instanceof AdminError ? { code: e.code, message: e.message, ...(e.path ? { path: e.path } : {}), ...(e.hint ? { hint: e.hint } : {}) } : { code: 'internal', message: (e as Error).message };
        line({ error: err });
      }
      res.end();
      return;
    }
    try {
      const project = await createProject(deps, login, req.body);
      return reply.code(201).send({ project });
    } catch (e) {
      return send(reply, e);
    }
  });
}

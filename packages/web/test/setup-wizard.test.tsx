// @vitest-environment jsdom
/** The first-run wizard: GitHub App → Git → Ask models → Semantic search → Database → Sign in (the person who finishes is the first admin); Settings → Admins. */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AuthStatus } from '../src/auth';
import { submitManifest } from '../src/setup/sections';
import { SetupWizard, wizardSteps } from '../src/setup/SetupWizard';
import { installDom, Wrap } from './dom';

beforeAll(installDom);
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/setup');
});

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
const github = (o: Record<string, unknown> = {}) => ({ clientId: null, clientSecretEnv: 'MANDATE_GITHUB_CLIENT_SECRET', clientSecretSet: false, allowedUsers: [], allowedOrgs: [], callbackUrl: null, kind: null, app: null, ...o });
const APP = { kind: 'app', clientId: 'Iv23.x', clientSecretSet: true, app: { id: 1, slug: 'mandate-acme', owner: 'matteo', ownerType: 'User', htmlUrl: 'https://github.com/apps/mandate-acme', installUrl: 'x', privateKeySet: true } };
const CONFIG = (gh: Record<string, unknown>) => ({
  server: { publicUrl: null, bind: '127.0.0.1', port: 4000, trustProxy: false },
  github: github(gh),
  git: { backend: 'embedded', author: { name: 'Mandate', email: 'm@x' }, auth: { sshKeyPath: null, sshPassphraseEnv: null, passphraseSet: false, username: null, tokenEnv: null, tokenSet: false }, autoPush: { enabled: true, debounceSeconds: 10, intervalSeconds: 300 }, system: { version: '2.47.0', userName: null, userEmail: null }, agentAvailable: false, defaultKeys: ['/home/me/.ssh/id_ed25519'] },
  ask: { default: null, models: [] },
  database: { driver: 'sqlite', urlEnv: 'MANDATE_DATABASE_URL', urlSet: false, pooler: 'none', schemaPerProject: true, ssl: null, prepare: null, extensionsSchema: null, pool: { max: 10, idleTimeoutMs: 30000, connectionTimeoutMs: 10000 }, active: 'sqlite' },
  embedding: { provider: 'none', baseUrl: 'http://localhost:11434/v1', model: 'nomic-embed-text', dimensions: 768, apiKeyEnv: null, apiKeySet: false, preset: null, requestDimensions: null, maxInputTokens: 2048, batchSize: 32, documentPrefix: '', queryPrefix: '', remote: false },
});
const status = { authenticated: false, user: null, configured: false, missing: [], callbackUrl: null, loginUrl: '/auth/github/login', setupAccess: true, repoAuth: true } as unknown as AuthStatus;

type Call = { url: string; method: string; body: unknown };
/** A fake server: PUT /ui/setup/config merges the patch, PUT /ui/setup/secret marks the env var set. */
function mount(gh: Record<string, unknown>, o: { calls?: Call[]; config?: (c: ReturnType<typeof CONFIG>) => void; routes?: Record<string, (b: any) => unknown> } = {}) {
  const calls = o.calls ?? [];
  const cfg = CONFIG(gh) as any;
  o.config?.(cfg);
  const secrets = new Set<string>(cfg.ask.models.filter((m: any) => m.apiKeySet).map((m: any) => m.apiKeyEnv));
  const view = () => ({ ...cfg, ask: { ...cfg.ask, models: cfg.ask.models.map((m: any) => ({ ...m, apiKeySet: !!m.apiKeyEnv && secrets.has(m.apiKeyEnv) })) } });
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url, method: init?.method ?? 'GET', body });
    if (url === '/ui/setup/state') return json({ complete: false, configVersion: 'v1', config: view() });
    if (url === '/ui/setup/github/manifest') return json({ action: 'https://github.com/settings/apps/new?state=s', manifest: '{}', state: 's' });
    if (url === '/ui/setup/secret') {
      if (body.value) secrets.add(body.name);
      else secrets.delete(body.name);
      return json({ name: body.name, set: !!body.value });
    }
    if (url === '/ui/setup/config') {
      for (const [k, v] of Object.entries(body.patch as Record<string, any>)) {
        if (k === 'git') cfg.git = { ...cfg.git, ...v, ...(v.auth ? { auth: { ...cfg.git.auth, ...v.auth } } : {}), ...(v.autoPush ? { autoPush: { ...cfg.git.autoPush, ...v.autoPush } } : {}) };
        else cfg[k] = { ...cfg[k], ...v };
      }
      return json({ configVersion: 'v2' });
    }
    const r = o.routes?.[url];
    if (r) return json(r(body));
    return json({ error: { code: 'not_found', message: 'not found' } }, 404);
  });
  render(
    <Wrap>
      <SetupWizard status={status} />
    </Wrap>,
  );
  return calls;
}
const patches = (calls: Call[]) => calls.filter((c) => c.url === '/ui/setup/config').map((c) => (c.body as { patch: Record<string, any> }).patch);
const next = () => fireEvent.click(screen.getByTestId('wz-next'));
const toStep = async (id: string, n: number) => {
  await screen.findByTestId('wz-github-created');
  for (const s of ['wz-git', 'wz-ask', 'wz-search', 'wz-database', 'wz-ready'].slice(0, n)) {
    if (s !== 'wz-git') fireEvent.click(screen.getByTestId(s === 'wz-search' || s === 'wz-database' || s === 'wz-ready' ? 'wz-skip' : 'wz-next'));
    else next();
    await screen.findByTestId(s);
  }
  return screen.getByTestId(id);
};

describe('setup wizard', () => {
  it('six steps in a rail (required / optional / become the admin), progress, phone segments; Continue waits for the app', async () => {
    expect(wizardSteps().map((s) => s.id)).toEqual(['github', 'git', 'ask', 'search', 'database', 'ready']);
    mount({});
    await screen.findByTestId('wz-github');
    const steps = [...document.querySelectorAll('.wz-step')];
    expect(steps.map((s) => s.querySelector('.wz-step-label')!.textContent)).toEqual(['GitHub App', 'Git', 'Ask models', 'Semantic search', 'Database', 'Sign in']);
    expect(steps.map((s) => s.querySelector('.wz-step-meta')!.textContent)).toEqual(['Required', 'Required', 'Optional', 'Optional', 'Optional', 'Become the admin']);
    expect(steps[0]!.getAttribute('data-state')).toBe('current');
    expect(screen.getByTestId('wz-progress').textContent).toBe('0 of 6');
    expect(screen.getByTestId('wz-phone-progress').querySelectorAll('i')).toHaveLength(6);
    expect(screen.getByTestId('wz-phone-progress').querySelector('i[data-state=current]')).toBeTruthy();
    expect(screen.getAllByText('Step 1 of 6')).toHaveLength(2); // eyebrow + phone header
    expect(document.body.textContent).not.toMatch(/callback|https?:\/\/localhost|\bmode\b|Just me|this computer|Claude/i);
    expect(screen.getByTestId('wz-next').hasAttribute('disabled')).toBe(true);
    expect(screen.queryByTestId('wz-back')).toBeNull();
  });

  it('GitHub step: tabs My account | An organization | Existing OAuth App; org validated inline', async () => {
    const submit = vi.spyOn(HTMLFormElement.prototype, 'submit').mockImplementation(() => undefined);
    const calls = mount({});
    fireEvent.click(await screen.findByText('An organization'));
    expect(screen.getByTestId('wz-owner-hint').textContent).toMatch(/your organization/);
    fireEvent.change(screen.getByTestId('wz-org'), { target: { value: 'not a valid org!' } });
    expect(screen.getByText(/organization’s GitHub URL/)).toBeTruthy();
    expect(screen.getByTestId('wz-create-app').hasAttribute('disabled')).toBe(true);
    fireEvent.change(screen.getByTestId('wz-org'), { target: { value: 'acme' } });
    fireEvent.click(screen.getByTestId('wz-create-app'));
    await waitFor(() => expect(submit).toHaveBeenCalled());
    expect(calls.find((c) => c.url === '/ui/setup/github/manifest')!.body).toEqual({ owner: 'acme' });
    document.querySelector('form')?.remove();
    // The existing OAuth App form stays: client ID, secret (write-only), test.
    fireEvent.click(screen.getByText('Existing OAuth App'));
    expect(screen.getByTestId('oauth-app')).toBeTruthy();
    expect(screen.getByTestId('gh-client-id')).toBeTruthy();
    expect(screen.getByTestId('gh-test')).toBeTruthy();
  });

  it('created app → Git (no author fields; built-in pushes with the app) → skip Ask + search → SQLite → summary with "Skipped"', async () => {
    const calls = mount(APP);
    expect((await screen.findByTestId('wz-github-created')).textContent).toMatch(/mandate-acme · owned by matteo/);
    expect(document.querySelector('.wz-step')!.querySelector('.wz-step-meta')!.textContent).toBe('mandate-acme · matteo');
    next();
    await screen.findByTestId('wz-git');
    expect(screen.getByTestId('wz-git-hint').textContent).toBe('Uses the git installed on this server.');
    expect(screen.getByText('git 2.47.0')).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/Commit author|Proposal/i);
    // Rail: GitHub done with its summary; progress 1 of 6.
    expect(document.querySelector('.wz-step')!.getAttribute('data-state')).toBe('done');
    expect(screen.getByTestId('wz-progress').textContent).toBe('1 of 6');
    fireEvent.click(screen.getByText('Built-in git'));
    expect(screen.getByText('Pushes with the GitHub App')).toBeTruthy();
    expect(screen.getByText('No key needed.')).toBeTruthy();
    fireEvent.click(screen.getByTestId('wz-git-advanced'));
    fireEvent.click(screen.getByTestId('wz-push-key'));
    expect((screen.getByTestId('wz-ssh-key') as HTMLInputElement).value).toBe('/home/me/.ssh/id_ed25519');
    expect(screen.getByTestId('wz-push-agent').hasAttribute('disabled')).toBe(true);
    fireEvent.click(screen.getByText('System git'));
    fireEvent.click(screen.getByTestId('wz-autopush'));
    next();
    await screen.findByTestId('wz-ask');
    expect(patches(calls)[0]).toEqual({ git: { backend: 'cli', autoPush: { enabled: false } } });
    // Ask models: empty state, Skip for now.
    expect(screen.getByTestId('ask-empty').textContent).toMatch(/No models yet/);
    fireEvent.click(screen.getByTestId('wz-skip'));
    await screen.findByTestId('wz-search');
    expect(document.querySelectorAll('.wz-step')[2]!.getAttribute('data-state')).toBe('skipped');
    expect(document.querySelectorAll('.wz-step')[2]!.querySelector('.wz-step-meta')!.textContent).toBe('Skipped');
    fireEvent.click(screen.getByTestId('wz-skip'));
    // Database: SQLite by default; Postgres needs the URL and a passing test.
    await screen.findByTestId('wz-database');
    expect(screen.getByTestId('wz-db-hint').textContent).toMatch(/Nothing to set up/);
    expect(screen.queryByTestId('wz-skip')).toBeNull();
    fireEvent.click(screen.getByText('Postgres'));
    expect(screen.getByTestId('wz-db-url').textContent).toContain('Connection URL');
    expect(screen.getByTestId('wz-skip')).toBeTruthy();
    next();
    expect((await screen.findByTestId('wz-db-error')).textContent).toMatch(/Save the connection URL first/);
    fireEvent.click(screen.getByText('SQLite (built in)'));
    next();
    await screen.findByTestId('wz-ready');
    const sum = screen.getByTestId('setup-summary').textContent!;
    expect(sum).toContain('mandate-acme');
    expect(sum).toContain('System git 2.47.0 · auto-push off');
    expect(sum).toContain('SQLite (built in)');
    expect(sum).toContain('Keyword search only');
    expect(sum.match(/Skipped/g)).toHaveLength(2);
    expect(screen.getByTestId('wz-admin-note').textContent).toBe("You'll be the admin. Add more admins later in Settings.");
    expect(screen.getByTestId('setup-signin').textContent).toContain('Sign in with GitHub');
    expect(screen.getByTestId('wz-progress').textContent).toBe('5 of 6');
  });

  it('built-in git: auth.method "app" by default, "ssh" with a key (when the server reports auth.method)', async () => {
    const calls = mount(APP, { config: (c) => Object.assign(c.git.auth, { method: 'ssh', sshKeyPath: '/k' }) });
    await screen.findByTestId('wz-github-created');
    next();
    await screen.findByTestId('wz-git');
    fireEvent.click(screen.getByText('Built-in git'));
    // Saved as ssh with a key: Advanced is open and the key is chosen.
    expect((screen.getByTestId('wz-ssh-key') as HTMLInputElement).value).toBe('/k');
    fireEvent.click(screen.getByTestId('wz-push-app'));
    next();
    await screen.findByTestId('wz-ask');
    expect(patches(calls)[0]).toEqual({ git: { auth: { method: 'app' } } });
  });

  it('Ask models: add many (key write-only), make default, edit, remove; Continue saves nothing else', async () => {
    const calls = mount(APP, {
      routes: {
        '/ui/setup/ask/models': () => ({ ok: true, models: ['claude-sonnet-5-5', 'claude-haiku-5-5'], suggested: 'claude-sonnet-5-5', message: '2 models' }),
        '/ui/setup/ask/test': () => ({ ok: true, message: 'ok', ms: 900 }),
      },
    });
    await toStep('wz-ask', 2);
    fireEvent.click(screen.getByTestId('add-model-open'));
    // Anthropic preselected; key variable suggested; the key is write-only.
    expect((screen.getByTestId('wz-ask-keyenv') as HTMLInputElement).value).toBe('ANTHROPIC_API_KEY');
    expect(screen.getByText('Suggested')).toBeTruthy();
    fireEvent.change(screen.getByTestId('wz-ask-key'), { target: { value: 'sk-ant-secret' } });
    fireEvent.click(screen.getByTestId('wz-ask-model-load'));
    expect(await screen.findByText('2 models loaded')).toBeTruthy();
    await waitFor(() => expect((screen.getByTestId('wz-ask-model') as HTMLInputElement).value).toBe('claude-sonnet-5-5'));
    fireEvent.click(screen.getByTestId('wz-ask-test'));
    expect((await screen.findByTestId('wz-result')).textContent).toMatch(/It works.*replied in 0\.9 s/);
    fireEvent.click(screen.getByTestId('add-model-submit'));
    await screen.findByTestId('model-anthropic-claude-sonnet-5-5');
    expect(calls.find((c) => c.url === '/ui/setup/secret')!.body).toEqual({ name: 'ANTHROPIC_API_KEY', value: 'sk-ant-secret' });
    expect(screen.getByTestId('model-anthropic-claude-sonnet-5-5').textContent).toMatch(/Key saved.*Default/);
    // A second model: an OpenAI-compatible URL, typed model name, no key.
    fireEvent.click(screen.getByTestId('add-model-open'));
    fireEvent.click(screen.getByTestId('wz-ask-compatible'));
    fireEvent.change(screen.getByTestId('wz-ask-base'), { target: { value: 'http://localhost:11434/v1' } });
    expect((screen.getByTestId('wz-ask-keyenv') as HTMLInputElement).value).toBe('');
    fireEvent.change(screen.getByTestId('wz-ask-model'), { target: { value: 'llama3.1' } });
    fireEvent.click(screen.getByTestId('add-model-submit'));
    await screen.findByTestId('model-compatible-llama3-1');
    expect(screen.getByTestId('ask-count').textContent).toBe('2 models');
    expect(screen.getByTestId('model-compatible-llama3-1').textContent).toMatch(/localhost:11434.*No key/);
    // Make default, then remove the old default.
    fireEvent.click(screen.getByTestId('make-default-compatible-llama3-1'));
    await waitFor(() => expect(screen.getByTestId('model-compatible-llama3-1').textContent).toContain('Default'));
    fireEvent.click(screen.getByTestId('remove-anthropic-claude-sonnet-5-5'));
    await waitFor(() => expect(screen.queryByTestId('model-anthropic-claude-sonnet-5-5')).toBeNull());
    expect(screen.getByTestId('ask-count').textContent).toBe('1 model');
    const last = patches(calls).filter((p) => p.ask).at(-1)!;
    expect(last).toEqual({ ask: { models: [{ id: 'compatible-llama3-1', provider: 'openai-compatible', model: 'llama3.1', baseUrl: 'http://localhost:11434/v1', apiKeyEnv: null }], default: 'compatible-llama3-1' } });
    // Edit opens the panel with the model.
    fireEvent.click(screen.getByTestId('edit-compatible-llama3-1'));
    expect((screen.getByTestId('wz-ask-model') as HTMLInputElement).value).toBe('llama3.1');
    // Continue with the panel open asks to add or close first.
    next();
    expect(screen.getByText(/Press “Add model” to keep this model/)).toBeTruthy();
    fireEvent.click(screen.getByTestId('add-model-close'));
    next();
    await screen.findByTestId('wz-search');
    expect(document.querySelectorAll('.wz-step')[2]!.querySelector('.wz-step-meta')!.textContent).toBe('1 model');
    // Keys never travel in config patches.
    expect(JSON.stringify(patches(calls))).not.toMatch(/sk-ant|apiKey"/);
  });

  it('Semantic search: a key shared with an Ask model shows "Saved"; Test detects the size; saved with the env var name only', async () => {
    const calls = mount(APP, {
      config: (c) => {
        c.ask = { default: 'openai-gpt-6-luna', models: [{ id: 'openai-gpt-6-luna', provider: 'openai', model: 'gpt-6-luna', baseUrl: null, apiKeyEnv: 'OPENAI_API_KEY', apiKeySet: true }] } as never;
      },
      routes: {
        '/ui/setup/embedding/keys': () => ({ candidates: [{ askModelId: 'openai-gpt-6-luna', label: 'gpt-6-luna', apiKeyEnv: 'OPENAI_API_KEY', apiKeySet: true }], apiKeyEnvSet: true }),
        '/ui/setup/embedding/models': () => ({ ok: true, models: [{ id: 'text-embedding-3-small', pricePerMTok: 0.02, known: true }], suggested: 'text-embedding-3-small', total: 1, message: '' }),
        '/ui/setup/embedding/test': () => ({ ok: true, dimensions: 1536, ms: 120, message: 'ok', preset: {} }),
        '/ui/setup/embedding/estimate': () => ({ chunks: 10, tokens: 1000, avgTokens: 100, costUsd: 0.02, pricePerMTok: 0.02, projects: [] }),
        '/ui/setup/embedding/preset': () => ({ family: 'openai', documentPrefix: '', queryPrefix: '', maxInputTokens: 8191, batchSize: 64, known: true }),
        '/ui/setup/embedding/detect': () => ({ ollama: false, baseUrl: 'http://localhost:11434/v1', models: [], hasNomic: false, install: [] }),
      },
    });
    await screen.findByTestId('wz-github-created');
    next();
    await screen.findByTestId('wz-git');
    next();
    await screen.findByTestId('wz-ask');
    expect(screen.getByTestId('model-list').textContent).toContain('gpt-6-luna');
    next();
    await screen.findByTestId('wz-search');
    // OpenAI preselected because its key is already saved for gpt-6-luna.
    expect(screen.getByTestId('wz-emb-openai').getAttribute('aria-checked')).toBe('true');
    expect(await screen.findByTestId('wz-embed-saved')).toBeTruthy();
    expect(screen.getByText(/Already saved for gpt-6-luna/)).toBeTruthy();
    expect(screen.queryByTestId('wz-embed-key')).toBeNull();
    expect((await screen.findByTestId('wz-cost')).textContent).toMatch(/about \$0\.02 once/);
    fireEvent.click(screen.getByTestId('wz-embed-test'));
    expect((await screen.findByTestId('wz-result')).textContent).toMatch(/It works.*1,536 dimensions detected/);
    next();
    await screen.findByTestId('wz-database');
    expect(patches(calls).find((p) => p.embedding)).toEqual({
      embedding: { provider: 'openai-compatible', preset: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'text-embedding-3-small', apiKeyEnv: 'OPENAI_API_KEY', dimensions: 1536, requestDimensions: null, documentPrefix: '', queryPrefix: '', maxInputTokens: 8191, batchSize: 64 },
    });
    expect(calls.some((c) => c.url === '/ui/setup/secret')).toBe(false);
  });

  it('Semantic search: Ollama with nomic-embed-text needs no key or test (768 dimensions)', async () => {
    const calls = mount(APP, { routes: { '/ui/setup/embedding/detect': () => ({ ollama: true, baseUrl: 'http://localhost:11434/v1', models: ['nomic-embed-text'], hasNomic: true, install: [] }), '/ui/setup/embedding/preset': () => { throw new Error('x'); } } });
    await toStep('wz-search', 3);
    expect(screen.getByTestId('wz-emb-ollama').getAttribute('aria-checked')).toBe('true');
    expect((await screen.findByTestId('wz-ollama-status')).textContent).toMatch(/nomic-embed-text is installed/);
    next();
    await screen.findByTestId('wz-database');
    expect(patches(calls).find((p) => p.embedding)).toMatchObject({ embedding: { preset: 'ollama', model: 'nomic-embed-text', apiKeyEnv: null, dimensions: 768 } });
  });

  it('submitManifest POSTs the manifest as a top-level form', () => {
    const submit = vi.spyOn(HTMLFormElement.prototype, 'submit').mockImplementation(() => undefined);
    submitManifest('https://github.com/settings/apps/new?state=abc', '{"name":"Mandate"}');
    const form = document.querySelector('form')!;
    expect(form.method).toBe('post');
    expect((form.querySelector('input[name=manifest]') as HTMLInputElement).value).toBe('{"name":"Mandate"}');
    expect(submit).toHaveBeenCalled();
    form.remove();
  });
});

describe('Settings → Admins', () => {
  it('lists admins with avatars; adding looks the login up on GitHub and shows who it is first', async () => {
    const { AccessSection } = await import('../src/setup/sections');
    vi.stubGlobal('fetch', async (url: string) => (url === '/ui/github/users/octocat' ? json({ login: 'octocat', name: 'The Octocat', avatarUrl: 'https://avatars.example/octocat' }) : json({ error: { code: 'not_found', message: "no GitHub user 'nobody'" } }, 404)));
    const state = { complete: true, configVersion: 'v1', config: { server: { publicUrl: null, bind: '127.0.0.1', port: 4000, trustProxy: false }, github: github({ allowedUsers: ['matteo'] }) } } as never;
    render(
      <Wrap>
        <AccessSection state={state} variant="settings" register={() => undefined} />
      </Wrap>,
    );
    const list = screen.getByTestId('admins');
    expect(list.textContent).toContain('matteo');
    expect(list.querySelector('img')!.getAttribute('src')).toContain('avatars.githubusercontent.com/matteo');
    expect(document.body.textContent).not.toMatch(/Press Enter/);
    fireEvent.change(screen.getByTestId('admin-login'), { target: { value: 'octocat' } });
    const found = await screen.findByTestId('admin-found', {}, { timeout: 2000 });
    expect(found.textContent).toContain('The Octocat');
    expect(found.querySelector('img')!.getAttribute('src')).toBe('https://avatars.example/octocat');
    fireEvent.click(screen.getByTestId('admin-add-btn'));
    await waitFor(() => expect(screen.getByTestId('admins').textContent).toContain('octocat'));
    fireEvent.change(screen.getByTestId('admin-login'), { target: { value: 'nobody' } });
    expect(await screen.findByText(/No GitHub user/, {}, { timeout: 2000 })).toBeTruthy();
  });
});

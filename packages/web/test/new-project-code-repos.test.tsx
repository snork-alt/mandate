// @vitest-environment jsdom
/** New project: Details → Specs repository (+ Branch) → Confirm, no code repositories; Settings → Code repositories (auto-registered, optional). */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { NewProjectModal } from '../src/connect/NewProjectModal';
import { CodeReposSection } from '../src/setup/CodeReposSection';
import { installDom, Wrap } from './dom';

beforeAll(() => {
  installDom();
  // Mantine's autosize Textarea listens to font loading (missing in jsdom).
  (document as unknown as { fonts?: unknown }).fonts ??= { addEventListener() {}, removeEventListener() {} };
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

const repo = (name: string, description = '') => ({ fullName: `acme/${name}`, owner: 'acme', name, private: true, defaultBranch: 'main', pushedAt: null, empty: false, description, ownerAvatarUrl: null });
const LIST = {
  scopes: ['repo'],
  needsScope: null,
  upgradeUrl: '',
  upgradeUrlPublic: '',
  owners: [{ login: 'acme', name: 'Acme', avatarUrl: null, type: 'org', canCreateRepos: true, restricted: false }],
  items: [repo('product-specs', 'Specs'), repo('web-app'), repo('api'), repo('mobile')],
  app: { slug: 'mandate', installUrl: 'https://github.com/apps/mandate/installations/new' },
};

function serve(extra: (method: string, url: string, body: unknown) => unknown = () => undefined) {
  const calls: { method: string; url: string; body?: any }[] = [];
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, url, body });
    const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
    const x = extra(method, url, body);
    if (x !== undefined) return json(x);
    if (url.startsWith('/ui/github/repos')) return json(LIST);
    if (url === '/ui/projects' && method === 'POST') return json({ project: { id: 'checkout', name: 'Checkout' } }, 201);
    return json({});
  });
  return calls;
}

async function toConfirm() {
  render(<NewProjectModal opened onClose={() => undefined} />, { wrapper: Wrap });
  fireEvent.change(await screen.findByLabelText('Name'), { target: { value: 'Checkout' } });
  fireEvent.click(screen.getByTestId('new-project-next'));
  fireEvent.click(await screen.findByTestId('repo-acme/product-specs'));
  expect((screen.getByTestId('specs-branch') as HTMLInputElement).value).toBe('main');
  expect(screen.queryByLabelText('Folder')).toBeNull();
  fireEvent.click(screen.getByTestId('new-project-next'));
}

describe('New project dialog', () => {
  it('has three steps and no code repositories step', async () => {
    serve();
    render(<NewProjectModal opened onClose={() => undefined} />, { wrapper: Wrap });
    const steps = await screen.findByLabelText('Step 1 of 3');
    expect(steps.textContent).toBe('1Details2Specs repository3Confirm');
  });

  it('creates a project with the data repo only (no codeRepos in the request)', async () => {
    const calls = serve();
    await toConfirm();
    expect(screen.queryByTestId('summary-code-repos')).toBeNull();
    fireEvent.click(screen.getByTestId('new-project-create'));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.url.startsWith('/ui/projects'))).toBe(true));
    const post = calls.find((c) => c.method === 'POST' && c.url.startsWith('/ui/projects'))!;
    expect(post.body).toMatchObject({ name: 'Checkout', repo: 'acme/product-specs' });
    expect(post.body).not.toHaveProperty('codeRepos');
  });

  it('restores the form after the GitHub round trip', async () => {
    serve();
    const { stashDraft } = await import('../src/connect/newProjectDraft');
    const nonce = stashDraft({ name: 'Checkout', id: 'checkout', idTouched: false, description: '', repo: null, branch: '', owner: 'all' }, 1);
    render(<NewProjectModal opened resume={nonce} onClose={() => undefined} />, { wrapper: Wrap });
    expect(await screen.findByTestId('repo-acme/product-specs')).toBeTruthy(); // on the specs repository step, name kept
    fireEvent.click(screen.getByTestId('repo-acme/product-specs'));
    fireEvent.click(screen.getByTestId('new-project-next'));
    expect(screen.getByTestId('new-project-create')).toBeTruthy();
    expect(screen.getByText('Checkout')).toBeTruthy();
  });
});

describe('Settings → Code repositories', () => {
  const state = (admin: boolean) => ({
    admin,
    projects: [
      {
        id: 'web',
        name: 'Web',
        specsRepo: 'acme/product-specs',
        codeRepos: [
          { name: 'web-app', auto: true, registeredBy: 'claude-code', registeredAt: '2026-11-01T10:00:00Z' },
          { name: 'api', remote: 'https://github.com/acme/api.git' },
        ],
        unlinked: [],
      },
    ],
  });

  it('admins rename, set a remote URL, remove and save', async () => {
    const calls = serve((method, url, body) => (url.startsWith('/ui/code-repos') ? (method === 'GET' ? state(true) : { ...state(true).projects[0], codeRepos: (body as { codeRepos: unknown[] }).codeRepos }) : undefined));
    render(<CodeReposSection state={{} as never} register={() => undefined} variant="settings" />, { wrapper: Wrap });
    expect(((await screen.findByTestId('code-repo-name-web-app')) as HTMLInputElement).value).toBe('web-app');
    expect(screen.getByTestId('code-repo-by-web-app').textContent).toContain('registered by claude-code on 2026-11-01');
    fireEvent.change(screen.getByTestId('code-repo-remote-web-app'), { target: { value: 'https://tok@github.com/acme/web-app.git' } });
    fireEvent.change(screen.getByTestId('code-repo-name-web-app'), { target: { value: 'web' } });
    fireEvent.click(screen.getByTestId('code-repo-remove-api'));
    fireEvent.click(screen.getByTestId('code-repos-save-web'));
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
    expect(calls.find((c) => c.method === 'PUT')).toMatchObject({
      url: '/ui/code-repos/web',
      body: { codeRepos: [{ name: 'web', remote: 'https://github.com/acme/web-app.git', auto: true, registeredBy: 'claude-code', registeredAt: '2026-11-01T10:00:00Z' }] },
    });
  });

  it('refuses a malformed short name or remote, and is read-only for non-admins', async () => {
    serve((method, url) => (url.startsWith('/ui/code-repos') ? state(true) : undefined));
    const { unmount } = render(<CodeReposSection state={{} as never} register={() => undefined} variant="settings" />, { wrapper: Wrap });
    const nameInput = await screen.findByTestId('code-repo-name-web-app');
    fireEvent.change(nameInput, { target: { value: 'Web App' } });
    expect((screen.getByTestId('code-repos-save-web') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(nameInput, { target: { value: 'web-app' } });
    fireEvent.change(screen.getByTestId('code-repo-remote-api'), { target: { value: 'nonsense' } });
    expect((screen.getByTestId('code-repos-save-web') as HTMLButtonElement).disabled).toBe(true);
    unmount();
    serve((method, url) => (url.startsWith('/ui/code-repos') ? state(false) : undefined));
    render(<CodeReposSection state={{} as never} register={() => undefined} variant="settings" />, { wrapper: Wrap });
    expect(((await screen.findByTestId('code-repo-name-web-app')) as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByText('Only Mandate admins change code repositories.')).toBeTruthy();
  });
});

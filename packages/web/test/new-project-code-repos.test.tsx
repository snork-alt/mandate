// @vitest-environment jsdom
/** New project: Details → Specs repository (+ Branch, no Folder) → Code repositories → Confirm; Settings → Code repositories. */
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

async function toCodeRepos() {
  render(<NewProjectModal opened onClose={() => undefined} />, { wrapper: Wrap });
  fireEvent.change(await screen.findByLabelText('Name'), { target: { value: 'Checkout' } });
  fireEvent.click(screen.getByTestId('new-project-next'));
  expect(screen.getByTestId('specs-dedicated').textContent).toContain('Use a dedicated repository for specs.');
  expect(screen.getByTestId('specs-dedicated').textContent).toContain('Mandate writes to it.');
  fireEvent.click(await screen.findByTestId('repo-acme/product-specs'));
  // Branch is on the specs repository step; the Folder field is gone.
  expect((screen.getByTestId('specs-branch') as HTMLInputElement).value).toBe('main');
  expect(screen.queryByLabelText('Folder')).toBeNull();
  fireEvent.click(screen.getByTestId('new-project-next'));
}

describe('New project dialog', () => {
  it('shows the four steps', async () => {
    serve();
    render(<NewProjectModal opened onClose={() => undefined} />, { wrapper: Wrap });
    const steps = await screen.findByLabelText('Step 1 of 4');
    expect(steps.textContent).toBe('1Details2Specs repository3Code repositories4Confirm');
  });

  it('code repositories: empty state, picker (specs repo disabled), duplicate short name with one-click fix, confirm, create', async () => {
    const calls = serve();
    await toCodeRepos();
    expect(screen.getByTestId('code-repos-readonly').textContent).toContain('Read-only. Mandate only reads these to link specs to code; it never writes to them.');
    expect(screen.getByTestId('code-repos-empty').textContent).toContain('No code repositories yet');
    expect((screen.getByTestId('new-project-next') as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByTestId('code-repo-add'));
    const specs = await screen.findByTestId('pick-acme/product-specs');
    expect(specs.getAttribute('aria-disabled')).toBe('true');
    expect(specs.textContent).toContain('Specs');
    fireEvent.click(specs);
    fireEvent.click(screen.getByTestId('pick-acme/api'));
    fireEvent.click(screen.getByTestId('pick-acme/mobile'));
    expect(screen.getByTestId('code-repo-add-picked').textContent).toBe('Add 2 repositories');
    fireEvent.click(screen.getByTestId('code-repo-add-picked'));

    const rows = screen.getByTestId('code-repo-rows');
    expect(within(rows).getByTestId('code-repo-acme/api').textContent).toContain('Read-only');
    expect((screen.getByTestId('code-repo-name-acme/api') as HTMLInputElement).value).toBe('api');
    fireEvent.change(screen.getByTestId('code-repo-name-acme/mobile'), { target: { value: 'api' } });
    expect(screen.getByTestId('code-repo-error-acme/mobile').textContent).toContain('api is already used by acme/api. Short names must be unique.');
    expect((screen.getByTestId('new-project-next') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId('code-repo-fix-acme/mobile'));
    expect(screen.queryByTestId('code-repo-error-acme/mobile')).toBeNull();
    expect((screen.getByTestId('code-repo-name-acme/mobile') as HTMLInputElement).value).toBe('mobile');
    expect(screen.getByTestId('code-ref-example').textContent).toContain('mandate://code/api/src/auth.ts');

    fireEvent.click(screen.getByTestId('new-project-next'));
    const summary = await screen.findByTestId('summary-code-repos');
    expect(summary.textContent).toContain('api');
    expect(summary.textContent).toContain('acme/mobile@main');
    expect(screen.getByText(/links 2 code repositories \(read-only\)/)).toBeTruthy();
    fireEvent.click(screen.getByTestId('new-project-create'));
    await waitFor(() => expect(calls.some((c) => c.url === '/ui/projects')).toBe(true));
    const body = calls.find((c) => c.url === '/ui/projects')!.body;
    expect(body).toEqual({
      name: 'Checkout',
      repo: 'acme/product-specs',
      branch: 'main',
      codeRepos: [
        { name: 'api', github: 'acme/api', defaultBranch: 'main' },
        { name: 'mobile', github: 'acme/mobile', defaultBranch: 'main' },
      ],
    });
    expect(body.path).toBeUndefined();
  });

  it('skip for now: no code repositories', async () => {
    const calls = serve();
    await toCodeRepos();
    fireEvent.click(screen.getByTestId('code-repos-skip'));
    expect((await screen.findByTestId('summary-code-repos')).textContent).toContain('None yet');
    fireEvent.click(screen.getByTestId('new-project-create'));
    await waitFor(() => expect(calls.some((c) => c.url === '/ui/projects')).toBe(true));
    expect(calls.find((c) => c.url === '/ui/projects')!.body.codeRepos).toBeUndefined();
  });
});

describe('Settings → Code repositories', () => {
  const state = (admin: boolean) => ({
    admin,
    projects: [{ id: 'web', name: 'Web', specsRepo: 'acme/product-specs', codeRepos: [{ name: 'web-app', github: 'acme/web-app', defaultBranch: 'main' }], unlinked: [{ name: 'api', uses: 3 }] }],
  });

  it('admins rename, link unregistered names and save', async () => {
    const calls = serve((method, url, body) => (url.startsWith('/ui/code-repos') ? (method === 'GET' ? state(true) : { ...state(true).projects[0], codeRepos: (body as { codeRepos: unknown[] }).codeRepos, unlinked: [] }) : undefined));
    render(<CodeReposSection state={{} as never} register={() => undefined} variant="settings" />, { wrapper: Wrap });
    expect((await screen.findByTestId('code-repo-name-acme/web-app') as HTMLInputElement).value).toBe('web-app');
    expect(screen.getByTestId('code-repos-unlinked-web').textContent).toContain('3 references');
    fireEvent.click(screen.getByTestId('code-repo-link-api'));
    fireEvent.click(await screen.findByTestId('pick-acme/api'));
    fireEvent.click(screen.getByTestId('code-repo-add-picked'));
    expect((screen.getByTestId('code-repo-name-acme/api') as HTMLInputElement).value).toBe('api');
    expect(screen.queryByTestId('code-repos-unlinked-web')).toBeNull();
    fireEvent.change(screen.getByTestId('code-repo-name-acme/web-app'), { target: { value: 'web' } });
    fireEvent.click(screen.getByTestId('code-repos-save-web'));
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
    expect(calls.find((c) => c.method === 'PUT')).toMatchObject({ url: '/ui/code-repos/web', body: { codeRepos: [{ name: 'web', github: 'acme/web-app', defaultBranch: 'main' }, { name: 'api', github: 'acme/api', defaultBranch: 'main' }] } });
  });

  it('read-only for non-admins', async () => {
    serve((method, url) => (url.startsWith('/ui/code-repos') ? state(false) : undefined));
    render(<CodeReposSection state={{} as never} register={() => undefined} variant="settings" />, { wrapper: Wrap });
    expect((await screen.findByTestId('code-repo-name-acme/web-app') as HTMLInputElement).readOnly).toBe(true);
    expect(screen.queryByTestId('code-repo-add')).toBeNull();
    expect(screen.queryByTestId('code-repo-link-api')).toBeNull();
    expect(screen.getByText('Only Mandate admins change code repositories.')).toBeTruthy();
  });
});

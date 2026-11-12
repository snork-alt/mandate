// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, useNavigate } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AskProvider } from '../src/components/ask/AskProvider';
import { Rail } from '../src/components/rail/Rail';
import { RailProvider } from '../src/components/rail/RailProvider';
import { RAIL_DEFAULT, RAIL_MAX, RAIL_MIN, clampWidth, loadTabs, loadWidth, saveWidth } from '../src/components/rail/persistence';
import type { ActivityEvent } from '../src/components/activity/types';
import type { AskStatus } from '../src/mcp/queries';
import { MantineProvider } from '@mantine/core';
import { installDom } from './dom';

installDom();

let status: AskStatus = { configured: true, default: 'm', models: [{ id: 'm', label: 'M', provider: 'anthropic', model: 'm', apiKeySet: true, configured: true, missing: [] }], missing: [] };
function mount(path: string, subscribe: (h: (e: ActivityEvent) => void) => () => void = () => () => undefined, activity: Partial<import('../src/components/rail/RailProvider').ActivityDeps> = {}) {
  const qc = new QueryClient();
  qc.setQueryData(['mcp', 'ask_status', {}], status);
  let go: (p: string) => void = () => undefined;
  const Nav = () => {
    const n = useNavigate();
    go = (p) => void n(p);
    return null;
  };
  render(
    <MantineProvider><QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <RailProvider activity={{ subscribe, list: async () => ({ events: [] }), watchConnection: () => () => undefined, ...activity }}>
          <AskProvider>
            <Nav />
            <Rail />
          </AskProvider>
        </RailProvider>
      </MemoryRouter>
    </QueryClientProvider></MantineProvider>,
  );
  return { go: (p: string) => act(() => go(p)) };
}
const key = (init: KeyboardEventInit) => act(() => void window.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })));
const selected = () => screen.getAllByRole('tab').filter((t) => t.getAttribute('aria-selected') === 'true' && t.className.includes('rail-tab')).map((t) => t.getAttribute('aria-label'));
const collapsed = () => document.querySelector('.rail')!.getAttribute('data-collapsed') === 'true';
const ev = (n: number): ActivityEvent => ({ id: `s${n}:0`, commit: `s${n}`, type: 'spec.updated', at: new Date().toISOString(), refs: ['mandate://specs/a'], summary: `event ${n}` }) as ActivityEvent;

beforeEach(() => {
  localStorage.clear();
  status = { configured: true, default: 'm', models: [{ id: 'm', label: 'M', provider: 'anthropic', model: 'm', apiKeySet: true, configured: true, missing: [] }], missing: [] };
});
afterEach(cleanup);

describe('rail tabs and defaults', () => {
  it('opens Details on document pages and Activity on list pages', () => {
    mount('/specs/login-sso');
    expect(selected()).toEqual(['Details']);
    cleanup();
    mount('/specs');
    expect(selected()).toEqual(['Activity']);
    expect(screen.queryByRole('tab', { name: 'Details' })).toBeNull();
    expect(screen.getByTestId('activity-empty').textContent).toContain('Live agent activity will appear here');
  });
  it('remembers the last tab per page type', () => {
    const { go } = mount('/specs/a');
    fireEvent.click(screen.getByRole('tab', { name: 'Ask' }));
    expect(loadTabs()).toEqual({ doc: 'ask' });
    go('/specs');
    expect(selected()).toEqual(['Activity']);
    go('/standards/b');
    expect(selected()).toEqual(['Ask']);
  });
});

describe('shortcuts', () => {
  it('Cmd+J shows Ask, again collapses; Cmd+Shift+A does the same for Activity', () => {
    mount('/specs/a');
    key({ key: 'j', metaKey: true });
    expect(selected()).toEqual(['Ask']);
    key({ key: 'j', ctrlKey: true });
    expect(collapsed()).toBe(true);
    key({ key: 'A', metaKey: true, shiftKey: true });
    expect(collapsed()).toBe(false);
    expect(selected()).toEqual(['Activity']);
    key({ key: 'A', metaKey: true, shiftKey: true });
    expect(collapsed()).toBe(true);
    fireEvent.click(screen.getByRole('tab', { name: 'Ask' }));
    expect(collapsed()).toBe(false);
  });
  it('Escape inside the rail collapses it', () => {
    mount('/specs');
    fireEvent.keyDown(screen.getByRole('tab', { name: 'Ask' }), { key: 'Escape' });
    expect(collapsed()).toBe(true);
  });
});

describe('activity unread badge', () => {
  it('counts events while Activity is hidden and clears when shown', () => {
    let push: (e: ActivityEvent) => void = () => undefined;
    mount('/specs/a', (h) => ((push = h), () => undefined));
    act(() => (push(ev(1)), push(ev(2))));
    expect(screen.getByLabelText('2 unread')).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: 'Activity' }));
    expect(screen.queryByLabelText(/unread/)).toBeNull();
    expect(screen.getByText('event 2')).toBeTruthy();
    act(() => push(ev(3)));
    expect(screen.queryByLabelText(/unread/)).toBeNull();
    key({ key: 'j', metaKey: true });
    act(() => push(ev(4)));
    expect(screen.getByLabelText('1 unread')).toBeTruthy();
  });
  it('shows events in a collapsed strip too', () => {
    let push: (e: ActivityEvent) => void = () => undefined;
    mount('/specs', (h) => ((push = h), () => undefined));
    key({ key: 'a', metaKey: true, shiftKey: true });
    expect(collapsed()).toBe(true);
    act(() => push(ev(1)));
    expect(screen.getByLabelText('1 unread')).toBeTruthy();
  });
});

describe('width persistence', () => {
  it('clamps to 320-720 and stores it', () => {
    expect(clampWidth(100)).toBe(RAIL_MIN);
    expect(clampWidth(5000)).toBe(RAIL_MAX);
    expect(clampWidth(NaN)).toBe(RAIL_DEFAULT);
    saveWidth(9999);
    expect(loadWidth()).toBe(RAIL_MAX);
    localStorage.setItem('mandate.rail.width', 'junk');
    expect(loadWidth()).toBe(RAIL_DEFAULT);
  });
  it('uses the stored width for every tab', () => {
    saveWidth(500);
    mount('/specs');
    expect(document.querySelector<HTMLElement>('.rail')!.style.getPropertyValue('--rail-w')).toBe('500px');
    fireEvent.click(screen.getByRole('tab', { name: 'Ask' }));
    expect(document.querySelector<HTMLElement>('.rail')!.style.getPropertyValue('--rail-w')).toBe('500px');
  });
});

describe('ask without a configured model', () => {
  it('shows only the configuration message and disables the question box', () => {
    status = { configured: false, default: null, models: [], missing: ['provider', 'model'] };
    mount('/specs/a');
    fireEvent.click(screen.getByRole('tab', { name: 'Ask' }));
    expect(screen.getByText(/configure a model in/)).toBeTruthy();
    expect((screen.getByLabelText('Question') as HTMLTextAreaElement).disabled).toBe(true);
    expect(screen.queryByText(/coding agent/)).toBeNull();
    expect(screen.queryByText('Copy prompt')).toBeNull();
  });
});

describe('ask state across navigation', () => {
  it('keeps the draft and follows the page for context chips', () => {
    const { go } = mount('/specs/a');
    fireEvent.click(screen.getByRole('tab', { name: 'Ask' }));
    fireEvent.change(screen.getByLabelText('Question'), { target: { value: 'why?' } });
    expect(screen.getByTitle(/specs\/a$/)).toBeTruthy();
    go('/standards/b');
    expect((screen.getByLabelText('Question') as HTMLTextAreaElement).value).toBe('why?');
    expect(screen.getByTitle(/standards\/b$/)).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Remove b'));
    expect(screen.queryByTitle(/standards\/b$/)).toBeNull();
  });
});

describe('activity feed backfill, reconnect and pause', () => {
  it('backfills on load and again with since=head after a reconnect', async () => {
    let conn: (c: boolean) => void = () => undefined;
    const list = vi.fn(async (a: { since?: string }) => (a.since ? { events: [ev(2)], head: 'H2' } : { events: [ev(1)], head: 'H1' }));
    mount('/specs', undefined, { list, watchConnection: (h) => ((conn = h), () => undefined) });
    expect(await screen.findByText('event 1')).toBeTruthy();
    act(() => conn(true));
    act(() => conn(false));
    act(() => conn(true));
    expect(await screen.findByText('event 2')).toBeTruthy();
    expect(list).toHaveBeenLastCalledWith({ since: 'H1', limit: 100 });
    expect(screen.getByText('Live')).toBeTruthy();
  });
  it('pause buffers live events until resumed', async () => {
    let push: (e: ActivityEvent) => void = () => undefined;
    mount('/specs', (h) => ((push = h), () => undefined), { list: async () => ({ events: [ev(1)] }) });
    await screen.findByText('event 1');
    fireEvent.click(screen.getByText('Pause'));
    act(() => push(ev(2)));
    expect(screen.queryByText('event 2')).toBeNull();
    fireEvent.click(screen.getByText(/Resume · 1 new/));
    expect(screen.getByText('event 2')).toBeTruthy();
  });
});

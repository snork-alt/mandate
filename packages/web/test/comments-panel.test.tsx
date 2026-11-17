// @vitest-environment jsdom
/**
 * Comments side panel: threads with the active one expanded, resolved ones collapsed, reply box (to whom, Make it a
 * request, Resolve, Send), "is replying", mention autocomplete, the New thread box with the agent picker, the margin
 * badge states and the selection button.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MantineProvider } from '@mantine/core';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { CommentThread } from '@mandate/shared';
import { installDom } from './dom';
import { CommentsPanel } from '../src/components/comments/CommentsPanel';
import { CommentBadge, SelectionComment } from '../src/components/comments/CommentBadge';
import { RailCtx } from '../src/components/rail/railContext';
import { clearCommentFocus, setCommentFocus } from '../src/lib/comments';

beforeAll(() => {
  installDom();
  // Mantine's autosize Textarea listens to font loading.
  (document as unknown as { fonts: unknown }).fonts ??= { addEventListener() {}, removeEventListener() {}, ready: Promise.resolve() };
});

const DOC = 'mandate://specs/login-sso';
const SEC = `${DOC}/sections/auth-flow`;
const msg = (id: string, o: Record<string, unknown> = {}) => ({ id, uri: `mandate://comments/${id}`, target: SEC, author: { agent: 'mandate-ui', user: 'ada' }, body: 'text', createdAt: new Date().toISOString(), ...o });
const thread = (id: string, o: Partial<CommentThread> = {}): CommentThread => ({ ...(msg(id) as object), status: 'open', events: [], replies: [], ...o }) as CommentThread;

let THREADS: CommentThread[] = [];
let PRESENCE: Record<string, unknown> = {};
const calls: { name: string; args: Record<string, any> }[] = [];
vi.mock('../src/mcp/client', () => ({
  callTool: vi.fn(async (name: string, args: Record<string, any>) => {
    calls.push({ name, args });
    if (name === 'list' && args.of === 'comments') return { target: args.target, counts: { open: THREADS.filter((t) => t.status === 'open').length, openBlocking: 0, resolved: THREADS.filter((t) => t.status === 'resolved').length }, threads: THREADS };
    if (name === 'agents_presence') return PRESENCE;
    if (name === 'comment_add') return { thread: thread('c-new'), routing: { via: 'to', wakes: [] } };
    if (name === 'comment_resolve' || name === 'comment_reopen') return {};
    throw new Error(`${name}: not mocked`);
  }),
  callRootTool: vi.fn(async () => ({})),
  getMcpProject: () => 'acme',
  McpToolError: class extends Error {},
  onNotification: () => () => undefined,
  onConnectionChange: () => () => undefined,
}));

const agents = [
  { id: 'ada/claude-code', handle: 'claude-code', label: 'Claude Code (ada)', state: 'online', busyWith: [], repos: ['web'] },
  { id: 'bo/codex', handle: 'codex', label: 'Codex (bo)', state: 'busy', busyWith: [{ ref: 'r', summary: 'wo-1: fix login' }], repos: [] },
];

function wrap(ui: React.ReactNode, rail: Record<string, unknown> = { selectTab: vi.fn() }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MantineProvider>
        <MemoryRouter initialEntries={['/specs/login-sso']}>
          <RailCtx.Provider value={rail as never}>{ui}</RailCtx.Provider>
        </MemoryRouter>
      </MantineProvider>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  calls.length = 0;
  THREADS = [];
  PRESENCE = {};
  clearCommentFocus();
});

describe('threads', () => {
  it('shows open threads (active expanded) and resolved ones collapsed to one line; replies show who and mention refs as chips', async () => {
    THREADS = [
      thread('c-1', { body: 'Why not SSO?', replies: [msg('c-2', { author: { agent: 'claude-code' }, body: 'Treating this as a request: mandate://requests/fb-0007' }) as never] }),
      thread('c-3', { body: 'Old remark', status: 'resolved', resolvedBy: 'ada' }),
    ];
    PRESENCE = { agents, responsible: ['ada/claude-code'], responsibleAgents: ['claude-code'], needsPicker: false };
    wrap(<CommentsPanel doc={DOC} />);
    expect(await screen.findByText('Why not SSO?')).toBeTruthy();
    expect(screen.getByText(/Treating this as a request/)).toBeTruthy();
    expect(screen.getAllByTestId('thread')).toHaveLength(1); // one open thread: expanded
    expect(screen.getByTestId('thread-resolved').textContent).toContain('Old remark');
    expect(screen.getByLabelText('Comment')).toBeTruthy();
    expect(screen.getByPlaceholderText(/Reply to claude-code/)).toBeTruthy();
  });

  it('reply: Make it a request is sent as asRequest; Resolve calls comment_resolve', async () => {
    THREADS = [thread('c-1', { replies: [msg('c-2', { author: { agent: 'claude-code' }, body: 'ok' }) as never] })];
    PRESENCE = { agents, responsible: [], needsPicker: false };
    wrap(<CommentsPanel doc={DOC} />);
    const box = await screen.findByLabelText('Comment');
    fireEvent.change(box, { target: { value: 'Please also support passkeys' } });
    fireEvent.click(screen.getByLabelText('Make it a request'));
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(calls.find((c) => c.name === 'comment_add')?.args).toMatchObject({ target: SEC, parent: 'c-1', body: 'Please also support passkeys', asRequest: true }));
    fireEvent.click(screen.getByRole('button', { name: /Resolve/ }));
    await waitFor(() => expect(calls.some((c) => c.name === 'comment_resolve' && c.args.id === 'c-1')).toBe(true));
  });

  it('shows "is replying" while an agent owes an answer to a fresh human message', async () => {
    THREADS = [thread('c-1', { replies: [msg('c-2', { author: { agent: 'claude-code' }, body: 'ok' }) as never, msg('c-3', { body: 'And one more thing' }) as never] })];
    PRESENCE = { agents, needsPicker: false };
    wrap(<CommentsPanel doc={DOC} />);
    expect((await screen.findByTestId('agent-replying')).textContent).toContain('claude-code is replying');
  });

  it('mention autocomplete suggests agent handles', async () => {
    THREADS = [thread('c-1')];
    PRESENCE = { agents, needsPicker: false };
    wrap(<CommentsPanel doc={DOC} />);
    const box = await screen.findByLabelText('Comment');
    fireEvent.change(box, { target: { value: 'hi @co' } });
    const opt = await screen.findByRole('option', { name: /@codex/ });
    fireEvent.click(opt);
    expect((box as HTMLTextAreaElement).value).toBe('hi @codex ');
  });
});

describe('new thread and the agent picker', () => {
  it('no one responsible: the picker lists online agents with state, suggests one, offers Any agent; the choice is sent as to', async () => {
    PRESENCE = { agents, responsible: [], suggested: 'ada/claude-code', needsPicker: true };
    wrap(<CommentsPanel doc={DOC} />);
    setCommentFocus({ newOn: SEC, quote: 'the callback' });
    const nt = await screen.findByTestId('new-thread');
    expect((within(nt).getByLabelText('Comment') as HTMLTextAreaElement).value).toContain('> the callback');
    const picker = await within(nt).findByRole('radiogroup');
    expect(within(picker).getByText('Claude Code (ada)')).toBeTruthy();
    expect(within(picker).getByText(/suggested \(idle\)/)).toBeTruthy();
    expect(within(picker).getByText(/busy: wo-1: fix login/)).toBeTruthy();
    expect(within(picker).getByText('Any agent')).toBeTruthy();
    fireEvent.click(within(picker).getByText('Codex (bo)'));
    fireEvent.click(within(nt).getByLabelText('Make it a request'));
    fireEvent.click(within(nt).getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(calls.find((c) => c.name === 'comment_add')?.args).toMatchObject({ target: SEC, to: 'codex', asRequest: true }));
  });

  it('Any agent queues the comment (to: any); a responsible agent needs no picker', async () => {
    PRESENCE = { agents, responsible: [], needsPicker: true };
    wrap(<CommentsPanel doc={DOC} />);
    setCommentFocus({ newOn: SEC });
    const nt = await screen.findByTestId('new-thread');
    fireEvent.change(within(nt).getByLabelText('Comment'), { target: { value: 'anyone?' } });
    fireEvent.click(await within(nt).findByLabelText(/Any agent/));
    fireEvent.click(within(nt).getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(calls.find((c) => c.name === 'comment_add')?.args.to).toBe('any'));
    cleanup();
    calls.length = 0;
    PRESENCE = { agents, responsible: ['ada/claude-code'], responsibleAgents: ['claude-code'], needsPicker: false };
    wrap(<CommentsPanel doc={DOC} />);
    setCommentFocus({ newOn: SEC });
    const nt2 = await screen.findByTestId('new-thread');
    await waitFor(() => expect(within(nt2).getByText(/Goes to claude-code/)).toBeTruthy());
    expect(within(nt2).queryByRole('radiogroup')).toBeNull();
  });

  it('no agent online: says how to connect one', async () => {
    PRESENCE = { agents: [], responsible: [], needsPicker: true };
    wrap(<CommentsPanel doc={DOC} />);
    setCommentFocus({ newOn: DOC });
    expect(await screen.findByText(/mandate claude/)).toBeTruthy();
  });
});

describe('section badge and selection', () => {
  it('badge: filled with the open count, outlined when only resolved, dashed when none; click opens the panel on the thread', async () => {
    const selectTab = vi.fn();
    THREADS = [thread('c-1'), thread('c-2', { target: `${DOC}/sections/callback`, status: 'resolved' })];
    const { unmount } = wrap(<CommentBadge target={SEC} />, { selectTab });
    const b = await screen.findByTestId('comment-badge');
    await waitFor(() => expect(b.getAttribute('data-kind')).toBe('open'));
    expect(b.textContent).toBe('1');
    fireEvent.click(b);
    expect(selectTab).toHaveBeenCalledWith('comments');
    unmount();
    wrap(<CommentBadge target={`${DOC}/sections/callback`} />);
    await waitFor(() => expect(screen.getByTestId('comment-badge').getAttribute('data-kind')).toBe('resolved'));
    cleanup();
    wrap(<CommentBadge target={`${DOC}/sections/overview`} />);
    await waitFor(() => expect(screen.getByTestId('comment-badge').getAttribute('data-kind')).toBe('none'));
    expect(screen.getByTestId('comment-badge').textContent).toContain('Comment');
  });

  it('selecting text in a section body shows a Comment button that starts a thread quoting it', async () => {
    const selectTab = vi.fn();
    wrap(
      <>
        <section data-section-id="auth-flow">
          <div className="doc-section-body">
            <p id="p">the callback checks state</p>
          </div>
        </section>
        <SelectionComment />
      </>,
      { selectTab },
    );
    const p = document.getElementById('p')!;
    const range = document.createRange();
    range.selectNodeContents(p);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    range.getBoundingClientRect = () => ({ left: 0, right: 80, top: 100, bottom: 120, width: 80, height: 20, x: 0, y: 100, toJSON: () => ({}) }) as DOMRect;
    fireEvent.mouseUp(p);
    const btn = await screen.findByTestId('selection-comment');
    fireEvent.click(btn);
    expect(selectTab).toHaveBeenCalledWith('comments');
  });
});

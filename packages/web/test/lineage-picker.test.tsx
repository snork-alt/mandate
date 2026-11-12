// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MantineProvider } from '@mantine/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildRef } from '@mandate/shared';
import { installDom } from './dom';
import { ElementPicker, groupPickerItems } from '../src/components/lineage/ElementPicker';

installDom();
const SPEC = buildRef({ kind: 'specs', id: 'login-sso' });
const STD = buildRef({ kind: 'standards', id: 'tokens' });
const SEC = buildRef({ kind: 'specs', id: 'login-sso', sectionId: 'rotate' });

vi.mock('../src/mcp/client', () => ({
  callTool: vi.fn(async (name: string, args: { uri?: string }) => {
    if (name === 'search')
      return {
        groups: [
          { docUri: SPEC, docTitle: 'Login with SSO', docKind: 'spec', hits: [{ uri: `${SEC}#L1-L4`, sectionId: 'rotate', sectionTitle: 'Rotate tokens', docUri: SPEC, docTitle: 'Login with SSO' }] },
          { docUri: STD, docTitle: 'Tokens', docKind: 'standard', hits: [] },
        ],
      };
    if (name === 'graph_node') return { node: { ref: args.uri, kind: 'spec', label: 'Login with SSO', props: { status: 'ready' } } };
    return {};
  }),
  McpToolError: class extends Error {},
  onNotification: () => () => undefined,
  onConnectionChange: () => () => undefined,
}));
vi.mock('../src/components/maturity/SpecMaturity', () => ({ useSpecMaturities: () => new Map() }));
beforeEach(() => localStorage.clear());
afterEach(cleanup);

const wrap = (ui: React.ReactNode) =>
  render(
    <MantineProvider>
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter>{ui}</MemoryRouter>
      </QueryClientProvider>
    </MantineProvider>,
  );

describe('Lineage element picker', () => {
  it('groups results by kind in a fixed order with flat keyboard indexes', () => {
    const g = groupPickerItems([
      { uri: SEC, kind: 'section', title: 'Rotate' },
      { uri: STD, kind: 'standard', title: 'Tokens' },
      { uri: SPEC, kind: 'spec', title: 'Login' },
    ]);
    expect(g.map((x) => x.label)).toEqual(['Specs', 'Standards', 'Sections']);
    expect(g.flatMap((x) => x.items.map((i) => i.index))).toEqual([0, 1, 2]);
  });

  it('searches, groups with headers, moves with the arrow keys and picks with Enter', async () => {
    const onPick = vi.fn();
    wrap(<ElementPicker value="" onPick={onPick} onClear={() => undefined} />);
    const input = screen.getByLabelText('Pick an element');
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'login' } });
    await waitFor(() => expect(screen.getAllByTestId('picker-group')).toHaveLength(3));
    expect(screen.getAllByTestId('picker-group').map((g) => g.firstElementChild!.textContent)).toEqual(['Specs', 'Standards', 'Sections']);
    const opts = () => screen.getAllByRole('option');
    expect(opts()[0]!.getAttribute('aria-selected')).toBe('true');
    // The section row shows its parent document as context.
    expect(opts()[2]!.textContent).toContain('Rotate tokens');
    expect(opts()[2]!.textContent).toContain('Login with SSO');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(opts()[2]!.getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(opts()[0]!.getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onPick).toHaveBeenCalledWith(SEC);
    // Esc closes; the pick is remembered as recent.
    expect(JSON.parse(localStorage.getItem('mandate.lineage.recent')!)[0].uri).toBe(SEC);
  });

  it('resolves a pasted reference first and closes on Esc and on a click outside', async () => {
    wrap(
      <div>
        <span data-testid="outside">outside</span>
        <ElementPicker value="" onPick={() => undefined} onClear={() => undefined} />
      </div>,
    );
    const input = screen.getByLabelText('Pick an element');
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: `@mandate:${SPEC}` } });
    await waitFor(() => expect(screen.getAllByRole('option')[0]!.textContent).toContain('Login with SSO'));
    // Esc clears the text first (shared SearchField), then closes the list.
    fireEvent.keyDown(input, { key: 'Escape' });
    if (screen.queryByTestId('picker-list')) fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByTestId('picker-list')).toBeNull();
    fireEvent.focus(input);
    expect(screen.getByTestId('picker-list')).toBeTruthy();
    act(() => void document.dispatchEvent(new Event('pointerdown', { bubbles: true })));
    expect(screen.queryByTestId('picker-list')).toBeNull();
  });

  it('shows the selected element as a chip with a clear button', () => {
    const onClear = vi.fn();
    wrap(<ElementPicker value={SPEC} valueLabel="Login with SSO" valueKind="spec" onPick={() => undefined} onClear={onClear} />);
    const chip = screen.getByTestId('picker-chip');
    expect(chip.textContent).toBe('Login with SSO');
    expect(chip.querySelector('.lp-icon[data-kind="spec"]')).toBeTruthy();
    expect(screen.queryByLabelText('Pick an element')).toBeNull();
    fireEvent.click(screen.getByLabelText('Clear element'));
    expect(onClear).toHaveBeenCalled();
    fireEvent.click(screen.getByLabelText('Pick another element'));
    expect(screen.getByLabelText('Pick an element')).toBeTruthy();
  });
});

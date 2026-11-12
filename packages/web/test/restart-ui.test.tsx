// @vitest-environment jsdom
/** Settings apply without restart ("Applied ✓"); a new address restarts Mandate and waits for it (spinner, then reload; manual command on timeout). */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { announceApplied, waitForRestart, type SetupState } from '../src/setup/api';
import { AddressSection, RestartStatus, useServerRestart } from '../src/setup/sections';
import { AppliedBanner } from '../src/setup/SetupWizard';
import { installDom, Wrap } from './dom';

beforeAll(installDom);
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });

const state = {
  complete: true,
  configVersion: 'v1',
  config: { local: { baseDir: '/home/me/mandate' }, server: { publicUrl: null, bind: '127.0.0.1', port: 4000, trustProxy: false } },
} as unknown as SetupState;

describe('waitForRestart', () => {
  it('waits through the outage until /health answers from a new process', async () => {
    const answers: (() => Response)[] = [
      () => json({ ok: true, startedAt: 1 }), // not restarted yet
      () => {
        throw new TypeError('fetch failed'); // down
      },
      () => json({}, 502), // proxy while the server starts
      () => json({ ok: true, startedAt: 2 }),
    ];
    const f = vi.fn(async () => answers.shift()!());
    expect(await waitForRestart(1, { fetch: f as never, intervalMs: 1 })).toBe(true);
    expect(f).toHaveBeenCalledTimes(4);
  });

  it('gives up after the timeout', async () => {
    let t = 0;
    const f = async () => json({ ok: true, startedAt: 1 });
    expect(await waitForRestart(1, { fetch: f as never, intervalMs: 1, timeoutMs: 30_000, now: () => (t += 10_000) })).toBe(false);
  });
});

describe('restart UI states', () => {
  it('Applied ✓ banner after a live-applied save (no restart wording)', async () => {
    render(
      <Wrap>
        <AppliedBanner />
      </Wrap>,
    );
    expect(screen.queryByTestId('applied-banner')).toBeNull();
    act(() => announceApplied(['git', 'database']));
    const b = await screen.findByTestId('applied-banner');
    expect(b.textContent).toContain('Applied ✓');
    expect(b.textContent).toContain('Git backend switched; Database switched');
    expect(b.textContent).not.toMatch(/restart Mandate|getmandate/i);
  });

  it('spinner while restarting; manual command (with the new address) when it does not come back', () => {
    const { rerender } = render(
      <Wrap>
        <RestartStatus phase={{ kind: 'restarting' }} />
      </Wrap>,
    );
    expect(screen.getByTestId('restart-progress').textContent).toContain('Mandate is restarting…');
    rerender(
      <Wrap>
        <RestartStatus phase={{ kind: 'manual', command: 'mandate restart', url: 'https://mandate.example.com', timedOut: true }} />
      </Wrap>,
    );
    const m = screen.getByTestId('restart-manual');
    expect(m.textContent).toContain('did not come back within 30 seconds');
    expect(m.textContent).toContain('mandate restart');
    expect(m.textContent).not.toContain('npx getmandate');
    expect(m.querySelector('a')!.getAttribute('href')).toBe('https://mandate.example.com');
  });

  it('useServerRestart: restarts, waits for the new process, then goes to the new address', async () => {
    let health = { ok: true, startedAt: 1 };
    const calls: string[] = [];
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? 'GET'} ${url}`);
      if (url === '/ui/setup/restart') {
        setTimeout(() => (health = { ok: true, startedAt: 2 }), 20);
        return json({ restarting: true, kind: 'supervised', command: 'mandate restart' });
      }
      if (url === '/health') return json(health);
      return json({}, 404);
    });
    const navigate = vi.fn();
    let hook!: ReturnType<typeof useServerRestart>;
    function Probe() {
      hook = useServerRestart({ navigate, timeoutMs: 5_000 });
      return <RestartStatus phase={hook.phase} />;
    }
    render(
      <Wrap>
        <Probe />
      </Wrap>,
    );
    const done = hook.run(1, 'https://mandate.example.com');
    await screen.findByText('Mandate is restarting…');
    await act(() => done);
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('https://mandate.example.com'));
    expect(calls[0]).toBe('POST /ui/setup/restart');
  });

  it('AddressSection (Settings): a new address saves, asks for a restart, and shows the command when the server cannot restart itself', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? 'GET'} ${url}`);
      if (url === '/health') return json({ ok: true, startedAt: 1 });
      if (url === '/ui/setup/server') return json({ configVersion: 'v2', restartRequired: true, url: 'https://mandate.example.com', restart: { kind: 'manual', command: 'stop and start npm run dev' } });
      if (url === '/ui/setup/restart') return json({ restarting: false, kind: 'manual', command: 'stop and start npm run dev' });
      return json({}, 404);
    });
    render(
      <Wrap>
        <AddressSection state={state} variant="wizard" register={() => undefined} />
      </Wrap>,
    );
    fireEvent.change(screen.getByPlaceholderText('https://mandate.example.com'), { target: { value: 'https://mandate.example.com' } });
    fireEvent.click(await screen.findByTestId('address-save'));
    const m = await screen.findByTestId('restart-manual');
    expect(m.textContent).toContain('cannot restart itself');
    expect(m.textContent).toContain('stop and start npm run dev');
    expect(calls).toEqual(['GET /health', 'PUT /ui/setup/server', 'POST /ui/setup/restart']);
    expect((screen.getByTestId('address-save') as HTMLButtonElement).disabled).toBe(true);
  });
});

import { describe, expect, it } from 'vitest';
import type { AutoPushStatus } from '@mandate/shared';
import { pushSummary } from '../src/lib/push';

const base: AutoPushStatus = { enabled: true, state: 'idle', ahead: 0, behind: 0, lastPushAt: null, lastResult: null, lastError: null, nextPushAt: null, failures: 0, message: '' };

describe('pushSummary', () => {
  it('shows pending, pushed, failed and blocked states', () => {
    expect(pushSummary(undefined)).toBeNull();
    expect(pushSummary(base)).toBeNull();
    expect(pushSummary({ ...base, state: 'scheduled', ahead: 2 })?.text).toBe('↑2 pending push');
    expect(pushSummary({ ...base, state: 'ok', lastPushAt: new Date(Date.now() - 60_000).toISOString() })?.text).toMatch(/^Pushed 1 min/);
    expect(pushSummary({ ...base, state: 'error', ahead: 1 })?.text).toBe('↑1 · push failed');
    expect(pushSummary({ ...base, state: 'no_remote', ahead: null })?.text).toBe('No remote');
    expect(pushSummary({ ...base, state: 'reconnect' })?.text).toBe('Reconnect GitHub');
    expect(pushSummary({ ...base, state: 'refused' })?.text).toBe('Push refused');
  });
});

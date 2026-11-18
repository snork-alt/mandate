/** Pickers list `reconnecting` agents (seen just before a server restart) after the active ones; offline ones stay out. */
import { describe, expect, it } from 'vitest';
import { activeAgents, defaultAgent } from '../src/components/comments/CommentsPanel';
import { deliveryProblem } from '../src/lib/requests';

const ag = (id: string, state: string, wakeable = false) => ({ id, handle: id, label: id, state, wakeable, busyWith: [], repos: [] });

describe('reconnecting agents in pickers', () => {
  it('are included after wakeable / online ones, offline are not', () => {
    const presence = { agents: [ag('off', 'offline'), ag('re', 'reconnecting'), ag('mcp', 'online'), ag('wake', 'online', true)] } as never;
    expect(activeAgents(presence).map((a) => a.id)).toEqual(['wake', 'mcp', 're']);
  });
  it('the only agent being reconnecting is still selectable and the default; its request explains the wait', () => {
    const presence = { agents: [ag('re', 'reconnecting')], suggested: null } as never;
    expect(defaultAgent(presence)).toBe('re');
    expect(deliveryProblem({ status: 'open', assignee: 're' } as never, presence)).toMatch(/reconnecting/);
  });
});

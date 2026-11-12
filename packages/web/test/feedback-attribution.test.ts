import { describe, expect, it } from 'vitest';
import { feedbackAttribution } from '../src/pages/FeedbackItemPage';

describe('feedback attribution', () => {
  it('uses createdBy (agent) + createdByUser (server mode) and the newest history entry', () => {
    const a = feedbackAttribution({ createdAt: '2026-11-01T10:00:00Z', createdBy: 'claude-code', createdByUser: 'octocat' }, [
      { date: '2026-11-02T10:00:00Z', commit: 'b'.repeat(40), agent: 'codex', author: 'T', user: 'alice' },
      { date: '2026-11-01T10:00:00Z', commit: 'a'.repeat(40), agent: 'claude-code', author: 'T', user: 'octocat' },
    ]);
    expect(a.createdBy).toEqual({ user: 'octocat', agent: 'claude-code', at: '2026-11-01T10:00:00Z' });
    expect(a.lastEditedBy).toMatchObject({ user: 'alice', agent: 'codex' });
  });
  it('old / local data: agent only, no user', () => {
    const a = feedbackAttribution({ createdAt: '2026-11-01T10:00:00Z', createdBy: 'claude-code' }, [{ date: '2026-11-01T10:00:00Z', commit: 'a'.repeat(40), author: 'T' }]);
    expect(a.createdBy).toEqual({ agent: 'claude-code', at: '2026-11-01T10:00:00Z' });
    expect(a.lastEditedBy).toBeUndefined();
  });
});

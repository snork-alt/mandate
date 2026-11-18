/** A server without projects (fresh install): the registry copes, and the first project becomes the default. */
import { describe, expect, it } from 'vitest';
import { ProjectRegistry, projectOpener } from '../src/projects/registry.js';

describe('registry without projects', () => {
  it('has no default project until the first one is added', () => {
    const reg = new ProjectRegistry([], projectOpener({} as never, { provider: null, activityPollMs: 0, startIndex: false }));
    expect(reg.list()).toEqual([]);
    expect(reg.defaultProject).toBe('');
    reg.add({ id: 'first', name: 'First', dataDir: '/x' } as never);
    expect(reg.defaultProject).toBe('first');
  });
});

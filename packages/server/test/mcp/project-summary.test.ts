/** project_list card stats: active work orders, linked code repos, open decisions (best effort, never throws). */
import { describe, expect, it } from 'vitest';
import { projectSummary } from '../../src/mcp/http.js';
import type { ProjectRuntime } from '../../src/projects/registry.js';

const list = <T>(xs: T[]) => ({ list: async () => xs });
const info = { id: 'web', name: 'Web', dataDir: '/tmp/web', branch: 'main', remote: null, mcpPath: '/p/web/mcp', github: null };

describe('projectSummary', () => {
  it('counts active work orders and names the linked code repos', async () => {
    const rt = {
      storage: {
        specs: list([1, 2]),
        standards: list([1]),
        components: list([]),
        workOrders: list([{ status: 'in_progress' }, { status: 'pending' }, { status: 'done' }, { status: 'in_progress' }]),
        feedback: list([]),
      },
      activity: { list: async () => ({ events: [] }) },
      ctx: { settings: { codeRepos: () => [{ name: 'api', github: 'acme/api' }, { name: 'web-app', github: 'acme/web' }] } },
    } as unknown as ProjectRuntime;
    const s = await projectSummary(rt, info);
    expect(s).toMatchObject({ counts: { specs: 2, standards: 1, components: 0, workOrders: 4, activeWorkOrders: 2 }, codeRepos: ['api', 'web-app'], lastActivity: null });
    // Decisions need the full storage: a failure counts as 0 instead of failing the list.
    expect((s as { openActions: number }).openActions).toBe(0);
  });

  it('keeps an unavailable project listable', async () => {
    expect(await projectSummary(null, info)).toMatchObject({ counts: null, error: 'unavailable' });
  });
});

/**
 * Git during the flow: the project settings commit / branch / push (defaults, storage, effective, instructions) and
 * flow_next's commit step (auto: the exact message; ask: one question_ask, then the answer), branch on claim, push at
 * completion and the component step for unowned touched files (nothing when the project has no components).
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { commitMessage, flowFor, type FlowGit, type FlowSnapshot } from '../src/flow/next.js';
import { effective, flowInstructions, gitInstructions, policyChanges, policyOf, projectSettings } from '../src/projects/settings.js';
import { ProjectsStore } from '../src/projects/store.js';
import { CORE_RULES, MANDATE_COMMAND, SKILL_BODY } from '../src/mcp/guide.js';

describe('commit / branch / push settings', () => {
  it('defaults, sparse storage, patch, effective and the change labels', async () => {
    const file = path.join(mkdtempSync(path.join(os.tmpdir(), 'mandate-fg-')), 'projects.json');
    writeFileSync(file, JSON.stringify({ version: 1, projects: [{ id: 'a', name: 'A', dataDir: '/a', createdAt: 'x' }] }));
    const s = projectSettings(new ProjectsStore(file), 'a');
    expect(s.policy()).toEqual({ flowPolicy: 'optional' });
    expect(effective(s.policy(), undefined)).toMatchObject({ commit: 'auto', branch: 'per-request', push: 'off', components: 'required' });
    expect((await s.setPolicy({ components: 'optional' })).components).toBe('optional');
    expect(flowInstructions(effective(s.policy(), undefined))).toContain('Components: optional');
    await s.setPolicy({ components: 'required' });
    expect(s.policy().components).toBeUndefined();
    const before = s.policy();
    const after = await s.setPolicy({ commit: 'ask', branch: 'current', push: 'auto' });
    expect(after).toEqual({ flowPolicy: 'optional', commit: 'ask', branch: 'current', push: 'auto' });
    expect(JSON.parse(readFileSync(file, 'utf8')).projects[0]).toMatchObject({ commit: 'ask', branch: 'current', push: 'auto' });
    expect(effective(after, undefined)).toMatchObject({ commit: 'ask', branch: 'current', push: 'auto' });
    expect(policyChanges(before, after)).toEqual(['commit ask', 'branch current', 'push auto']);
    // Back to the defaults removes the keys.
    await s.setPolicy({ commit: 'auto', branch: 'per-request', push: 'off' });
    const e = JSON.parse(readFileSync(file, 'utf8')).projects[0];
    expect(e.commit ?? e.branch ?? e.push).toBeUndefined();
    expect(policyOf({ id: 'a', commit: 'auto' } as never)).toEqual({ flowPolicy: 'optional' });
  });

  it('instructions per mode (flowInstructions, guide, /mandate command)', () => {
    const auto = flowInstructions(effective({ flowPolicy: 'optional' }, undefined));
    expect(auto).toContain('commit auto');
    expect(auto).toContain('mandate/<request-id>');
    expect(auto).toContain('Never push');
    expect(auto).toContain('<request id> <step id>: <step text>');
    const ask = flowInstructions(effective({ flowPolicy: 'optional', commit: 'ask', branch: 'current', push: 'auto' }, undefined));
    expect(ask).toContain('commit ask');
    expect(ask).toContain('question_ask');
    expect(ask).toContain('Stay on the current branch');
    expect(ask).toContain('open a PR');
    expect(gitInstructions({ commit: 'auto', branch: 'per-request', push: 'off' })).toContain('initial commit');
    for (const t of [CORE_RULES, SKILL_BODY]) expect(t).toContain('dirty: true');
    expect(MANDATE_COMMAND.render('x')).toContain('GIT: commit auto');
  });
});

describe('flow_next: commit, branch, push and component steps', () => {
  const now = Date.parse('2026-01-01T12:00:00Z');
  const req = { id: 'fb-1', kind: 'improvement', body: 'Make it better', status: 'open', targets: [], relatedTo: [], changes: [], warnings: [], createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', specMatch: { at: 'x', by: 'y', refs: [] } } as never;
  const spec = { id: 's', status: 'ready', sections: [{ id: 'a', type: 'markdown', verifiedBy: [] }, { id: 'ac', type: 'acceptance', method: 'test' }] } as never;
  const wo = (over: Record<string, unknown> = {}) =>
    ({
      id: 'wo-1', spec: 's', kind: 'implement', status: 'in_progress', reason: ['fb-1'], createdAt: '2026-01-01T00:00:00Z', hasPlan: true,
      claim: { agent: 'a', startedAt: '2026-01-01T11:59:00Z', heartbeatAt: '2026-01-01T11:59:30Z' },
      sections: [{ id: 'a', status: 'pending' }],
      planSteps: [{ id: 's1', text: 'Write the code', status: 'done' }, { id: 's2', text: 'Write the test', status: 'pending' }],
      ...over,
    }) as never;
  const git = (over: Partial<FlowGit> = {}): FlowGit => ({ commit: 'auto', branch: 'per-request', push: 'off', ...over });
  const snap = (w: unknown, g: FlowGit | undefined, over: Partial<FlowSnapshot> = {}): FlowSnapshot => ({ requests: [req], workOrders: [w as never], questions: [], specs: new Map([['s', spec]]), verifications: [], now, ...(g ? { git: g } : {}), ...over });

  it('the claim step names the branch', () => {
    const n = flowFor(req, snap(wo({ claim: undefined }), git()));
    expect(n.next?.why).toContain('mandate/fb-1');
    expect(flowFor(req, snap(wo({ claim: undefined }), git({ branch: 'current' }))).next?.why).toContain('current branch');
    expect(n.git).toMatchObject({ commit: 'auto', branch: 'mandate/fb-1' });
  });

  it('auto: a dirty tree after a done step gives the commit step with the exact message', () => {
    const n = flowFor(req, snap(wo(), git({ tree: { dirty: true } })));
    expect(n.state).toBe('commit');
    expect(n.next?.why).toContain('fb-1 s1: Write the code');
    expect(n.next?.why).toContain('Request: fb-1');
    expect(n.next?.why).toContain('Work-Order: wo-1');
    expect(commitMessage(wo(), req)).toBe('fb-1 s1: Write the code\n\nRequest: fb-1\nWork-Order: wo-1');
    // Clean tree: carries on with the next step.
    expect(flowFor(req, snap(wo(), git())).next?.tool).toBe('work_order_task_set');
    // Nothing done yet: pre-existing changes are not the work's.
    expect(flowFor(req, snap(wo({ planSteps: [{ id: 's1', text: 'x', status: 'pending' }] }), git({ tree: { dirty: true } }))).state).toBe('tasks');
    // A step in progress is not interrupted.
    expect(flowFor(req, snap(wo({ planSteps: [{ id: 's1', text: 'x', status: 'in_progress' }] }), git({ tree: { dirty: true } }))).state).toBe('tasks');
  });

  it('auto: no HEAD says to make the initial commit; before sections too', () => {
    const w = wo({ planSteps: [{ id: 's1', text: 'Write the code', status: 'done' }] });
    const n = flowFor(req, snap(w, git({ tree: { noHead: true } })));
    expect(n.state).toBe('commit');
    expect(n.next?.why).toMatch(/no commit yet: make the initial commit/);
  });

  it('ask: a question_ask (decision, blocks the work order), then the answer decides', () => {
    const w = wo({ planSteps: [{ id: 's1', text: 'Write the code', status: 'done' }] });
    const g = git({ commit: 'ask', tree: { dirty: true } });
    const n = flowFor(req, snap(w, g));
    expect(n.state).toBe('commit');
    expect(n.next).toMatchObject({ tool: 'question_ask', args: { purpose: 'decision', request: 'fb-1', blocks: ['mandate://work-orders/wo-1'], blocking: true } });
    expect(n.next?.why).toMatch(/not ask in chat/);
    const q = (status: string, label: string) => ({ id: 'ask-0001', purpose: 'decision', blocks: ['mandate://work-orders/wo-1'], blocking: true, status, questions: [{ id: 'q1', header: 'Commits', options: [] }], ...(status === 'answered' ? { answer: { by: { agent: 'u' }, at: 'x', answers: { q1: label } } } : {}) }) as never;
    // Open: the flow waits (the question blocks the work order).
    const open = flowFor(req, snap(w, g, { questions: [q('open', '')] }));
    expect(open.state).toBe('waiting');
    expect(open.waitingOn).toEqual(['ask-0001']);
    // Answered "Commit for me": the commit step, no new question.
    const yes = flowFor(req, snap(w, g, { questions: [q('answered', 'Commit for me')] }));
    expect(yes.state).toBe('commit');
    expect(yes.next?.tool).toBe('code_context_set');
    // Answered "I commit myself": wait for the user's commit, never commit.
    const mine = flowFor(req, snap(w, g, { questions: [q('answered', 'I commit myself')] }));
    expect(mine.next?.tool).toBe('news_list');
    expect(mine.next?.why).toMatch(/Do not commit/);
  });

  it('verify / complete: the commit step comes first, then the work order is completed; push auto adds the PR step', () => {
    const w = wo({ sections: [{ id: 'a', status: 'done' }], planSteps: [{ id: 's1', text: 'Write the code', status: 'done' }] });
    expect(flowFor(req, snap(w, git({ tree: { dirty: true } }))).state).toBe('commit');
    const recs = [{ criterion: 'mandate://specs/s/sections/ac', appliedTo: 'mandate://specs/s', at: '2026-01-01T11:59:50Z', result: 'pass', evidence: { test: 't' } }] as never;
    const done = flowFor(req, snap(w, git({ push: 'auto' }), { verifications: recs }));
    expect(done.state).toBe('complete');
    expect(done.next?.why).toContain('push the branch mandate/fb-1');
    expect(done.next?.why).toContain('never fail the flow');
    expect(flowFor(req, snap(w, git(), { verifications: recs })).next?.why).not.toContain('push the branch');
  });

  it('unowned touched files: a component step (update when components exist, create the initial ones when none)', () => {
    const w = wo({ sections: [{ id: 'a', status: 'done' }], planSteps: [] });
    const recs = [{ criterion: 'mandate://specs/s/sections/ac', appliedTo: 'mandate://specs/s', at: '2026-01-01T11:59:50Z', result: 'pass', evidence: { test: 't' } }] as never;
    const withComps = flowFor(req, snap(w, git({ components: 2, unowned: { 'wo-1': ['app:src/new.ts'] } }), { verifications: recs }));
    expect(withComps.state).toBe('components');
    expect(withComps.next?.tool).toBe('component_update');
    expect(withComps.next?.why).toMatch(/component_create/);
    expect(withComps.next?.why).toContain('app:src/new.ts');
    const none = flowFor(req, snap(w, git({ components: 0, unowned: { 'wo-1': ['app:src/new.ts'] } }), { verifications: recs }));
    expect(none.state).toBe('components');
    expect(none.next?.tool).toBe('component_create');
    expect(none.next?.why).toMatch(/no components yet/);
    expect(none.next?.why).toContain('components_missing');
    expect(flowFor(req, snap(w, git({ components: 1, componentsRequired: false, unowned: { 'wo-1': ['app:src/new.ts'] } }), { verifications: recs })).next?.why).not.toContain('components_missing');
    expect(flowFor(req, snap(w, git({ components: 2, unowned: {} }), { verifications: recs })).state).toBe('complete');
  });
});

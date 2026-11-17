/**
 * Every agent-facing text (skill, MCP instructions, commands, bootstrap, lifecycle registry, error hints, agent tool
 * descriptions) names only tools agents are served, parameters those tools accept, and error codes the registry
 * explains; agent sessions are never served UI-only tools.
 */
import { describe, expect, it } from 'vitest';
import { ERROR_ACTIONS, feedbackCreateInputSchema, LIFECYCLE_KINDS, lifecycleView } from '@mandate/shared';
import { BOOTSTRAP_COMMAND, BOOTSTRAP_SKILL_BODY } from '../../src/mcp/bootstrap.js';
import { CORE_RULES, FLOW_COMMAND, SKILL_BODY } from '../../src/mcp/guide.js';
import { AGENT_TOOLS, INSTRUCTIONS, TOOLS, UI_ONLY_TOOL_NAMES } from '../../src/mcp/server.js';
import type { AnyToolDef } from '../../src/mcp/define.js';

const byName = new Map(AGENT_TOOLS.map((t) => [t.name, t]));
const families = new Set(TOOLS.map((t) => t.name.split('_')[0]!));
/** snake_case words in those families that are not tools: kinds, enum values, fields. */
const NOT_TOOLS = new Set(['request_assigned', 
  'work_order', 'work_order_section', 'spec_section', 'standard_section', 'component_section', 'audit_finding', 'flow_policy', 'standard_confirmation', 'code_deviates', 'spec_wrong',
  'spec_drifted', 'standard_proposal', 'agent_stopped', 'criteria_missing', 'stale_claim', 'feedback_open', 'feedback_accepted', 'waiver_pending', 'approval_override', 'audit_contradicted', 'integrity_error',
  'question_frozen', 'question_not_answered', 'question_ineligible', 'question_purpose', 'feedback_target_mismatch', 'request_closed', 'feedback_tampered', 'code_repo_unavailable',
  'index_unavailable', 'activity_unavailable', 'section_referenced', 'spec_section_without_criteria', 'spec_done_without_criteria', 'component_unreferenced',
  'component_no_standards', 'component_no_code', 'component_cycle', 'contains_cycle', 'extends_cycle', 'supersedes_cycle', 'supersedes_successors', 'standard_successor_loop', 'audit_frozen',
  'audit_incomplete', 'audit_not_completed', 'audit_pass_contradicted', 'done_gate', 'done_spec_drift', 'flow_enabled', 'code_owner_glob', 'spec_status', 'work_order_frozen',
  'component_candidate', 'doc_claim', 'spec_depends_on', 'component_depends_on', 'code_ranges', 'code_files', 'code_commit', 'code_file', 'code_range', 'question_answered', 'project_policy', 'graph_schema_v', 'search_kinds', 'rule_check', 'git_context',
]);

const toolTexts = (): [string, string][] =>
  AGENT_TOOLS.filter((t) => typeof t.description === 'string').map((t) => [`tool ${t.name}`, t.description as string]);
const lifecycleTexts = (): [string, string][] =>
  LIFECYCLE_KINDS.flatMap((k) => {
    const v = lifecycleView(k);
    return [[`lifecycle ${k}`, [v.create?.when ?? '', ...v.steps.flatMap((s) => [s.when, s.gate ?? '']), ...v.notes].join('\n')]] as [string, string][];
  });
const TEXTS = (): [string, string][] => [
  ['skill', SKILL_BODY],
  ['core rules', CORE_RULES],
  ['instructions', INSTRUCTIONS],
  ['flow command', FLOW_COMMAND.render('$ARGUMENTS')],
  ['bootstrap', BOOTSTRAP_SKILL_BODY],
  ['bootstrap command', BOOTSTRAP_COMMAND.render('$ARGUMENTS')],
  ['error actions', Object.values(ERROR_ACTIONS).join('\n')],
  ...lifecycleTexts(),
  ...toolTexts(),
];

const shapeKeys = (t: AnyToolDef): string[] => {
  const s = t.input as unknown as { shape?: Record<string, unknown>; _zod?: { def?: { shape?: Record<string, unknown>; in?: { shape?: Record<string, unknown> } } } };
  return Object.keys(s.shape ?? s._zod?.def?.shape ?? s._zod?.def?.in?.shape ?? {});
};

describe('agent-facing texts', () => {
  it('name only tools agent sessions are served', () => {
    const bad: string[] = [];
    for (const [where, text] of TEXTS()) {
      for (const m of text.matchAll(/\b([a-z]+(?:_[a-z]+)+)\b/g)) {
        const w = m[1]!;
        if (!families.has(w.split('_')[0]!) || NOT_TOOLS.has(w) || ERROR_ACTIONS[w] !== undefined) continue;
        if (!byName.has(w)) bad.push(`${where}: ${w}${UI_ONLY_TOOL_NAMES.has(w) ? ' (UI-only)' : ''}`);
      }
    }
    expect([...new Set(bad)]).toEqual([]);
  });

  it('pass only parameters the named tool accepts (`tool { a, b: … }` forms)', () => {
    const bad: string[] = [];
    for (const [where, text] of TEXTS()) {
      for (const m of text.matchAll(/\b([a-z]+(?:_[a-z]+)+) \{ ([^{}]*?) \}/g)) {
        const t = byName.get(m[1]!);
        if (!t) continue;
        const keys = shapeKeys(t);
        for (const part of m[2]!.split(',')) {
          const k = /^\s*"?([a-zA-Z]+)"?\s*(?::|$)/.exec(part)?.[1];
          if (k && !keys.includes(k)) bad.push(`${where}: ${m[1]} { ${k} }`);
        }
      }
    }
    expect(bad).toEqual([]);
  });

  it('name only error codes the registry explains (and every lifecycle error has an action)', () => {
    const codes = new Set(LIFECYCLE_KINDS.flatMap((k) => [...(lifecycleView(k).create?.errors ?? []), ...lifecycleView(k).steps.flatMap((s) => s.errors ?? [])]));
    expect([...codes].filter((c) => ERROR_ACTIONS[c] === undefined)).toEqual([]);
    for (const c of ['done_gate', 'criteria_missing', 'confirmation_required', 'question_not_answered', 'question_ineligible', 'question_frozen', 'approval_required', 'waiver_self_approved', 'criteria_unproven', 'plan_required', 'plan_invalid', 'request_closed']) expect(ERROR_ACTIONS[c], c).toBeTruthy();
    for (const t of [SKILL_BODY, CORE_RULES]) for (const m of t.matchAll(/`(\w+_gate)`/g)) expect(ERROR_ACTIONS[m[1]!], m[1]).toBeTruthy();
  });

  it('are agent-neutral and never document self-approval as a way past a gate', () => {
    for (const [where, text] of TEXTS()) {
      expect(text, where).not.toMatch(/AskUserQuestion|Claude/);
      expect(text, where).not.toMatch(/not server-checked/);
    }
    expect(ERROR_ACTIONS.done_gate).toMatch(/never force/);
    expect(ERROR_ACTIONS.done_gate).not.toMatch(/accepted feedback by someone else/);
    expect(ERROR_ACTIONS.waiver_self_approved).toMatch(/needs the user's approval/i);
    expect(JSON.stringify(ERROR_ACTIONS)).not.toMatch(/override: true/);
  });

  it('agent sessions are not served UI-only tools', () => {
    for (const n of UI_ONLY_TOOL_NAMES) expect(byName.has(n), n).toBe(false);
    expect(AGENT_TOOLS.some((t) => t.uiOnly)).toBe(false);
    for (const n of ['flow_policy_set', 'project_flow_set']) expect(TOOLS.some((t) => t.name === n)).toBe(true);
  });
});

describe('prompts review: schema and description fixes', () => {
  const tool = (n: string) => TOOLS.find((t) => t.name === n)!;
  const ok = (n: string, a: unknown) => tool(n).input.safeParse(a).success;

  it('C1: improvement / bug feedback may be filed without targets at intake; other kinds need one', () => {
    expect(ok('request_create', { kind: 'improvement', body: 'Add remember-me.' })).toBe(true);
    expect(ok('request_create', { kind: 'bug', body: 'Login loops.' })).toBe(true);
    expect(feedbackCreateInputSchema.safeParse({ kind: 'question', body: 'Which IdPs?' }).success).toBe(false);
    expect(feedbackCreateInputSchema.safeParse({ kind: 'improvement', body: 'Add remember-me.' }).success).toBe(true);
  });

  it('M11 / M12: no draft on standard_status_set; link rels and section fields per document kind', () => {
    expect(ok('standard_status_set', { ref: 'mandate://standards/x', status: 'draft' })).toBe(false);
    expect(ok('standard_section_link_add', { ref: 'mandate://standards/x/sections/a', to: 'mandate://specs/y/sections/b', rel: 'depends_on' })).toBe(false);
    expect(ok('standard_section_link_add', { ref: 'mandate://standards/x/sections/a', to: 'mandate://standards/y/sections/b', rel: 'extends' })).toBe(true);
    expect(ok('component_section_link_add', { ref: 'mandate://components/x/sections/a', to: 'mandate://standards/y', rel: 'extends' })).toBe(false);
    expect(ok('spec_section_insert', { doc: 'x', section: { title: 'A', level: 'must' } })).toBe(false);
    expect(ok('standard_section_insert', { doc: 'x', section: { title: 'A', method: 'test' } })).toBe(false);
    expect(ok('component_section_insert', { doc: 'x', section: { title: 'A', method: 'test' } })).toBe(false);
    expect(ok('spec_section_insert', { doc: 'x', section: { title: 'A', type: 'acceptance', method: 'test' } })).toBe(true);
  });

  it('edge kinds are validated strings with close matches', () => {
    const r = tool('graph_neighbors').input.safeParse({ uri: 'mandate://specs/x', kinds: ['depend_on'] });
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toMatch(/graph_schema lists the edge kinds/);
    expect(ok('graph_neighbors', { uri: 'mandate://specs/x', kinds: ['depends_on', 'links_to'] })).toBe(true);
  });

  it('M9 / H2 / L12 / M14: description fixes', () => {
    const d = (n: string) => tool(n).description as string;
    expect(d('work_order_heartbeat')).not.toMatch(/A git commit/);
    expect(d('work_order_next')).toContain('No git input: record it with work_order_git_update');
    expect(d('upload_url_create')).toContain('The URL is the credential');
    expect(d('upload_url_create')).not.toContain('MANDATE_KEY_<P>');
    expect(SKILL_BODY).not.toContain('MANDATE_KEY');
    expect(SKILL_BODY).toContain('project_info.upload');
    expect(d('lifecycle_get')).not.toContain(LIFECYCLE_KINDS.join(', '));
    expect(INSTRUCTIONS).toContain('Every write tool also takes agent');
    for (const t of AGENT_TOOLS) if (typeof t.description === 'string') expect(t.description, t.name).not.toMatch(/A git commit\. Optional: agent|Writes are git commits \(trailers/);
  });
});

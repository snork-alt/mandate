/** Token budgets (tokens ≈ chars / 4) for agent-facing texts: bootstrap skill / command, tool descriptions. Budget = trimmed size + ~10%. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BOOTSTRAP_COMMAND, BOOTSTRAP_SKILL_BODY, BOOTSTRAP_SKILL_DESCRIPTION } from '../../src/mcp/bootstrap.js';
import { TOOLS } from '../../src/mcp/server.js';
import { graphTools } from '../../src/mcp/tools/graph.js';
import type { ToolContext } from '../../src/mcp/define.js';
import { mcpFixture, type McpFixture } from './fixture.js';

const tok = (s: string) => Math.ceil(s.length / 4);

/** Per-tool description budgets (tools in activity, ask, docs, graph, lineage, match, ops, project, rules, search, views). */
const TOOL_BUDGETS: Record<string, number> = {"project_info":130,"instructions_get":110,"code_context_set":118,"flow_set":88,"project_flow_set":28,"flow_policy_set":72,"flow_clients_list":40,"search":123,"text_search":95,"symbol_search":48,"code_search":61,"related":59,"metadata_query":79,"history_search":54,"graph_search":37,"spec_match":125,"graph_node":60,"graph_neighbors":90,"graph_path":56,"graph_impact":63,"graph_history":81,"graph_changes":60,"graph_evolution":42,"graph_schema":44,"graph_batch":125,"lineage":181,"blast_radius":83,"standard_where_used":83,"code_rules":64,"contributors":111,"users_resolve":48,"writers_recent":62,"spec_list":129,"spec_get":70,"spec_section_get":55,"standard_list":51,"standard_get":52,"standard_section_get":40,"work_order_list":60,"work_order_get":59,"request_list":77,"request_get":32,"verification_list":97,"history_get":71,"diff_get":80,"activity_list":135,"activity_subscribe":86,"rules_for_code":73,"rule_check_plan":62,"doc_list":43,"doc_get":60,"version_get":70,"doc_raw":40,"standard_usage":42,"spec_implementation":29,"doc_feedback":42,"section_types":20,"git_log":30,"project_overview":71,"decisions_list":148,"decision_access":42,"integrity_snooze":76,"index_status":59,"embedding_jobs":61,"embedding_jobs_retry":32,"git_status":46,"git_push":48,"git_pull":28,"questions_list":83,"question_get":44,"question_ask":440,"question_cancel":66,"question_answer":125};

describe('text budgets', () => {
  it('bootstrap skill, description and command', () => {
    expect(tok(BOOTSTRAP_SKILL_BODY)).toBeLessThanOrEqual(1810); // +80: DISTILL continue rule (no stage word = run every stage in this session); +10: tools_enable bootstrap
    expect(tok(BOOTSTRAP_SKILL_DESCRIPTION)).toBeLessThanOrEqual(64);
    expect(tok(BOOTSTRAP_COMMAND.description)).toBeLessThanOrEqual(44);
    expect(tok(BOOTSTRAP_COMMAND.render('$ARGUMENTS'))).toBeLessThanOrEqual(145); // +11: start DISTILL / REVIEW yourself with sub-agents
  });

  it('static tool descriptions', () => {
    const byName = new Map(TOOLS.map((t) => [t.name, t]));
    let total = 0;
    for (const [name, budget] of Object.entries(TOOL_BUDGETS)) {
      const d = byName.get(name)?.description;
      expect(typeof d, name).toBe('string');
      expect(tok(d as string), name).toBeLessThanOrEqual(budget);
      total += tok(d as string);
    }
    expect(total).toBeLessThanOrEqual(5210);
  });

  describe('graph_query (embeds the live schema names)', () => {
    let fx: McpFixture;
    beforeAll(async () => { fx = await mcpFixture(); }, 120_000);
    afterAll(async () => fx?.close());
    it('stays within budget and points at graph_schema', async () => {
      const describe = graphTools.find((t) => t.name === 'graph_query')!.description as (c: ToolContext) => Promise<string>;
      const d = await describe({ index: fx.index } as ToolContext);
      expect(d).toContain('graph_schema');
      expect(d).toContain('Labels: ');
      // 429 -> 436: graph schema v2 lists one relationship type per link rel and the P5 / P6 kinds; 438: the Question label.
      expect(tok(d)).toBeLessThanOrEqual(482);
    });
  });
});

/**
 * Token budgets (tokens ≈ chars / 4) for the master skill, the MCP instructions, the /mandate-flow command and the
 * total of all tool descriptions: budget = trimmed size + ~10%, so edits cannot bloat agent context silently.
 * Other texts (bootstrap, Ask, per-tool): text-budgets-misc.test.ts; repoSection: cli wiring.test.ts.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CORE_RULES, FLOW_COMMAND, SKILL_BODY, SKILL_DESCRIPTION } from '../../src/mcp/guide.js';
import { AGENT_TOOLS, INSTRUCTIONS, listedTools } from '../../src/mcp/server.js';
import { toolJsonSchema, type ToolContext } from '../../src/mcp/define.js';
import { DEFAULT_SETS } from '../../src/mcp/tool-sets.js';
import { mcpFixture, type McpFixture } from './fixture.js';

const tok = (s: string) => Math.ceil(s.length / 4);

describe('working agreement budgets', () => {
  it('master skill (was ~3250 tokens before the lifecycle registry, 2055 before the prompts review)', () => {
    expect(tok(SKILL_BODY)).toBeLessThanOrEqual(2330); // +105: request flow (no approval, full plan, criteria -> tests, implemented-by), -15 approval; +15: last section done frees the claim; +55: tldr guidance; +9: instructions_get pointer; +50: tool sets (tools_enable)
    expect(SKILL_BODY.split('\n').length).toBeLessThanOrEqual(113);
    expect(tok(SKILL_DESCRIPTION)).toBeLessThanOrEqual(87);
    expect(SKILL_BODY).toContain('lifecycle_get');
  });

  it('server instructions (CORE_RULES mirror)', () => {
    expect(tok(CORE_RULES)).toBeLessThanOrEqual(1140); // +30: requests, full plan, test proof; +55: tldr guidance; +46: CURRENT TEXT (instructions_get beats local copies); +15: TOOLS (tool sets)
    expect(tok(INSTRUCTIONS)).toBeLessThanOrEqual(1390);
    expect(INSTRUCTIONS).toContain('lifecycle_get');
  });

  it('/mandate-flow command', () => {
    expect(tok(FLOW_COMMAND.render('$ARGUMENTS'))).toBeLessThanOrEqual(200);
    expect(tok(FLOW_COMMAND.description)).toBeLessThanOrEqual(37);
  });
});

describe('total tool descriptions', () => {
  let fx: McpFixture;
  beforeAll(async () => {
    fx = await mcpFixture();
  }, 120_000);
  afterAll(async () => fx?.close());

  it('stays within budget (static + live descriptions)', async () => {
    let total = 0;
    // What an agent session is served (UI / ops tools are not listed for agents).
    for (const t of AGENT_TOOLS) total += tok(typeof t.description === 'string' ? t.description : await t.description({ index: fx.index } as ToolContext));
    expect(total).toBeLessThanOrEqual(TOTAL_BUDGET);
  });

  it('the default list (core) stays small: descriptions and schemas', () => {
    const core = listedTools(new Set(DEFAULT_SETS));
    expect(core.length).toBeLessThanOrEqual(50);
    // 5,883 description and 16,137 schema tokens over the 47 core tools (the whole request flow: the former intake set moved into core;
    // before that 3,624 / 9,335 over 29 tools; every tool: ~11,221 / ~26,870).
    expect(core.reduce((n, t) => n + tok(t.description as string), 0)).toBeLessThanOrEqual(6200);
    expect(core.reduce((n, t) => n + tok(JSON.stringify(toolJsonSchema(t))), 0)).toBeLessThanOrEqual(16900);
  });

  it('input schemas served to agents stay within budget (edge kinds as strings, per-kind section fields and link rels)', () => {
    let total = 0;
    for (const t of AGENT_TOOLS) total += tok(JSON.stringify(toolJsonSchema(t)));
    // 28,865 over 143 tools before the prompts review; 26,870 over the 132 agent tools after it (incl. the 5 question tools);
    // 22,513 over the 98 tools of all sets after merging per-type tools (tool-sets.ts).
    expect(total).toBeLessThanOrEqual(23200);
    const gn = AGENT_TOOLS.find((t) => t.name === 'graph_neighbors')!;
    expect(JSON.stringify(toolJsonSchema(gn))).not.toContain('duplicate_finding_of');
  });
});

/** Agent-served tool descriptions together (was ~20,070 tokens: 18,577 static + graph_query 1,489; 15,019 before the prompts review; 11221 before the tool sets; 10,882 over the 98 tools of all sets after merging per-type tools). */
const TOTAL_BUDGET = 11200;

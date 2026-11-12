/** Graph tools: traversal, temporal queries, Cypher, batch (thin wrappers over IndexService). */
import {
  BATCH_OPS,
  graphBatchInputSchema,
  graphChangesInputSchema,
  graphEvolutionInputSchema,
  graphHistoryInputSchema,
  graphImpactInputSchema,
  graphNeighborsInputSchema,
  graphNodeInputSchema,
  graphPathInputSchema,
  graphQueryInputSchema,
  graphSchemaInputSchema,
  type GraphSchema,
} from '@mandate/shared';
import { defineTool, needIndex, type ToolContext } from '../define.js';
import { normalizeMissing } from '../errors.js';

const REFS = '`at` (sha | seq | ISO date) = past state.';

/** Example queries (tested); the first is embedded in the graph_query description, graph_schema returns its own list. */
export const CYPHER_EXAMPLES = [
  { question: 'Specs depending on a spec (up to 3 hops)', query: 'MATCH (x)-[:SPEC_DEPENDS_ON*1..3]->(s:Spec {ref: $ref}) RETURN DISTINCT x.ref, labels(x)' },
  { question: 'Sections referencing a file, with the standards their specs use', query: "MATCH (s:Section)-[:REFERENCES_CODE]->(c:CodeRange) WHERE c.path = 'src/auth/session.ts' MATCH (d)-[:HAS_SECTION]->(s) OPTIONAL MATCH (d)-[:USES_STANDARD]->(std:Standard) RETURN s.ref, c.ref, collect(DISTINCT std.ref) AS standards" },
  { question: 'Open feedback per standard section', query: "MATCH (f:Feedback)-[:TARGETS]->(s:Section)<-[:HAS_SECTION]-(d:Standard) WHERE f.status = 'open' RETURN s.ref, count(f) AS open ORDER BY open DESC" },
  { question: 'Section-level depends_on links', query: 'MATCH (s:Section)-[:DEPENDS_ON]->(b:Section) RETURN s.ref AS blocked, b.ref AS blocker' },
  { question: 'Recent commits by agents and the specs they changed', query: "MATCH (c:Commit)-[:AUTHORED_BY]->(a:Agent), (c)-[ch:CHANGED]->(d:Spec) RETURN a.name, c.ref, d.ref, ch.changeKinds ORDER BY c.seq DESC LIMIT 20" },
];

/** Compact text form of graph_schema for the graph_query description: names only (graph_schema has the detail). */
export function schemaText(s: GraphSchema): string {
  return `Labels: ${s.labels.map((l) => l.label).join(', ')}\nRelationships: ${s.relationships.filter((r) => !r.deprecated).map((r) => r.type).join(', ')}`;
}

let schemaCache: { at: number; text: string } | null = null;
async function graphQueryDescription(ctx: ToolContext): Promise<string> {
  const ex = CYPHER_EXAMPLES[0]!;
  const head = `Read-only openCypher over the temporal graph. Call graph_schema first for properties, endpoints, functions and examples.
MATCH / OPTIONAL MATCH / WHERE / WITH / RETURN / ORDER BY / SKIP / LIMIT / DISTINCT, var-length paths (≤ *..6), EXISTS { }, aggregates. No writes, CALL or shortestPath() (use graph_path).
params: $name values (refs resolved). at: sha | seq | ISO date | versioned ref (default HEAD; temporal filtering automatic). limit ≤ 5000 (default 500); 2 s timeout.
Returns nodes { ref, kind, label, props }, rels { type, from, to, props }, paths [node, rel, …].
Example: ${ex.query}`;
  if (!ctx.index) return head;
  if (!schemaCache || Date.now() - schemaCache.at > 60_000) {
    try {
      schemaCache = { at: Date.now(), text: schemaText(await ctx.index.graphSchema({})) };
    } catch {
      return head;
    }
  }
  return `${head}\n${schemaCache.text}`;
}

export const graphTools = [
  defineTool({
    name: 'graph_node',
    title: 'Graph node',
    kind: 'read',
    description: `Resolve any ref to its graph node: kind, label, props, canonical ref, live/deleted and edges grouped by kind. ${REFS}
Example: {"uri":"mandate://specs/login-sso/sections/auth-flow"}`,
    input: graphNodeInputSchema,
    run: (a, ctx) => needIndex(ctx).graphNode(a),
  }),
  defineTool({
    name: 'graph_neighbors',
    title: 'Graph neighbours',
    kind: 'read',
    description: `Nodes around a node: kinds (edge kinds, e.g. has_section, depends_on, follows, spec_depends_on, uses_standard, references_code, covers, acts_on, changed), direction, depth. Paginated. ${REFS}
Example: {"uri":"mandate://specs/login-sso","kinds":["uses_standard","spec_depends_on"],"depth":2}`,
    input: graphNeighborsInputSchema,
    run: (a, ctx) => needIndex(ctx).graphNeighbors(a),
  }),
  defineTool({
    name: 'graph_path',
    title: 'Graph path',
    kind: 'read',
    description: `Shortest path between two nodes (optional edge kinds). ${REFS}
Example: {"from":"mandate://symbols/SessionStore.create","to":"mandate://standards/security-baseline"}`,
    input: graphPathInputSchema,
    run: (a, ctx) => needIndex(ctx).graphPath(a),
  }),
  defineTool({
    name: 'graph_impact',
    title: 'Impact analysis',
    kind: 'read',
    description: `What is affected if a node changes: depends_on, standard usage and deviations, code ranges -> sections -> specs; depth per node. ${REFS}
Example: {"uri":"mandate://standards/security-baseline"}`,
    input: graphImpactInputSchema,
    run: (a, ctx) => needIndex(ctx).graphImpact(a),
  }),
  defineTool({
    name: 'graph_history',
    title: 'Node history',
    kind: 'read',
    description: `Change events for a doc, section, symbol or code file (commit, author/agent, action, change kinds). Filters: since/until, kinds (text|metadata|status), agent. Paginated. ${REFS}
Example: {"uri":"mandate://specs/login-sso/sections/auth-flow","kinds":["text"]}`,
    input: graphHistoryInputSchema,
    run: (a, ctx) => needIndex(ctx).graphHistory(a),
  }),
  defineTool({
    name: 'graph_changes',
    title: 'Graph changes',
    kind: 'read',
    description: `Graph diff between two points (to defaults to HEAD): nodes / edges added or removed, content changes. within: a doc or section; kinds: edge kinds.
Example: {"from":"2026-11-01","within":"mandate://specs/login-sso"}`,
    input: graphChangesInputSchema,
    run: (a, ctx) => needIndex(ctx).graphChanges(a),
  }),
  defineTool({
    name: 'graph_evolution',
    title: 'Node evolution',
    kind: 'read',
    description: `When each edge of a node appeared or disappeared (commit, date). ${REFS}
Example: {"uri":"mandate://specs/login-sso"}`,
    input: graphEvolutionInputSchema,
    run: (a, ctx) => needIndex(ctx).graphEvolution(a),
  }),
  defineTool({
    name: 'graph_query',
    title: 'Cypher query',
    kind: 'read',
    description: graphQueryDescription,
    input: graphQueryInputSchema,
    run: (a, ctx) => needIndex(ctx).graphQuery(a),
  }),
  defineTool({
    name: 'graph_schema',
    title: 'Graph schema',
    kind: 'read',
    description: `Graph labels with properties, relationship types (endpoints, reverse names), functions and example queries. Call before writing graph_query Cypher.
Example: {}`,
    input: graphSchemaInputSchema,
    run: (_a, ctx) => needIndex(ctx).graphSchema({}),
  }),
  defineTool({
    name: 'graph_batch',
    title: 'Batch graph and search ops',
    kind: 'read',
    description: `Up to 20 search / graph ops in one call, results in order; a failing op returns { ok: false, error }. op: ${BATCH_OPS.join(', ')}; args = the matching tool's input.
Example: {"ops":[{"op":"graphNode","args":{"uri":"mandate://specs/login-sso"}}]}`,
    input: graphBatchInputSchema,
    run: async (a, ctx) =>
      (await needIndex(ctx).graphBatch(a)).map((r) => (r.ok ? r : { ...r, error: normalizeMissing(r.error) })),
  }),
];

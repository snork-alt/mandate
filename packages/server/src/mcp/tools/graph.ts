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

const REFS = 'Every reference works as copied (with or without `@mandate:`; `@sha` pins that version, `#Lx-Ly` an excerpt). `at` (sha | seq | ISO date) queries the graph as it was then; deleted docs stay resolvable.';

/** Five example queries embedded in the graph_query description (the full list is in graph_schema). */
export const CYPHER_EXAMPLES = [
  { question: 'Specs depending on a spec (up to 3 hops)', query: 'MATCH (x)-[:DEPENDS_ON*1..3]->(s:Spec {ref: $ref}) RETURN DISTINCT x.ref, labels(x)' },
  { question: 'Sections referencing a file, with the standards their specs use', query: "MATCH (s:Section)-[:REFERENCES_CODE]->(c:CodeRange) WHERE c.path = 'src/auth/session.ts' MATCH (d)-[:HAS_SECTION]->(s) OPTIONAL MATCH (d)-[:USES_STANDARD]->(std:Standard) RETURN s.ref, c.ref, collect(DISTINCT std.ref) AS standards" },
  { question: 'Open feedback per standard section', query: "MATCH (f:Feedback)-[:TARGETS]->(s:Section)<-[:HAS_SECTION]-(d:Standard) WHERE f.status = 'open' RETURN s.ref, count(f) AS open ORDER BY open DESC" },
  { question: 'Section-level depends_on links', query: "MATCH (s:Section)-[l:LINKS_TO]->(b:Section) WHERE l.rel = 'depends_on' RETURN s.ref AS blocked, b.ref AS blocker" },
  { question: 'Recent commits by agents and the specs they changed', query: "MATCH (c:Commit)-[:AUTHORED_BY]->(a:Agent), (c)-[ch:CHANGED]->(d:Spec) RETURN a.name, c.ref, d.ref, ch.changeKinds ORDER BY c.seq DESC LIMIT 20" },
];

/** Compact text form of graph_schema for tool descriptions. */
export function schemaText(s: GraphSchema): string {
  const labels = s.labels.map((l) => `${l.label}(${l.properties.join(',')})`).join('; ');
  const rels = s.relationships
    .map((r) => `${r.type}${r.from.length || r.to.length ? ` ${r.from.join('|') || '*'}->${r.to.join('|') || '*'}` : ''}`)
    .join('; ');
  return `Labels: ${labels}\nRelationships: ${rels}\nFunctions: ${s.functions.join(', ')}`;
}

let schemaCache: { at: number; text: string } | null = null;
async function graphQueryDescription(ctx: ToolContext): Promise<string> {
  const head = `Read-only openCypher subset over the temporal knowledge graph, compiled to SQLite. params: $name values (references in params and string literals are resolved like resolveRef). at: sha | seq | ISO date | versioned reference (default HEAD; temporal filtering is automatic). limit: row cap (default 500, max 5000); 2 s timeout; variable-length paths up to *..6.
Supported: MATCH / OPTIONAL MATCH / WHERE / WITH / RETURN / ORDER BY / SKIP / LIMIT / DISTINCT, var-length relationships, EXISTS { }, aggregates. Not supported: writes, shortestPath() (use graph_path), CALL procedures.
Nodes come back as { ref, kind, label, props } (ref = the graph key, usable in every tool), relationships as { type, from, to, props }, paths as [node, rel, node, ...].
Examples:
${CYPHER_EXAMPLES.map((e) => `- ${e.question}: ${e.query}`).join('\n')}`;
  if (!ctx.index) return head;
  if (!schemaCache || Date.now() - schemaCache.at > 60_000) {
    try {
      schemaCache = { at: Date.now(), text: schemaText(await ctx.index.graphSchema({})) };
    } catch {
      return head;
    }
  }
  return `${head}\nSchema (graph_schema):\n${schemaCache.text}`;
}

export const graphTools = [
  defineTool({
    name: 'graph_node',
    title: 'Graph node',
    kind: 'read',
    description: `Resolve any reference to its graph node: kind, label, props, canonical ref, live/deleted state and its edges grouped by kind (both directions, limit per group). ${REFS}
Example: {"uri":"@mandate:mandate://specs/login-sso@3f2a9c1/sections/auth-flow"}`,
    input: graphNodeInputSchema,
    run: (a, ctx) => needIndex(ctx).graphNode(a),
  }),
  defineTool({
    name: 'graph_neighbors',
    title: 'Graph neighbours',
    kind: 'read',
    description: `Nodes around a node: kinds (edge kinds), direction (out|in|both), depth ≤ 3, paginated (limit ≤ 500, cursor). Edges: has_section, depends_on, uses_standard, applies_to, links_to, mentions_symbol, references_code, in_file, in_repo, covers, targets, changed, verifies, similar_to, version_of, ... ${REFS}
Example: {"uri":"mandate://specs/login-sso","kinds":["uses_standard","depends_on"],"depth":2}`,
    input: graphNeighborsInputSchema,
    run: (a, ctx) => needIndex(ctx).graphNeighbors(a),
  }),
  defineTool({
    name: 'graph_path',
    title: 'Graph path',
    kind: 'read',
    description: `Shortest path between two nodes (maxDepth ≤ 6, optional edge kinds). ${REFS}
Example: {"from":"mandate://symbols/SessionStore.create","to":"mandate://standards/security-baseline"}`,
    input: graphPathInputSchema,
    run: (a, ctx) => needIndex(ctx).graphPath(a),
  }),
  defineTool({
    name: 'graph_impact',
    title: 'Impact analysis',
    kind: 'read',
    description: `What is affected if this node changes: follows depends_on links, standard usage and deviations (and code ranges -> sections -> specs by line overlap), with depth per node. ${REFS}
Example: {"uri":"mandate://code/app/src/auth/session.ts#L30-L35"} or {"uri":"mandate://standards/security-baseline"}`,
    input: graphImpactInputSchema,
    run: (a, ctx) => needIndex(ctx).graphImpact(a),
  }),
  defineTool({
    name: 'graph_history',
    title: 'Node history',
    kind: 'read',
    description: `Ordered change events for a doc, section, symbol or code file (commit, author/agent, action, change kinds, lines). Filters: since/until (sha|seq|date), kinds (text|metadata|status), agent. Paginated. ${REFS}
Example: {"uri":"mandate://specs/login-sso/sections/auth-flow","kinds":["text"]}`,
    input: graphHistoryInputSchema,
    run: (a, ctx) => needIndex(ctx).graphHistory(a),
  }),
  defineTool({
    name: 'graph_changes',
    title: 'Graph changes',
    kind: 'read',
    description: `Graph diff between two points in history (to defaults to HEAD): nodes and edges added or removed, content changes with diffDocs summaries. within: limit to a doc or section. kinds: edge kinds.
Example: {"from":"2026-11-01","within":"mandate://specs/login-sso"}`,
    input: graphChangesInputSchema,
    run: (a, ctx) => needIndex(ctx).graphChanges(a),
  }),
  defineTool({
    name: 'graph_evolution',
    title: 'Node evolution',
    kind: 'read',
    description: `Timeline of a node's relationships: when each edge appeared or disappeared (commit, date). ${REFS}
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
    description: `Labels (with properties), relationship types (with endpoint labels and reverse names), functions and example questions/queries for graph_query. Call it before writing a Cypher query.
Example: {}`,
    input: graphSchemaInputSchema,
    run: (_a, ctx) => needIndex(ctx).graphSchema({}),
  }),
  defineTool({
    name: 'graph_batch',
    title: 'Batch graph and search ops',
    kind: 'read',
    description: `Up to 20 search / graph ops in one call; results in order, a failing op returns { ok: false, error } without failing the batch. op is the service name: ${BATCH_OPS.join(', ')}; args are that op's input (same as the matching tool, e.g. graphNode args = graph_node input).
Example: {"ops":[{"op":"graphNode","args":{"uri":"mandate://specs/login-sso"}},{"op":"symbolSearch","args":{"name":"AuthService","match":"prefix"}}]}`,
    input: graphBatchInputSchema,
    run: async (a, ctx) =>
      (await needIndex(ctx).graphBatch(a)).map((r) => (r.ok ? r : { ...r, error: normalizeMissing(r.error) })),
  }),
];

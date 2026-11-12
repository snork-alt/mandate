/** `graph_query` (read-only Cypher subset over the temporal graph) and `graph_schema`. */
import {
  EDGE_KINDS,
  REVERSE_EDGE_NAMES,
  graphQueryInputSchema,
  graphSchemaInputSchema,
  parseNodeUri,
  DERIVED_REL_TYPES,
  relTypeOf,
  type CommitPoint,
  type GraphNode,
  type GraphQueryInput,
  type GraphQueryResult,
  type GraphSchema,
} from '@mandate/shared';
import { parseJson } from '../db.js';
import { labelOf, pub, resolveAt, resolveRef, type GraphContext, type Point } from '../resolve.js';
import { LABELS, REL_TYPES, compileCypher, type VType, type VirtualEdge, type VirtualNode } from './compile.js';
import { CypherError, FUNCTIONS, parseCypher, type Expr, type Query } from './parser.js';
import type { SqlTarget } from './target.js';

/** Executes compiled Cypher: the SQLite worker runner, or the Postgres runner (pg/runner.ts) with its SQL target. */
export interface CypherExec {
  run(sql: string, binds: Record<string, unknown>, explain?: boolean): Promise<unknown[]>;
  readonly target?: SqlTarget;
  /** Rows a variable-length expansion may produce before the query fails with `cypher_budget`. */
  readonly varLengthBudget?: number;
}

export { CypherError } from './parser.js';
export { CypherRunner } from './runner.js';

const looksLikeRef = (v: unknown): v is string => typeof v === 'string' && /^(?:@mandate:)?mandate:\/\//.test(v.trim());

/** String literals of the query that look like references (they are resolved like `$ref` parameters). */
function refLiterals(q: Query): string[] {
  const out: string[] = [];
  const walk = (x: unknown): void => {
    if (!x || typeof x !== 'object') return;
    if (Array.isArray(x)) return x.forEach(walk);
    const e = x as Expr;
    if (e.t === 'lit' && looksLikeRef(e.v)) out.push(e.v as string);
    for (const v of Object.values(x)) walk(v);
  };
  walk(q.clauses);
  return out;
}

export async function graphQuery(ctx: GraphContext, runner: CypherExec, input: GraphQueryInput): Promise<GraphQueryResult> {
  const inp = graphQueryInputSchema.parse(input);
  const t0 = performance.now();
  const ast = parseCypher(inp.query);

  let at: Point | null = null;
  if (inp.at !== undefined) {
    if (typeof inp.at === 'string' && parseNodeUri(inp.at)) {
      const r = await resolveRef(ctx, inp.at);
      if (!r.at) throw new CypherError('`at` must pin a point in time: a sha, a date or a versioned reference (@sha)', null, undefined, 'cypher_invalid_at');
      at = r.at;
    } else at = resolveAt(ctx.db, inp.at);
  }
  const seq = at?.seq ?? null;

  // References in parameters and literals resolve to their canonical node (excerpts become virtual nodes).
  const virtualNodes: VirtualNode[] = [];
  const virtualEdges: VirtualEdge[] = [];
  const seen = new Set<string>();
  const boundVersions = new Set<string>();
  const canon = async (v: string): Promise<string> => {
    const r = await resolveRef(ctx, v, at?.sha);
    if (r.node.kind === 'version') boundVersions.add(r.node.uri);
    if (r.node.kind === 'excerpt' && !seen.has(r.node.uri)) {
      seen.add(r.node.uri);
      virtualNodes.push({ uri: r.node.uri, kind: r.node.kind, label: r.node.label, props: r.node.props });
      for (const e of ctx.virtual?.get(r.node.uri)?.edges ?? []) virtualEdges.push({ from: e.from_uri, to: e.to_uri, kind: e.kind, props: e.props ? parseJson(e.props, {}) : null });
    }
    return r.node.uri;
  };
  const params: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(inp.params)) {
    params[k] = looksLikeRef(v) ? await canon(v) : Array.isArray(v) ? await Promise.all(v.map((x) => (looksLikeRef(x) ? canon(x) : x))) : v;
  }
  const refs = new Map<string, string>();
  // Literals may be prefixes or patterns (`STARTS WITH 'mandate://specs/'`): canonicalise only those that resolve.
  for (const lit of refLiterals(ast)) refs.set(lit, await canon(lit).catch(() => lit));

  const compiled = compileCypher(ast.clauses, { seq, params, refs, virtualNodes, virtualEdges, boundVersions: [...boundVersions], rowCap: inp.limit, ...(runner.target ? { target: runner.target } : {}), ...(runner.varLengthBudget ? { varLengthBudget: runner.varLengthBudget } : {}) });
  const rows = (await runner.run(compiled.sql, compiled.binds)) as unknown[][];
  const truncated = rows.length > inp.limit;
  const nodeCache = new Map<string, GraphNode>();
  const node = (uri: unknown): GraphNode | null => {
    if (uri === null || uri === undefined) return null;
    const u = String(uri);
    if (!nodeCache.has(u)) {
      const n = labelOf(ctx, u, seq);
      nodeCache.set(u, { ref: n.ref, kind: n.kind, label: n.label, props: n.props } as GraphNode);
    }
    return nodeCache.get(u)!;
  };
  const rel = (v: unknown) => {
    const r = typeof v === 'string' ? parseJson<Record<string, unknown>>(v, {}) : (v as Record<string, unknown> | null);
    return r ? { type: r.type, from: r.from, to: r.to, props: r.props ?? {} } : null;
  };
  const list = (v: unknown): unknown[] => (typeof v === 'string' ? parseJson<unknown[]>(v, []) : Array.isArray(v) ? v : []);
  const hydrate = (v: unknown, type: VType): unknown => {
    if (v === null || v === undefined) return null;
    switch (type) {
      case 'node':
        return node(v);
      case 'rel':
        return rel(v);
      case 'path': {
        const p = parseJson<{ nodes: string[]; rels: unknown[] }>(String(v), { nodes: [], rels: [] });
        const out: unknown[] = [node(p.nodes[0])];
        p.rels.forEach((r, i) => out.push(rel(r), node(p.nodes[i + 1])));
        return out;
      }
      case 'list<node>':
        return list(v).map(node);
      case 'list<rel>':
        return list(v).map(rel);
      case 'list':
        return list(v);
      case 'bool':
        return v === 1 ? true : v === 0 ? false : v;
      case 'json':
        return typeof v === 'string' && /^[[{]/.test(v) ? parseJson(v, v) : v;
      default:
        return v;
    }
  };
  return {
    columns: compiled.columns.map((c) => c.name),
    rows: rows.slice(0, inp.limit).map((r) => r.map((v, i) => hydrate(v, compiled.columns[i]!.type))),
    truncated,
    at: pub(at),
    elapsedMs: Math.round((performance.now() - t0) * 10) / 10,
  };
}

/** The EXPLAIN QUERY PLAN of a query (tests, debugging). */
export async function explainQuery(ctx: GraphContext, runner: CypherExec, query: string, params: Record<string, unknown> = {}): Promise<string[]> {
  const ast = parseCypher(query);
  const compiled = compileCypher(ast.clauses, { seq: null, params, refs: new Map(), virtualNodes: [], virtualEdges: [], boundVersions: [], rowCap: 500, ...(runner.target ? { target: runner.target } : {}) });
  const rows = (await runner.run(compiled.sql, compiled.binds, true)) as { detail: string }[];
  void ctx;
  return rows.map((r) => r.detail);
}

export const EXAMPLE_QUERIES: { question: string; query: string }[] = [
  {
    question: 'Which spec sections reference src/auth/session.ts, and which standards do they follow?',
    query: "MATCH (s:Section)-[:REFERENCES_CODE]->(c:CodeRange) WHERE c.path = 'src/auth/session.ts' OPTIONAL MATCH (s)-[:FOLLOWS|DEVIATES_FROM]->(t) RETURN s.ref, c.ref, collect(DISTINCT t.ref) AS standards",
  },
  { question: 'Sections blocked by another section (depends_on links)', query: 'MATCH (s:Section)-[:DEPENDS_ON]->(b:Section) RETURN s.ref AS blocked, b.ref AS blocker' },
  { question: 'Spec dependency cycles (derived document-level spec_depends_on)', query: 'MATCH p = (a:Spec)-[:SPEC_DEPENDS_ON*1..5]->(a) RETURN a.ref, length(p) AS hops LIMIT 10' },
  { question: 'Work orders acting on feedback, with who filed it (server mode)', query: 'MATCH (w:WorkOrder)-[:ACTS_ON]->(f:Feedback) OPTIONAL MATCH (f)-[:FILED_BY]->(u:User) RETURN w.ref, f.ref, u.login' },
  { question: 'Spec sections a work order covers (through its sections)', query: 'MATCH (w:WorkOrder {ref: $ref})-[:HAS_SECTION]->(ws:Section)-[c:COVERS]->(s:Section) RETURN ws.ref, c.status, s.ref' },
  {
    question: 'Acceptance criteria without a passing verification, for specs using security-baseline',
    query:
      "MATCH (d:Spec)-[:USES_STANDARD]->(:Standard {ref: 'mandate://standards/security-baseline'}) MATCH (d)-[:HAS_SECTION]->(c:AcceptanceSection) WHERE NOT EXISTS { (v:Verification)-[:VERIFIES]->(c) WHERE v.result = 'pass' } RETURN d.ref, c.ref, c.title",
  },
  { question: 'Open feedback per standard section', query: "MATCH (f:Feedback)-[:TARGETS]->(s:Section)<-[:HAS_SECTION]-(d:Standard) WHERE f.status = 'open' RETURN s.ref, count(f) AS open ORDER BY open DESC" },
  {
    question: 'Architecture: component containment (parent contains child) with each child layer',
    query: 'MATCH (p:Component)-[:CONTAINS]->(c:Component) RETURN p.ref AS parent, c.ref AS child, c.layer AS layer',
  },
  {
    question: 'Architecture: component dependencies (depends_on from component sections) and the code each component owns',
    query:
      "MATCH (a:Component)-[:HAS_SECTION]->(s:Section)-[:DEPENDS_ON]->(b) WHERE b.ref STARTS WITH 'mandate://components/' OPTIONAL MATCH (f:CodeFile)-[:OWNED_BY]->(a) RETURN a.ref, a.componentKind, collect(DISTINCT b.ref) AS dependsOn, count(DISTINCT f) AS ownedFiles",
  },
  {
    question: 'Rules that govern a code file (by scope), strictest first, with how they are checked',
    query: "MATCH (r:Rule)-[:GOVERNS]->(f:CodeFile) WHERE f.path STARTS WITH 'src/' RETURN f.ref, r.ref, r.level, r.check ORDER BY r.level",
  },
  { question: 'Commits by an agent that changed a spec', query: "MATCH (c:Commit)-[:AUTHORED_BY]->(a:Agent), (c)-[ch:CHANGED]->(d:Spec) WHERE a.name STARTS WITH 'claude' RETURN c.ref, d.ref, ch.changeKinds ORDER BY c.date DESC LIMIT 20" },
  {
    question: 'What changed in a spec since it was implemented',
    query:
      "MATCH (d:Spec {ref: $ref}) MATCH (ic:Commit) WHERE ic.sha STARTS WITH d.implementedCommit MATCH (c:Commit)-[ch:CHANGED]->(x) WHERE isAncestor(ic, c) AND (x.ref = d.ref OR x.docUri = d.ref) RETURN c.ref, x.ref, ch.changeKinds",
  },
  { question: 'Versions of a section with the commits that made them', query: 'MATCH (v:Version)-[:VERSION_OF]->(s {ref: $ref}) MATCH (v)-[:CREATED_IN]->(c:Commit) RETURN v.ref, v.action, c.date ORDER BY c.date' },
  {
    question: 'A path from a symbol to a standard (structural relationships only)',
    query: 'MATCH p = (y:Symbol {ref: $symbol})-[:MENTIONS_SYMBOL|HAS_SECTION|FOLLOWS|DEVIATES_FROM|USES_STANDARD*1..4]-(s:Standard) RETURN p ORDER BY length(p) LIMIT 1',
  },
];

/** Labels with property names, relationship types with endpoint labels and reverse names, functions and examples. */
export function graphSchema(ctx: GraphContext, input: Record<string, never> = {}): GraphSchema {
  graphSchemaInputSchema.parse(input);
  const props = ctx.db.prepare('SELECT DISTINCT n.kind, j.key FROM nodes n, json_each(n.props) j WHERE n.valid_to IS NULL ORDER BY n.kind, j.key').all() as { kind: string; key: string }[];
  const ends = ctx.db
    .prepare(
      `SELECT DISTINCT e.kind, f.kind AS fk, t.kind AS tk FROM edges e
         JOIN nodes f ON f.uri = e.from_uri AND f.valid_to IS NULL JOIN nodes t ON t.uri = e.to_uri AND t.valid_to IS NULL WHERE e.valid_to IS NULL`,
    )
    .all() as { kind: string; fk: string; tk: string }[];
  const labelOfKind = new Map([...LABELS].filter(([, d]) => !d.prop).map(([l, d]) => [d.kind, l]));
  return {
    labels: [...LABELS].map(([label, d]) => ({
      label,
      kind: d.kind,
      description: d.prop ? `${labelOfKind.get(d.kind)} with ${d.prop} = '${d.value}'` : `${d.kind} nodes`,
      properties: ['ref', 'kind', 'label', ...props.filter((p) => p.kind === d.kind).map((p) => p.key)],
    })),
    relationships: [...REL_TYPES].map(([type, d]) => {
      const alias = DERIVED_REL_TYPES[type];
      const kind = alias ? type.toLowerCase() : d.kinds[0]!;
      const mine = ends.filter((e) => d.kinds.includes(e.kind));
      return {
        type,
        kind,
        reverse: alias ? 'LINKED_FROM' : (REVERSE_EDGE_NAMES[kind as (typeof EDGE_KINDS)[number]]?.toUpperCase() ?? ''),
        from: [...new Set(mine.map((e) => labelOfKind.get(e.fk) ?? e.fk))],
        to: [...new Set(mine.map((e) => labelOfKind.get(e.tk) ?? e.tk))],
        ...(alias
          ? {
              description: `DEPRECATED alias (one release): any of ${d.kinds.map((k) => relTypeOf(k as (typeof EDGE_KINDS)[number])).join('|')}; l.rel reads the link's rel. ${alias.deprecated ?? ''}`.trim(),
              deprecated: true,
            }
          : {}),
      };
    }),
    functions: [...FUNCTIONS],
    examples: EXAMPLE_QUERIES,
  };
}

/**
 * Compiles the Cypher AST to one SQL statement (CTEs; recursive CTEs for variable-length
 * relationships). Every node and edge comes from the `N` / `E` CTEs, which hold exactly the
 * rows valid at the query's point in time: queries never see (or write) the temporal filter.
 * This file is the shared plan (scopes, patterns, anchoring, aggregation, type checks); the SQL spelling comes from a
 * target: SQLite (target.ts, the default) or Postgres (pg/target.ts).
 */
import { DERIVED_LABELS, DERIVED_REL_TYPES, EDGE_KINDS, NODE_LABELS, relTypeOf } from '@mandate/shared';
import { CypherError, isAggregate, suggest, type Clause, type Expr, type NodePat, type Pattern, type Pos, type RelPat } from './parser.js';
import { NUMERIC_OPS, sqliteTarget, type SqlTarget } from './target.js';

export type VType = 'node' | 'rel' | 'path' | 'list<node>' | 'list<rel>' | 'list' | 'json' | 'bool' | 'scalar';

interface Var {
  type: VType;
  /** SQL expression for the variable in the current scope. */
  sql: string;
}
type Scope = Map<string, Var>;

export interface VirtualNode {
  uri: string;
  kind: string;
  label: string;
  props: Record<string, unknown>;
}
export interface VirtualEdge {
  from: string;
  to: string;
  kind: string;
  props: Record<string, unknown> | null;
}

export interface CompileOptions {
  /** Commit seq the graph is read at; null = HEAD. */
  seq: number | null;
  params: Record<string, unknown>;
  /** Canonical replacements for reference literals (copied forms -> node uri). */
  refs: Map<string, string>;
  virtualNodes: VirtualNode[];
  virtualEdges: VirtualEdge[];
  /** Version nodes bound from a reference: their outgoing edges are the live node's edges at the version. */
  boundVersions: string[];
  /** Rows returned at most (one more is fetched to detect truncation). */
  rowCap: number;
  /** SQL dialect (default SQLite). */
  target?: SqlTarget;
  /** Rows a variable-length expansion may produce before the query fails with `cypher_budget` (default VAR_LENGTH_ROW_BUDGET). */
  varLengthBudget?: number;
}

export interface Compiled {
  sql: string;
  binds: Record<string, unknown>;
  columns: { name: string; type: VType }[];
}

/** Label -> node kind (+ optional property constraint). */
export const LABELS: Map<string, { kind: string; prop?: string; value?: string }> = new Map([
  ...Object.entries(NODE_LABELS).map(([kind, label]) => [label, { kind }] as const),
  ...Object.entries(DERIVED_LABELS).map(([label, d]) => [label, { kind: d.kind, prop: d.prop, value: d.value }] as const),
]);
/** Relationship type -> edge kinds (one, or several for an alias such as the deprecated `LINKS_TO`). */
export const REL_TYPES: Map<string, { kinds: readonly string[] }> = new Map([
  ...EDGE_KINDS.map((k) => [relTypeOf(k), { kinds: [k] }] as const),
  ...Object.entries(DERIVED_REL_TYPES).map(([t, d]) => [t, { kinds: d.kinds }] as const),
]);

/** Most rows a variable-length expansion may produce; past it the query fails with `cypher_budget` (both targets). */
export const VAR_LENGTH_ROW_BUDGET = 200_000;

/** Per-row deadline check on the last FROM item of a step (non-deterministic, so evaluated per row). */
const guard = (t: SqlTarget, from: string[]) => {
  const last = from.at(-1)?.split(' AS ').pop();
  const column = last?.startsWith('n') ? 'uri' : last?.startsWith('e') ? 'id' : last?.startsWith('w') ? 'depth' : null;
  return t.guard(last && column ? `${last}.${column}` : '1');
};

const q = (name: string) => `"${name.replace(/"/g, '""')}"`;
const col = (v: string) => q(`v_${v}`);

class Compiler {
  private binds: Record<string, unknown> = {};
  private nb = 0;
  private na = 0;
  private ctes: string[] = [];
  private readonly t: SqlTarget;
  constructor(private readonly opts: CompileOptions) {
    this.t = opts.target ?? sqliteTarget;
  }
  private readonly b = (v: unknown) => this.bind(v);

  private bind(v: unknown): string {
    const name = `b${this.nb++}`;
    this.binds[name] = typeof v === 'boolean' ? (v ? 1 : 0) : v;
    return `@${name}`;
  }
  private alias(p: string) {
    return `${p}${this.na++}`;
  }

  /* ------------------------------------------------------------ N and E */

  private valid(a: string, seqExpr: string | null): string {
    return seqExpr === null ? `${a}.valid_to IS NULL` : `${a}.valid_from <= ${seqExpr} AND (${a}.valid_to IS NULL OR ${a}.valid_to > ${seqExpr})`;
  }

  private baseCtes(): string[] {
    const t = this.t;
    const s = this.opts.seq === null ? null : t.int(this.bind(this.opts.seq));
    const vn = this.opts.virtualNodes.map(
      (n) => `SELECT ${t.text(this.bind(n.uri))}, ${t.text(this.bind(n.kind))}, ${t.text(this.bind(n.label))}, ${t.text(this.bind(JSON.stringify(n.props)))}, 0`,
    );
    const ve = this.opts.virtualEdges.map(
      (e, i) =>
        `SELECT 'x${i}', ${t.text(this.bind(e.from))}, ${t.text(this.bind(e.to))}, ${t.text(this.bind(e.kind))}, ${t.text(this.bind(e.props ? JSON.stringify(e.props) : null))}`,
    );
    const live = `SELECT ${t.name === 'postgres' ? 'e.id::text' : 'e.id'}, e.from_uri, e.to_uri, e.kind, e.props FROM ${t.table('edges')} e WHERE ${this.valid('e', s)}`;
    // Version nodes expose the live node's outgoing edges as they were at the version.
    const views = `SELECT 'v' || ${t.rowid('v')} || ':' || e.id, v.uri, e.to_uri, e.kind, e.props
      FROM ${t.table('nodes')} v JOIN ${t.table('versions')} vv ON vv.uri = v.uri JOIN ${t.table('edges')} e ON e.from_uri = vv.of_uri
       AND e.valid_from <= vv.point AND (e.valid_to IS NULL OR e.valid_to > vv.point)
     WHERE v.kind = 'version' AND v.uri IN (${this.opts.boundVersions.map((u) => t.text(this.bind(u))).join(', ') || 'NULL'}) AND ${this.valid('v', s)}`;
    const edgeRows = [live, ...(this.opts.boundVersions.length ? [views] : []), ...ve].join('\n      UNION ALL ');
    const ghosts = `SELECT g.uri, g.kind, g.label, g.props, 1 FROM (
          SELECT n.*, row_number() OVER (PARTITION BY n.uri ORDER BY n.valid_from DESC) AS rn FROM ${t.table('nodes')} n
           WHERE n.uri IN (SELECT to_uri FROM E0 UNION SELECT from_uri FROM E0) AND ${t.isNot('n.source', "'snapshot'")}
             AND NOT EXISTS (SELECT 1 FROM ${t.table('nodes')} m WHERE m.uri = n.uri AND ${this.valid('m', s)})
             ${s === null ? '' : `AND n.valid_from <= ${s}`}
        ) g WHERE g.rn = 1`;
    // Postgres inlines N / E (lookups by uri use the indexes); the ghost set is computed once (G).
    const pg = t.name === 'postgres';
    return [
      `E0(id, from_uri, to_uri, kind, props) AS ${t.materialized} (${edgeRows})`,
      `E AS ${t.materialized} (SELECT id, from_uri, to_uri, kind, props,
        ${t.relObject} AS r FROM E0)`,
      ...(pg ? [`G(uri, kind, label, props, ghost) AS MATERIALIZED (${ghosts})`] : []),
      // Nodes valid at the point, plus the last known state of nodes still referenced by a valid edge (e.g. deleted targets).
      // One row per uri even if several rows of a node are valid at the point (the latest one wins).
      `N(uri, kind, label, props, ghost) AS ${t.materialized} (
        SELECT n.uri, n.kind, n.label, n.props, 0 FROM ${t.table('nodes')} n WHERE ${this.valid('n', s)}
           AND NOT EXISTS (SELECT 1 FROM ${t.table('nodes')} m WHERE m.uri = n.uri AND m.valid_from > n.valid_from AND ${this.valid('m', s)})
        UNION ALL
        ${pg ? 'SELECT uri, kind, label, props, ghost FROM G' : ghosts}
        ${vn.length ? `UNION ALL ${vn.join(' UNION ALL ')}` : ''})`,
    ];
  }

  /* ------------------------------------------------------------ expressions */

  private nodeField(uriSql: string, field: 'kind' | 'label' | 'props') {
    return `(SELECT ${field} FROM N WHERE N.uri = ${uriSql}${this.t.oneRow})`;
  }

  expr(e: Expr, scope: Scope, allowAgg = false): { sql: string; type: VType } {
    switch (e.t) {
      case 'lit':
        if (e.v === null) return { sql: this.t.nullValue, type: 'scalar' };
        if (typeof e.v === 'boolean') return { sql: this.t.boolLit(e.v), type: 'bool' };
        if (typeof e.v === 'string') return { sql: this.t.value(this.opts.refs.get(e.v) ?? e.v, this.b), type: 'scalar' };
        return { sql: this.t.value(e.v, this.b), type: 'scalar' };
      case 'param': {
        if (!(e.name in this.opts.params)) throw new CypherError(`missing parameter $${e.name}`, e.pos, suggest(e.name, Object.keys(this.opts.params)));
        const v = this.opts.params[e.name];
        if (Array.isArray(v) || (v && typeof v === 'object')) return { sql: this.t.jsonParam(v, this.b), type: Array.isArray(v) ? 'list' : 'json' };
        if (typeof v === 'boolean') return { sql: this.t.name === 'postgres' ? this.t.boolLit(v) : this.bind(v), type: 'bool' };
        return { sql: v === null || v === undefined ? (this.t.name === 'postgres' ? this.t.nullValue : this.bind(null)) : this.t.value(v, this.b), type: 'scalar' };
      }
      case 'var': {
        const v = scope.get(e.name);
        if (!v) throw new CypherError(`unknown variable '${e.name}'`, e.pos, suggest(e.name, scope.keys()));
        return { sql: v.sql, type: v.type };
      }
      case 'prop': {
        const base = this.expr(e.e, scope, allowAgg);
        if (base.type === 'node') {
          if (e.key === 'ref' || e.key === 'uri') return { sql: this.t.nodeAsValue(base.sql), type: 'scalar' };
          if (e.key === 'kind' || e.key === 'label') return { sql: this.t.textAsValue(this.nodeField(base.sql, e.key)), type: 'scalar' };
          return { sql: this.t.propOf(this.nodeField(base.sql, 'props'), e.key, this.b), type: 'json' };
        }
        if (base.type === 'rel') {
          if (e.key === 'type') return { sql: this.t.relField(base.sql, 'type'), type: 'scalar' };
          return { sql: this.t.field(base.sql, ['props', e.key], this.b), type: 'json' };
        }
        if (base.type === 'path' || base.type.startsWith('list') || base.type === 'bool') {
          throw new CypherError(`cannot read property '${e.key}' of a ${base.type}`, e.pos);
        }
        return { sql: this.t.field(base.sql, [e.key], this.b), type: 'json' };
      }
      case 'index': {
        const base = this.expr(e.e, scope, allowAgg);
        const i = this.expr(e.i, scope, allowAgg);
        const elem: VType = base.type === 'list<node>' ? 'node' : base.type === 'list<rel>' ? 'rel' : 'json';
        return { sql: this.t.index(base.sql, i.sql, elem), type: elem };
      }
      case 'list': {
        const items = e.items.map((x) => this.expr(x, scope, allowAgg));
        const allNodes = items.length > 0 && items.every((x) => x.type === 'node');
        const allRels = items.length > 0 && items.every((x) => x.type === 'rel');
        return { sql: this.t.list(items), type: allNodes ? 'list<node>' : allRels ? 'list<rel>' : 'list' };
      }
      case 'map':
        return { sql: this.t.map(e.entries.map(([k, v]) => [k, this.expr(v, scope, allowAgg)]), this.b), type: 'json' };
      case 'not':
        return { sql: this.t.not(this.boolOperand(this.expr(e.e, scope, allowAgg), e.e.pos)), type: 'bool' };
      case 'neg':
        return { sql: this.t.neg(this.expr(e.e, scope, allowAgg)), type: 'scalar' };
      case 'isnull':
        return { sql: `(${this.expr(e.e, scope, allowAgg).sql} IS ${e.not ? 'NOT ' : ''}NULL)`, type: 'bool' };
      case 'exists':
        return { sql: this.existsSql(e.patterns, e.where, scope), type: 'bool' };
      case 'bin':
        return this.binary(e, scope, allowAgg);
      case 'call':
        return this.call(e, scope, allowAgg);
    }
  }

  /**
   * A value used as a condition must be a boolean: values that cannot be one (nodes, lists, numbers, strings ...) are
   * rejected; a property / JSON value is a condition only when it holds a boolean (else NULL, on both targets).
   */
  private boolOperand(x: { sql: string; type: VType }, pos: Pos): { sql: string; type: VType } {
    if (x.type === 'bool' || x.type === 'json') return x;
    throw new CypherError(`expected a boolean condition, got a ${x.type === 'scalar' ? 'number / string value' : x.type}`, pos, 'compare it explicitly, e.g. n.prop = true or n.prop IS NOT NULL', 'cypher_type');
  }
  private cond(x: Expr, scope: Scope): string {
    return this.t.cond(this.boolOperand(this.expr(x, scope), x.pos));
  }

  /** SKIP / LIMIT: a non-negative integer literal or parameter (both targets would disagree on anything else). */
  private count(x: Expr, what: string): string {
    const v = x.t === 'lit' ? x.v : x.t === 'param' ? this.opts.params[x.name] : x.t === 'neg' && x.e.t === 'lit' && typeof x.e.v === 'number' ? -x.e.v : undefined;
    if (x.t === 'param' && !(x.name in this.opts.params)) throw new CypherError(`missing parameter $${x.name}`, x.pos, suggest(x.name, Object.keys(this.opts.params)));
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) throw new CypherError(`${what} takes a non-negative integer (literal or $parameter)`, x.pos, undefined, 'cypher_type');
    return this.t.limitExpr({ sql: this.t.value(v, this.b), type: 'scalar' });
  }

  private binary(e: Extract<Expr, { t: 'bin' }>, scope: Scope, allowAgg: boolean): { sql: string; type: VType } {
    const l = this.expr(e.l, scope, allowAgg);
    const r = this.expr(e.r, scope, allowAgg);
    switch (e.op) {
      case 'AND':
      case 'OR':
        return { sql: this.t.logic(e.op, this.boolOperand(l, e.l.pos), this.boolOperand(r, e.r.pos)), type: 'bool' };
      case 'XOR':
        return { sql: this.t.compare(e.op, this.boolOperand(l, e.l.pos), this.boolOperand(r, e.r.pos)), type: 'bool' };
      case '=':
      case '<>':
      case '<':
      case '>':
      case '<=':
      case '>=':
        return { sql: this.t.compare(e.op, l, r), type: 'bool' };
      case '=~':
        return { sql: this.t.regexp(l, r), type: 'bool' };
      case 'IN':
        return { sql: this.t.inList(l, r), type: 'bool' };
      case 'STARTS WITH':
        return { sql: this.t.startsWith(l, r), type: 'bool' };
      case 'ENDS WITH':
        return { sql: this.t.endsWith(l, r), type: 'bool' };
      case 'CONTAINS':
        return { sql: this.t.contains(l, r), type: 'bool' };
      case '+':
        return { sql: this.t.add(l, r), type: l.type.startsWith('list') || r.type.startsWith('list') ? 'list' : 'scalar' };
      default:
        return { sql: NUMERIC_OPS.has(e.op) || this.t.name === 'sqlite' ? this.t.arith(e.op, l, r) : `(${l.sql} ${e.op} ${r.sql})`, type: 'scalar' };
    }
  }

  private call(e: Extract<Expr, { t: 'call' }>, scope: Scope, allowAgg: boolean): { sql: string; type: VType } {
    if (isAggregate(e.name)) {
      if (!allowAgg) throw new CypherError(`aggregate ${e.name}() is only allowed in WITH / RETURN items`, e.pos);
      if (e.star) return { sql: this.t.countStar, type: 'scalar' };
      if (e.args.length !== 1) throw new CypherError(`${e.name}() takes one argument`, e.pos);
      const a = this.expr(e.args[0]!, scope, false);
      const d = e.distinct ? 'DISTINCT ' : '';
      switch (e.name) {
        case 'collect':
          return { sql: this.t.collect(a, !!d), type: a.type === 'node' ? 'list<node>' : a.type === 'rel' ? 'list<rel>' : 'list' };
        case 'count':
          return { sql: this.t.count(a, !!d), type: 'scalar' };
        default:
          return { sql: this.t.agg(e.name, a, !!d), type: 'scalar' };
      }
    }
    const args = e.args.map((x) => this.expr(x, scope, allowAgg));
    const one = (n: number) => {
      if (args.length !== n) throw new CypherError(`${e.name}() takes ${n} argument${n === 1 ? '' : 's'}`, e.pos);
      return args[0]!;
    };
    switch (e.name) {
      case 'labels': {
        const a = one(1);
        if (a.type !== 'node') throw new CypherError('labels() takes a node', e.pos);
        return { sql: this.t.labels(this.nodeField(a.sql, 'kind'), this.nodeField(a.sql, 'props')), type: 'list' };
      }
      case 'type': {
        const a = one(1);
        if (a.type !== 'rel') throw new CypherError('type() takes a relationship', e.pos);
        return { sql: this.t.relField(a.sql, 'type'), type: 'scalar' };
      }
      case 'id': {
        const a = one(1);
        if (a.type === 'rel') return { sql: this.t.relField(a.sql, 'id'), type: 'scalar' };
        return { sql: this.t.nodeAsValue(a.sql), type: 'scalar' };
      }
      case 'nodes':
        return { sql: this.t.pathPart(this.pathArg(one(1), e.pos), 'nodes'), type: 'list<node>' };
      case 'relationships':
        return { sql: this.t.pathPart(this.pathArg(one(1), e.pos), 'rels'), type: 'list<rel>' };
      case 'length': {
        const a = one(1);
        if (a.type === 'path') return { sql: this.t.pathLength(a.sql), type: 'scalar' };
        return { sql: this.t.size(a), type: 'scalar' };
      }
      case 'size':
        return { sql: this.t.size(one(1)), type: 'scalar' };
      case 'coalesce':
        if (!args.length) throw new CypherError('coalesce() needs arguments', e.pos);
        return { sql: this.t.coalesce(args), type: args.every((a) => a.type === args[0]!.type) ? args[0]!.type : this.t.name === 'postgres' ? 'json' : args[0]!.type };
      case 'tolower':
        return { sql: this.t.lower(one(1)), type: 'scalar' };
      case 'toupper':
        return { sql: this.t.upper(one(1)), type: 'scalar' };
      case 'tostring':
        return { sql: this.t.toString(one(1)), type: 'scalar' };
      case 'tointeger':
        return { sql: this.t.toInteger(one(1)), type: 'scalar' };
      case 'isancestor': {
        // isAncestor(a, b): commit a is a proper ancestor of commit b (git ancestry, all parents).
        if (args.length !== 2 || args.some((x) => x.type !== 'node')) throw new CypherError('isAncestor(a, b) takes two Commit nodes', e.pos);
        const [a, b] = [this.t.shaOf(args[0]!.sql), this.t.shaOf(args[1]!.sql)];
        const cp = this.t.table('commit_parents');
        return {
          sql: `EXISTS (WITH RECURSIVE anc(s) AS (SELECT p.parent FROM ${cp} p WHERE p.sha = ${b} UNION SELECT p.parent FROM ${cp} p JOIN anc ON p.sha = anc.s) SELECT 1 FROM anc WHERE anc.s = ${a})`,
          type: 'bool',
        };
      }
    }
    throw new CypherError(`unknown function '${e.name}'`, e.pos);
  }

  private pathArg(a: { sql: string; type: VType }, pos: Pos) {
    if (a.type !== 'path') throw new CypherError('expected a path (bind one with p = (a)-[...]->(b))', pos);
    return a.sql;
  }

  /* ------------------------------------------------------------ patterns */

  private labelCond(a: string, labels: string[], pos: Pos): string | null {
    if (!labels.length) return null;
    const parts = labels.map((l) => {
      const d = LABELS.get(l);
      if (!d) throw new CypherError(`unknown label '${l}'`, pos, suggest(l, LABELS.keys()) ?? `labels: ${[...LABELS.keys()].join(', ')}`, 'cypher_unknown_label');
      return d.prop ? `(${a}.kind = ${this.t.text(this.bind(d.kind))} AND ${this.t.propText(`${a}.props`, d.prop, this.b)} = ${this.t.text(this.bind(d.value))})` : `${a}.kind = ${this.t.text(this.bind(d.kind))}`;
    });
    return `(${parts.join(' OR ')})`;
  }

  private typeCond(a: string, types: string[], pos: Pos): string | null {
    if (!types.length) return null;
    const parts = types.map((t) => {
      const d = REL_TYPES.get(t);
      if (!d) throw new CypherError(`unknown relationship type '${t}'`, pos, suggest(t, REL_TYPES.keys()) ?? 'see graph_schema for the relationship types', 'cypher_unknown_type');
      return d.kinds.map((k) => `${a}.kind = ${this.t.text(this.bind(k))}`).join(' OR ');
    });
    return `(${parts.join(' OR ')})`;
  }

  private nodePropConds(a: string, props: [string, Expr][], scope: Scope): string[] {
    const node: Var = { type: 'node', sql: `${a}.uri` };
    return props.map(([k, v]) => {
      const lhs = this.expr({ t: 'prop', e: { t: 'var', name: '\u0000n', pos: { offset: 0, line: 0, column: 0 } }, key: k, pos: v.pos }, new Map([...scope, ['\u0000n', node]]));
      return this.t.compare('=', lhs, this.expr(v, scope));
    });
  }

  private relPropConds(a: string, props: [string, Expr][], scope: Scope): string[] {
    return props.map(([k, v]) => this.t.compare('=', { sql: this.t.propOf(`${a}.props`, k, this.b), type: 'json' }, this.expr(v, scope)));
  }

  /**
   * Patterns -> FROM items and WHERE conditions. Bound variables (in `scope`) join by equality;
   * new variables are added to `out`.
   */
  private patterns(patterns: Pattern[], scope: Scope, prevCte: string | null, out: Scope, from: string[], where: string[], allowVarLength = true): void {
    const relAliases: string[] = [];
    /** Variable-length expansions of this MATCH (their `visited` / `rels` columns), for relationship uniqueness. */
    const varRels: { visited: string; rels: string }[] = [];
    const local = (name: string | undefined): Var | undefined => (name ? (out.get(name) ?? scope.get(name)) : undefined);
    for (const p of patterns) {
      const nodeCols: string[] = [];
      const segs: string[] = [];
      const nodeAlias = (n: NodePat): string => {
        const a = this.alias('n');
        from.push(`N AS ${a}`);
        const bound = local(n.var);
        if (bound) {
          if (bound.type !== 'node') throw new CypherError(`'${n.var}' is a ${bound.type}, not a node`, n.pos);
          where.push(`${a}.uri = ${bound.sql}`);
        } else if (n.var) out.set(n.var, { type: 'node', sql: `${a}.uri` });
        const lc = this.labelCond(a, n.labels, n.pos);
        if (lc) where.push(lc);
        where.push(...this.nodePropConds(a, n.props, new Map([...scope, ...out])));
        // Nodes that no longer exist (kept as edge endpoints) only match plain `(x)` patterns.
        if (n.labels.length || n.props.length) where.push(`${a}.ghost = 0`);
        return `${a}.uri`;
      };
      nodeCols.push(nodeAlias(p.nodes[0]!));
      p.rels.forEach((r, i) => {
        const left = nodeCols[i]!;
        const rightPat = p.nodes[i + 1]!;
        if (!r.varLength) {
          const right = nodeAlias(rightPat);
          nodeCols.push(right);
          const a = this.alias('e');
          from.push(`E AS ${a}`);
          relAliases.push(a);
          if (r.dir === 'out') where.push(`${a}.from_uri = ${left} AND ${a}.to_uri = ${right}`);
          else if (r.dir === 'in') where.push(`${a}.from_uri = ${right} AND ${a}.to_uri = ${left}`);
          else where.push(`((${a}.from_uri = ${left} AND ${a}.to_uri = ${right}) OR (${a}.from_uri = ${right} AND ${a}.to_uri = ${left}))`);
          const tc = this.typeCond(a, r.types, r.pos);
          if (tc) where.push(tc);
          where.push(...this.relPropConds(a, r.props, new Map([...scope, ...out])));
          const bound = local(r.var);
          if (bound) where.push(`${a}.r = ${bound.sql}`);
          else if (r.var) out.set(r.var, { type: 'rel', sql: `${a}.r` });
          segs.push(this.t.relSeg(`${a}.r`));
          return;
        }
        if (!allowVarLength) throw new CypherError('variable-length relationships are not supported inside EXISTS { }', r.pos);
        if (r.var && local(r.var)) throw new CypherError(`'${r.var}' is already bound`, r.pos);
        // Anchor the traversal on the constrained side.
        const leftPat = p.nodes[i]!;
        const constrained = (n: NodePat) => Boolean(local(n.var) || n.labels.length || n.props.length);
        const fromRight = !constrained(leftPat) && constrained(rightPat) && i === p.rels.length - 1;
        const anchorPat = fromRight ? rightPat : leftPat;
        const right = nodeAlias(rightPat);
        nodeCols.push(right);
        const w = this.alias('w');
        const cte = this.alias('vl');
        const dir = fromRight ? (r.dir === 'out' ? 'in' : r.dir === 'in' ? 'out' : 'both') : r.dir;
        this.ctes.push(this.varLengthCte(cte, anchorPat, r, dir, scope, out, prevCte));
        from.push(`${cte} AS ${w}`);
        varRels.push({ visited: `${w}.visited`, rels: `${w}.rels` });
        const [s, t] = fromRight ? [right, left] : [left, right];
        where.push(`${w}.start = ${s} AND ${w}."end" = ${t} AND ${w}.depth >= ${this.t.int(this.bind(r.min))}`);
        const nodesSql = fromRight ? this.t.reverse(`${w}.nodes`) : `${w}.nodes`;
        const relsSql = fromRight ? this.t.reverse(`${w}.rels`) : `${w}.rels`;
        if (r.var) out.set(r.var, { type: 'list<rel>', sql: relsSql });
        segs.push(this.t.varSeg(nodesSql, relsSql));
      });
      if (p.pathVar) {
        if (local(p.pathVar)) throw new CypherError(`'${p.pathVar}' is already bound`, p.pos);
        const parts = [{ sql: nodeCols[0]!, node: true }];
        segs.forEach((sg, k) => parts.push({ sql: sg, node: false }, { sql: nodeCols[k + 1]!, node: true }));
        out.set(p.pathVar, { type: 'path', sql: this.t.path(parts) });
      }
    }
    // Relationship uniqueness within one MATCH.
    for (let x = 0; x < relAliases.length; x++) for (let y = x + 1; y < relAliases.length; y++) where.push(`${relAliases[x]}.id <> ${relAliases[y]}.id`);
    // ... including the relationships of variable-length expansions (their ids are in `visited`).
    for (const v of varRels) for (const a of relAliases) where.push(this.t.notVisited(v.visited, `${a}.id`));
    for (let x = 0; x < varRels.length; x++) for (let y = x + 1; y < varRels.length; y++) where.push(this.t.vlDisjoint(varRels[x]!.rels, varRels[y]!.visited));
  }

  private varLengthCte(name: string, anchor: NodePat, r: RelPat, dir: 'out' | 'in' | 'both', scope: Scope, out: Scope, prevCte: string | null): string {
    const a = this.alias('a');
    const conds: string[] = [];
    const lc = this.labelCond(a, anchor.labels, anchor.pos);
    if (lc) conds.push(lc);
    // Inline props that only use parameters / literals constrain the anchor.
    const simple = anchor.props.filter(([, v]) => v.t === 'param' || v.t === 'lit');
    conds.push(...this.nodePropConds(a, simple, new Map()));
    const bound = anchor.var ? scope.get(anchor.var) : undefined;
    if (bound && prevCte) {
      const c = [...scope.entries()].find(([k]) => k === anchor.var);
      if (c) conds.push(`${a}.uri IN (SELECT ${col(anchor.var!)} FROM ${prevCte})`);
    }
    void out;
    const e = this.alias('e');
    const tc = this.typeCond(e, r.types, r.pos);
    const rc = this.relPropConds(e, r.props, new Map());
    const filters = [tc, ...rc].filter(Boolean).join(' AND ');
    const step =
      dir === 'out'
        ? { join: `${e}.from_uri = v."end"`, next: `${e}.to_uri` }
        : dir === 'in'
          ? { join: `${e}.to_uri = v."end"`, next: `${e}.from_uri` }
          : { join: `(${e}.from_uri = v."end" OR ${e}.to_uri = v."end")`, next: `CASE WHEN ${e}.from_uri = v."end" THEN ${e}.to_uri ELSE ${e}.from_uri END` };
    const start = this.t.vlStart(`${a}.uri`);
    const next = this.t.vlAppend('v.nodes', 'v.rels', step.next, `${e}.r`);
    // Relationship uniqueness (openCypher trail semantics): `visited` holds the edge ids taken so far, nodes may repeat.
    // The expansion stops one row past the budget (SQLite); more rows than the budget fail the query on both targets.
    const budget = this.opts.varLengthBudget ?? VAR_LENGTH_ROW_BUDGET;
    const raw = `${name}r`;
    return `${raw}(start, "end", depth, visited, nodes, rels) AS ${this.t.name === 'sqlite' ? 'MATERIALIZED ' : ''}(
      SELECT ${a}.uri, ${a}.uri, 0, CAST(',' AS TEXT), ${start.nodes}, ${start.rels} FROM N AS ${a}${conds.length ? ` WHERE ${conds.join(' AND ')}` : ''}
      UNION ALL
      SELECT v.start, ${step.next}, v.depth + 1, v.visited || ${e}.id || ',', ${next.nodes}, ${next.rels}
        FROM ${raw} v JOIN E AS ${e} ON ${step.join}
       WHERE ${this.t.guard('v.depth')} AND v.depth < ${this.t.int(this.bind(r.max))} AND ${this.t.notVisited('v.visited', `${e}.id`)}
         AND EXISTS (SELECT 1 FROM N WHERE N.uri = ${step.next})${filters ? ` AND ${filters}` : ''}${this.t.vlLimit(budget + 1)}
    ),
  ${name} AS (SELECT * FROM ${raw} WHERE ${this.t.budgetCheck(`(SELECT count(*) FROM ${raw})`, budget)})`;
  }

  private existsSql(patterns: Pattern[], whereExpr: Expr | undefined, scope: Scope): string {
    const out: Scope = new Map();
    const from: string[] = [];
    const where: string[] = [];
    this.patterns(patterns, scope, null, out, from, where, false);
    if (whereExpr) where.push(this.cond(whereExpr, new Map([...scope, ...out])));
    return `EXISTS (SELECT 1 FROM ${from.join(', ')}${where.length ? ` WHERE ${where.join(' AND ')}` : ''})`;
  }

  /* ------------------------------------------------------------ clauses */

  compile(clauses: Clause[]): Compiled {
    const base = this.baseCtes();
    let prev: string | null = null;
    let scope: Scope = new Map();
    const steps: string[] = [];
    let columns: Compiled['columns'] = [];
    let final = '';
    clauses.forEach((c, idx) => {
      const name = `c${idx}`;
      const cols = (s: Scope) => [...s.keys()].map((k) => `${prev ? `p.${col(k)}` : ''}`).filter(Boolean);
      if (c.t === 'match') {
        const out: Scope = new Map();
        const from: string[] = [];
        const where: string[] = [];
        if (!c.optional) {
          // Bound variables come from the previous step (p).
          const inScope: Scope = new Map([...scope].map(([k, v]) => [k, { ...v, sql: `p.${col(k)}` }]));
          this.patterns(c.patterns, inScope, prev, out, from, where);
          if (c.where) where.push(this.cond(c.where, new Map([...inScope, ...out])));
          where.push(guard(this.t, from));
          const select = [...cols(scope), ...[...out].map(([k, v]) => `${v.sql} AS ${col(k)}`)];
          steps.push(
            `${name} AS (SELECT ${select.join(', ') || '1 AS _'} FROM ${[prev ? `${prev} AS p` : null, ...from].filter(Boolean).join(', ')}${where.length ? ` WHERE ${where.join(' AND ')}` : ''})`,
          );
          scope = new Map([...scope, ...[...out].map(([k, v]) => [k, { type: v.type, sql: col(k) }] as [string, Var])]);
        } else {
          // OPTIONAL MATCH: the pattern as a subquery (bound variables re-matched freely), LEFT JOINed on them.
          const free: Scope = new Map();
          const sub: Scope = new Map();
          for (const p of c.patterns) for (const n of p.nodes) if (n.var && scope.has(n.var)) free.set(n.var, scope.get(n.var)!);
          this.patterns(c.patterns, new Map(), null, sub, from, where);
          where.push(guard(this.t, from));
          const joinOn = [...free.keys()].map((k) => `o.${col(k)} = p.${col(k)}`);
          const newVars = [...sub].filter(([k]) => !scope.has(k));
          const subSelect = [...sub].map(([k, v]) => `${v.sql} AS ${col(k)}`);
          const outerScope: Scope = new Map([
            ...[...scope].map(([k, v]) => [k, { ...v, sql: `p.${col(k)}` }] as [string, Var]),
            ...newVars.map(([k, v]) => [k, { type: v.type, sql: `o.${col(k)}` }] as [string, Var]),
          ]);
          if (c.where) joinOn.push(this.cond(c.where, outerScope));
          const subq = `(SELECT ${subSelect.join(', ') || '1 AS _'} FROM ${from.join(', ')}${where.length ? ` WHERE ${where.join(' AND ')}` : ''})`;
          const select = [...cols(scope), ...newVars.map(([k]) => `o.${col(k)} AS ${col(k)}`)];
          steps.push(`${name} AS (SELECT ${select.join(', ') || '1 AS _'} FROM ${prev ? `${prev} AS p` : '(SELECT 1) AS p'} LEFT JOIN ${subq} AS o ON ${joinOn.join(' AND ') || this.t.joinTrue})`);
          scope = new Map([...scope, ...newVars.map(([k, v]) => [k, { type: v.type, sql: col(k) }] as [string, Var])]);
        }
        prev = name;
        return;
      }
      if (c.t === 'unwind') {
        const inScope: Scope = new Map([...scope].map(([k, v]) => [k, { ...v, sql: `p.${col(k)}` }]));
        const x = this.expr(c.e, inScope);
        const elem: VType = x.type === 'list<node>' ? 'node' : x.type === 'list<rel>' ? 'rel' : 'json';
        steps.push(`${name} AS (SELECT ${[...cols(scope), `${this.t.unwindValue(elem)} AS ${col(c.as)}`].join(', ')} FROM ${prev ? `${prev} AS p, ` : ''}${this.t.unwindFrom(x.sql)})`);
        scope = new Map([...scope, [c.as, { type: elem, sql: col(c.as) }]]);
        prev = name;
        return;
      }
      // WITH / RETURN
      const inScope: Scope = new Map([...scope].map(([k, v]) => [k, { ...v, sql: `p.${col(k)}` }]));
      const items = c.star ? [...scope.keys()].map((k) => ({ e: { t: 'var', name: k, pos: c.pos } as Expr, alias: k, named: true })) : c.items;
      if (c.t === 'with') for (const it of items) if (!it.named) throw new CypherError(`expression '${it.alias}' in WITH must be aliased (AS name)`, it.e.pos);
      const seen = new Set<string>();
      for (const it of items) {
        if (seen.has(it.alias)) throw new CypherError(`duplicate column '${it.alias}'`, it.e.pos);
        seen.add(it.alias);
      }
      const compiled = items.map((it) => ({ ...it, x: this.expr(it.e, inScope, true), agg: hasAggregate(it.e) }));
      const anyAgg = compiled.some((x) => x.agg);
      const outName = (a: string) => (c.t === 'return' ? q(a) : col(a));
      const select = compiled.map((x) => `${x.x.sql} AS ${outName(x.alias)}`);
      const groupBy = anyAgg ? compiled.filter((x) => !x.agg).map((x) => x.x.sql) : [];
      // ORDER BY sees the projected names and (without aggregation) the previous variables.
      const orderScope: Scope = new Map([...(anyAgg ? [] : [...inScope]), ...compiled.map((x) => [x.alias, { type: x.x.type, sql: outName(x.alias) }] as [string, Var])]);
      // Postgres cannot use output names inside ORDER BY expressions: order a derived table (_o) that carries the
      // projected columns plus, without aggregation / DISTINCT, the previous variables.
      const outside = this.t.orderOutside && c.order.length > 0;
      const carry = outside && !anyAgg && !c.distinct ? [...scope.keys()].filter((k) => !compiled.some((x) => outName(x.alias) === col(k))) : [];
      const ref = (n: string) => (outside ? `_o.${n}` : n);
      const orderScope2: Scope = outside
        ? new Map([...(anyAgg || c.distinct ? [] : [...scope].map(([k, v]) => [k, { ...v, sql: `_o.${col(k)}` }] as [string, Var])), ...compiled.map((x) => [x.alias, { type: x.x.type, sql: ref(outName(x.alias)) }] as [string, Var])])
        : orderScope;
      const order = c.order.map((o) => {
        // An ORDER BY expression equal to a projected one refers to that column (e.g. `RETURN s.ref, count(*) ... ORDER BY s.ref`).
        const same = compiled.find((x) => exprKey(x.e) === exprKey(o.e));
        return `${same ? ref(outName(same.alias)) : this.expr(o.e, orderScope2, anyAgg && !outside).sql}${o.desc ? ' DESC' : ''}`;
      });
      const skip = c.skip ? this.count(c.skip, 'SKIP') : null;
      const userLimit = c.limit ? this.count(c.limit, 'LIMIT') : null;
      const limitSql = `${userLimit || skip ? ` LIMIT ${userLimit ?? this.t.limitAll}${skip ? ` OFFSET ${skip}` : ''}` : ''}`;
      const from = `FROM ${prev ? `${prev} AS p` : '(SELECT 1) AS p'}${groupBy.length ? ` GROUP BY ${groupBy.join(', ')}` : ''}`;
      let sql = outside
        ? `SELECT ${compiled.map((x) => `_o.${outName(x.alias)}`).join(', ')} FROM (SELECT ${c.distinct ? 'DISTINCT ' : ''}${[...select, ...carry.map((k) => `p.${col(k)} AS ${col(k)}`)].join(', ')} ${from}) AS _o ORDER BY ${order.join(', ')}${limitSql}`
        : `SELECT ${c.distinct ? 'DISTINCT ' : ''}${select.join(', ')} ${from}${order.length ? ` ORDER BY ${order.join(', ')}` : ''}${limitSql}`;
      const newScope: Scope = new Map(compiled.map((x) => [x.alias, { type: x.x.type, sql: col(x.alias) }]));
      if (c.t === 'with') {
        if (c.where) {
          sql = `SELECT * FROM (${sql}) AS w WHERE ${this.cond(c.where, new Map([...newScope].map(([k, v]) => [k, { ...v, sql: `w.${v.sql}` }])))}`;
        }
        steps.push(`${name} AS (${sql})`);
        scope = newScope;
        prev = name;
        return;
      }
      columns = compiled.map((x) => ({ name: x.alias, type: x.x.type }));
      final = `SELECT * FROM (${sql})${this.t.subAlias} LIMIT ${this.t.int(this.bind(this.opts.rowCap + 1))}`;
    });
    const sql = `WITH RECURSIVE\n  ${[...base, ...this.ctes, ...steps].join(',\n  ')}\n${final}`;
    return { sql, binds: this.binds, columns };
  }
}

/** Structural identity of an expression (positions ignored). */
const exprKey = (e: Expr) => JSON.stringify(e, (k, v) => (k === 'pos' ? undefined : v));

export function hasAggregate(e: Expr): boolean {
  switch (e.t) {
    case 'call':
      return isAggregate(e.name) || e.args.some(hasAggregate);
    case 'bin':
      return hasAggregate(e.l) || hasAggregate(e.r);
    case 'not':
    case 'neg':
    case 'isnull':
    case 'prop':
      return hasAggregate(e.e);
    case 'index':
      return hasAggregate(e.e) || hasAggregate(e.i);
    case 'list':
      return e.items.some(hasAggregate);
    case 'map':
      return e.entries.some(([, v]) => hasAggregate(v));
    default:
      return false;
  }
}

export function compileCypher(clauses: Clause[], opts: CompileOptions): Compiled {
  return new Compiler(opts).compile(clauses);
}

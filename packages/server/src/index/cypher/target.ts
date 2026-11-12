/**
 * SQL emission targets of the Cypher compiler. The compiler (compile.ts) owns the shared plan: scopes, pattern
 * planning, anchoring of variable-length expansions, aggregation and type checks. A target only says how each
 * construct is spelled in SQL. SQLite: JSON as text (json1), user functions registered in the query worker
 * (cypher/runner.ts). Postgres: every Cypher value that is not a node is `jsonb`, nodes are uri `text`, booleans are SQL
 * booleans; helper functions are created in the project schema (db/pg-index/mirror.ts) — see cypher/pg/target.ts.
 */
import type { VType } from './compile.js';

export interface Val {
  sql: string;
  type: VType;
}

export interface SqlTarget {
  readonly name: 'sqlite' | 'postgres';
  /** A table of the index (schema-qualified on Postgres). */
  table(name: string): string;
  /** A helper function (`cy_add` …). */
  fn(name: string): string;
  /** A bind used as SQL text / integer (kinds, uris, keys; seq, limits). */
  text(bind: string): string;
  int(bind: string): string;
  /** A Cypher value from a JS value: `bind` receives the value to bind (Postgres binds JSON text). */
  value(v: unknown, bind: (v: unknown) => string): string;
  /** A JSON parameter (list / map). */
  jsonParam(v: unknown, bind: (v: unknown) => string): string;
  nullValue: string;
  boolLit(b: boolean): string;
  /** Row id of a `nodes` row. */
  rowid(alias: string): string;
  /** The relationship object of an `E0` row (columns id, kind, from_uri, to_uri, props). */
  relObject: string;
  /** `a IS NOT b` (NULL-safe inequality). */
  isNot(a: string, b: string): string;
  /** A node's props (text column) at a key bind: `json_extract(props, '$.k')`. */
  propOf(propsSql: string, key: string, bind: (v: unknown) => string): string;
  /** Text of a top-level JSON key of a props column, compared with a text bind (labels / rel types). */
  propText(propsSql: string, key: string, bind: (v: unknown) => string): string;
  /** A field of a relationship / map value. */
  field(valSql: string, keys: string[], bind: (v: unknown) => string): string;
  /** `rel.type` / `id(rel)`. */
  relField(relSql: string, f: 'type' | 'id'): string;
  /** Node uri as a Cypher value (ref / uri properties, comparisons with values). */
  nodeAsValue(uriSql: string): string;
  /** Text column (kind / label) as a Cypher value. */
  textAsValue(sql: string): string;
  /** list[i] (negative from the end); elem 'node' yields the uri. */
  index(listSql: string, iSql: string, elem: VType): string;
  /** A list literal / map literal. */
  list(items: Val[]): string;
  map(entries: [string, Val][], bind: (v: unknown) => string): string;
  /** Comparison operators / boolean results. */
  compare(op: string, l: Val, r: Val): string;
  regexp(l: Val, r: Val): string;
  inList(l: Val, r: Val): string;
  startsWith(l: Val, r: Val): string;
  endsWith(l: Val, r: Val): string;
  contains(l: Val, r: Val): string;
  add(l: Val, r: Val): string;
  arith(op: string, l: Val, r: Val): string;
  neg(x: Val): string;
  not(x: Val): string;
  /** A value used as a condition (WHERE, ON, AND / OR operands). */
  cond(x: Val): string;
  logic(op: 'AND' | 'OR', l: Val, r: Val): string;
  /** Aggregates. */
  collect(x: Val, distinct: boolean): string;
  countStar: string;
  count(x: Val, distinct: boolean): string;
  agg(name: string, x: Val, distinct: boolean): string;
  /** Functions. */
  labels(kindSql: string, propsSql: string): string;
  pathPart(pathSql: string, part: 'nodes' | 'rels'): string;
  pathLength(pathSql: string): string;
  size(x: Val): string;
  coalesce(args: Val[]): string;
  lower(x: Val): string;
  upper(x: Val): string;
  toString(x: Val): string;
  toInteger(x: Val): string;
  /** Commit sha of a commit node uri (isAncestor). */
  shaOf(uriSql: string): string;
  /** Path segments and the path value. */
  relSeg(relSql: string): string;
  varSeg(nodesSql: string, relsSql: string): string;
  path(parts: { sql: string; node: boolean }[]): string;
  reverse(listSql: string): string;
  /** Variable-length expansion pieces. */
  vlStart(uriSql: string): { nodes: string; rels: string };
  vlAppend(nodesSql: string, relsSql: string, nextSql: string, relSql: string): { nodes: string; rels: string };
  notVisited(visitedSql: string, nextSql: string): string;
  /** No relationship of the path `relsSql` (a JSON list of relationship objects) is in `visitedSql` (`,id,id,`). */
  vlDisjoint(relsSql: string, visitedSql: string): string;
  /** Recursion row budget (SQLite LIMIT inside the recursive CTE, so it stops; Postgres runs to the end). */
  vlLimit(n: number): string;
  /** A condition true while `countSql` <= n; past it the statement fails with `CYPHER_BUDGET` (mapped to `cypher_budget`). */
  budgetCheck(countSql: string, n: number): string;
  /** Per-row deadline guard (SQLite worker); Postgres relies on statement_timeout. */
  guard(argSql: string): string;
  /** UNWIND source and element. */
  unwindFrom(listSql: string): string;
  unwindValue(elem: VType): string;
  /** LIMIT with only OFFSET (`LIMIT -1`). */
  limitAll: string;
  /** LIMIT / SKIP expression from a Cypher value. */
  limitExpr(x: Val): string;
  joinTrue: string;
  /** Suffix keeping a scalar subquery to one row (SQLite takes the first row by itself). */
  oneRow: string;
  /** ORDER BY over a derived table (Postgres: output names are not visible inside ORDER BY expressions). */
  orderOutside: boolean;
  /** How the N / E CTEs are planned (SQLite: materialized, auto-indexed; Postgres: inlined, so uri lookups use the indexes). */
  materialized: string;
  /** Derived-table alias for `SELECT * FROM (…)`. */
  subAlias: string;
}

const NUMERIC_OPS = new Set(['-', '*', '/', '%']);
const ORDER_OPS = new Set(['<', '>', '<=', '>=']);

/** `json_extract(doc, @bN)` (a property read) -> [doc, path bind], else null. */
function jsonPath(sql: string): [string, string] | null {
  const m = /^json_extract\(([\s\S]+), (@b\d+)\)$/.exec(sql);
  return m ? [m[1]!, m[2]!] : null;
}

/** A value as a SQLite condition: booleans as they are; a JSON value only when it is a JSON boolean (else NULL). */
function sqliteBool(x: Val): string {
  if (x.type !== 'json') return x.sql;
  const j = jsonPath(x.sql);
  if (j) return `(CASE json_type(${j[0]}, ${j[1]}) WHEN 'true' THEN 1 WHEN 'false' THEN 0 END)`;
  // JSON booleans come out of json1 as integers 0 / 1: other values are not conditions.
  return `(CASE WHEN typeof(${x.sql}) = 'integer' AND ${x.sql} IN (0, 1) THEN ${x.sql} END)`;
}

/** Comparable type class of a value (numbers together; booleans apart). */
function typeClass(x: Val): string {
  if (x.type === 'bool') return `'b'`;
  if (x.type === 'node') return `'text'`;
  return `(CASE typeof(${x.sql}) WHEN 'integer' THEN 'n' WHEN 'real' THEN 'n' ELSE typeof(${x.sql}) END)`;
}

/** Today's SQLite spelling (byte-identical to the pre-split compiler). */
export const sqliteTarget: SqlTarget = {
  name: 'sqlite',
  table: (n) => n,
  fn: (n) => n,
  text: (b) => b,
  int: (b) => b,
  value: (v, bind) => bind(v),
  jsonParam: (v, bind) => `json(${bind(JSON.stringify(v))})`,
  nullValue: 'NULL',
  boolLit: (b) => (b ? '1' : '0'),
  rowid: (a) => `${a}.rowid`,
  relObject: `json_object('id', id, 'type', upper(kind), 'from', from_uri, 'to', to_uri, 'props', json(coalesce(props, '{}')))`,
  isNot: (a, b) => `${a} IS NOT ${b}`,
  propOf: (p, k, bind) => `json_extract(${p}, ${bind(`$.${jsonKey(k)}`)})`,
  propText: (p, k, bind) => (k === 'rel' ? `json_extract(${p}, '$.rel')` : `json_extract(${p}, ${bind(`$.${k}`)})`),
  field: (v, keys, bind) => `json_extract(${v}, ${bind(`$.${keys.map(jsonKey).join('.')}`)})`,
  relField: (r, f) => `json_extract(${r}, '$.${f}')`,
  nodeAsValue: (u) => u,
  textAsValue: (s) => s,
  index: (l, i) => {
    const n = `CAST(${i} AS INTEGER)`;
    return `json_extract(${l}, CASE WHEN ${n} < 0 THEN '$[#' || ${n} || ']' ELSE '$[' || ${n} || ']' END)`;
  },
  list: (items) => `json_array(${items.map((x) => (isJsonish(x) ? `json(${x.sql})` : x.sql)).join(', ')})`,
  map: (entries, bind) => `json_object(${entries.map(([k, x]) => `${bind(k)}, ${x.type === 'rel' || x.type === 'json' || x.type.startsWith('list') ? `json(${x.sql})` : x.sql}`).join(', ')})`,
  compare: (op, l, r) => {
    if (op === 'XOR') return `((${sqliteBool(l)}) <> (${sqliteBool(r)}))`;
    // Ordering across types (string vs number ...) is null, as in Cypher and on Postgres (jsonb types must match).
    if (ORDER_OPS.has(op) && !(l.type === 'node' && r.type === 'node')) return `(CASE WHEN ${typeClass(l)} = ${typeClass(r)} THEN (${l.sql} ${op} ${r.sql}) END)`;
    return `(${l.sql} ${op} ${r.sql})`;
  },
  regexp: (l, r) => `cy_regexp(${r.sql}, ${l.sql})`,
  inList: (l, r) => `(${l.sql} IN (SELECT value FROM json_each(${r.sql})))`,
  startsWith: (l, r) => `(substr(${l.sql}, 1, length(${r.sql})) = ${r.sql})`,
  endsWith: (l, r) => `(length(${r.sql}) = 0 OR substr(${l.sql}, -length(${r.sql})) = ${r.sql})`,
  contains: (l, r) => `(instr(${l.sql}, ${r.sql}) > 0)`,
  add: (l, r) => `cy_add(${l.sql}, ${r.sql})`,
  arith: (op, l, r) => `(${l.sql} ${op} ${r.sql})`,
  neg: (x) => `(-${x.sql})`,
  not: (x) => `(NOT ${sqliteBool(x)})`,
  cond: (x) => sqliteBool(x),
  logic: (op, l, r) => `(${sqliteBool(l)} ${op} ${sqliteBool(r)})`,
  collect: (x, d) => `json_group_array(${d ? 'DISTINCT ' : ''}${x.type === 'rel' || x.type === 'json' || x.type === 'path' || x.type.startsWith('list') ? `json(${x.sql})` : x.sql}) FILTER (WHERE ${x.sql} IS NOT NULL)`,
  countStar: 'count(*)',
  count: (x, d) => `count(${d ? 'DISTINCT ' : ''}${x.sql})`,
  agg: (name, x, d) => `${name}(${d ? 'DISTINCT ' : ''}${x.sql})`,
  labels: (k, p) => `cy_labels(${k}, ${p})`,
  pathPart: (p, part) => `json_extract(${p}, '$.${part}')`,
  pathLength: (p) => `json_array_length(${p}, '$.rels')`,
  size: (x) => `cy_size(${x.sql})`,
  coalesce: (args) => `coalesce(${args.map((a) => a.sql).join(', ')})`,
  lower: (x) => `lower(${x.sql})`,
  upper: (x) => `upper(${x.sql})`,
  toString: (x) => {
    if (x.type === 'bool') return `(CASE ${x.sql} WHEN 1 THEN 'true' WHEN 0 THEN 'false' END)`;
    const j = x.type === 'json' ? jsonPath(x.sql) : null;
    return j ? `(CASE json_type(${j[0]}, ${j[1]}) WHEN 'true' THEN 'true' WHEN 'false' THEN 'false' ELSE CAST(${x.sql} AS TEXT) END)` : `CAST(${x.sql} AS TEXT)`;
  },
  toInteger: (x) => `CAST(${x.sql} AS INTEGER)`,
  shaOf: (u) => `substr(${u}, ${'mandate://commits/'.length + 1})`,
  relSeg: (r) => `json_object('r', json(${r}))`,
  varSeg: (n, r) => `json_object('vn', json(${n}), 'vr', json(${r}))`,
  path: (parts) => `cy_path(${parts.map((p) => p.sql).join(', ')})`,
  reverse: (l) => `cy_reverse(${l})`,
  vlStart: (u) => ({ nodes: `json_array(${u})`, rels: 'json_array()' }),
  vlAppend: (n, r, next, rel) => ({ nodes: `json_insert(${n}, '$[#]', ${next})`, rels: `json_insert(${r}, '$[#]', json(${rel}))` }),
  notVisited: (v, next) => `instr(${v}, ',' || ${next} || ',') = 0`,
  vlDisjoint: (rels, v) => `NOT EXISTS (SELECT 1 FROM json_each(${rels}) AS x WHERE instr(${v}, ',' || json_extract(x.value, '$.id') || ',') > 0)`,
  vlLimit: (n) => `\n       LIMIT ${n}`,
  budgetCheck: (c, n) => `(CASE WHEN ${c} > ${n} THEN cy_fail('CYPHER_BUDGET') ELSE 1 END) = 1`,
  guard: (a) => `cy_guard(${a})`,
  unwindFrom: (l) => `json_each(${l}) AS j`,
  unwindValue: () => 'j.value',
  limitAll: '-1',
  limitExpr: (x) => x.sql,
  joinTrue: '1',
  materialized: 'MATERIALIZED',
  oneRow: '',
  orderOutside: false,
  subAlias: '',
};

export function isJsonish(x: Val): boolean {
  return x.type === 'rel' || x.type === 'json' || x.type === 'path' || x.type.startsWith('list');
}

export function jsonKey(k: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(k) ? k : `"${k.replace(/"/g, '\\"')}"`;
}

export { NUMERIC_OPS };

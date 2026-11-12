/**
 * Postgres spelling of the Cypher plan (see ../target.ts). Values: nodes are uri `text`, booleans SQL booleans, every
 * other Cypher value `jsonb` (JSON nulls read as SQL NULL, as in SQLite's json_extract). Tables and the `cy_*` helper
 * functions are qualified with the project's index scope (db/pg-index/mirror.ts creates them).
 */
import type { Dialect } from '../../../db/types.js';
import type { SqlTarget, Val } from '../target.js';

export function pgTarget(d: Dialect): SqlTarget {
  const fn = (n: string) => d.table(n);
  /** As jsonb. */
  const J = (x: Val) => (x.type === 'node' ? `to_jsonb((${x.sql})::text)` : x.type === 'bool' ? `to_jsonb(${x.sql})` : x.sql);
  /** As text. */
  const T = (x: Val) => (x.type === 'node' ? `(${x.sql})::text` : `(${J(x)} #>> '{}')`);
  /** As boolean: a JSON boolean, any other value is NULL (not a condition; the compiler rejects static non-booleans). */
  const B = (x: Val) => (x.type === 'bool' ? x.sql : `(CASE WHEN jsonb_typeof(${J(x)}) = 'boolean' THEN (${J(x)})::boolean END)`);
  /** The uri text behind a node-as-value expression (`n.ref`), else null. */
  const uriOf = (x: Val): string | null => (x.type === 'node' ? `(${x.sql})::text` : /^to_jsonb\(\(([A-Za-z0-9_."]+)\)::text\)$/.exec(x.sql)?.[1] ?? null);
  const N = (x: Val) => `(${T(x)})::numeric`;
  const arr = (l: string) => `(CASE WHEN ${l} IS NULL THEN '[]'::jsonb WHEN jsonb_typeof(${l}) = 'array' THEN ${l} ELSE jsonb_build_array(${l}) END)`;
  const text = (b: string) => `CAST(${b} AS text)`;
  return {
    name: 'postgres',
    table: (n) => d.table(n),
    fn,
    text,
    int: (b) => `CAST(${b} AS bigint)`,
    value: (v, bind) => `CAST(${bind(JSON.stringify(v))} AS jsonb)`,
    jsonParam: (v, bind) => `CAST(${bind(JSON.stringify(v))} AS jsonb)`,
    nullValue: 'NULL::jsonb',
    boolLit: (b) => (b ? 'TRUE' : 'FALSE'),
    rowid: (a) => `${a}.rid`,
    relObject: `jsonb_build_object('id', CASE WHEN id ~ '^[0-9]+$' THEN to_jsonb(id::bigint) ELSE to_jsonb(id) END, 'type', upper(kind), 'from', from_uri, 'to', to_uri, 'props', coalesce(props, '{}')::jsonb)`,
    isNot: (a, b) => `${a} IS DISTINCT FROM ${b}`,
    propOf: (p, k, bind) => `NULLIF((${p})::jsonb -> ${text(bind(k))}, 'null'::jsonb)`,
    propText: (p, k, bind) => `((${p})::jsonb ->> ${text(bind(k))})`,
    field: (v, keys, bind) => `NULLIF(${v} #> CAST(${bind(keys)} AS text[]), 'null'::jsonb)`,
    relField: (r, f) => `(${r} -> '${f}')`,
    nodeAsValue: (u) => `to_jsonb((${u})::text)`,
    textAsValue: (s) => `to_jsonb((${s})::text)`,
    index: (l, i, elem) => (elem === 'node' ? `(${l} ->> ((${i})::int))` : `NULLIF(${l} -> ((${i})::int), 'null'::jsonb)`),
    list: (items) => (items.length ? `jsonb_build_array(${items.map(J).join(', ')})` : `'[]'::jsonb`),
    map: (entries, bind) => (entries.length ? `jsonb_build_object(${entries.map(([k, x]) => `${text(bind(k))}, ${J(x)}`).join(', ')})` : `'{}'::jsonb`),
    compare: (op, l, r) => {
      const o = op === 'XOR' ? '<>' : op;
      if (l.type === 'node' && r.type === 'node') return `(${l.sql} ${o} ${r.sql})`;
      if (l.type === 'bool' && r.type === 'bool') return `((${l.sql}) ${o} (${r.sql}))`;
      // `n.ref = $x`: compare the uri text itself, so the uri indexes apply (sargable).
      if (o === '=' || o === '<>') {
        const lu = uriOf(l);
        const ru = uriOf(r);
        if (lu && !ru && r.type !== 'bool') return `(${lu} ${o} (${J(r)} #>> '{}'))`;
        if (ru && !lu && l.type !== 'bool') return `((${J(l)} #>> '{}') ${o} ${ru})`;
      }
      // Ordering across JSON types (string vs number ...) is null, as in Cypher and on SQLite.
      if (o !== '=' && o !== '<>') return `(CASE WHEN jsonb_typeof(${J(l)}) = jsonb_typeof(${J(r)}) THEN ${J(l)} ${o} ${J(r)} END)`;
      return `(${J(l)} ${o} ${J(r)})`;
    },
    regexp: (l, r) => `${fn('cy_regexp')}(${J(r)}, ${J(l)})`,
    inList: (l, r) => `(${J(l)} IN (SELECT je.value FROM jsonb_array_elements(${arr(J(r))}) AS je(value)))`,
    startsWith: (l, r) => `starts_with(${T(l)}, ${T(r)})`,
    endsWith: (l, r) => `(length(${T(r)}) = 0 OR right(${T(l)}, length(${T(r)})) = ${T(r)})`,
    contains: (l, r) => `(strpos(${T(l)}, ${T(r)}) > 0)`,
    add: (l, r) => `${fn('cy_add')}(${J(l)}, ${J(r)})`,
    arith: (op, l, r) => {
      if (op === '/') return `to_jsonb(CASE WHEN scale(${N(l)}) = 0 AND scale(${N(r)}) = 0 THEN trunc(${N(l)} / NULLIF(${N(r)}, 0)) ELSE ${N(l)} / NULLIF(${N(r)}, 0) END)`;
      if (op === '%') return `to_jsonb(mod(${N(l)}, NULLIF(${N(r)}, 0)))`;
      return `to_jsonb(${N(l)} ${op} ${N(r)})`;
    },
    neg: (x) => `to_jsonb(-${N(x)})`,
    not: (x) => `(NOT ${B(x)})`,
    cond: (x) => B(x),
    logic: (op, l, r) => `(${B(l)} ${op} ${B(r)})`,
    collect: (x, dd) => `coalesce(jsonb_agg(${dd ? 'DISTINCT ' : ''}${J(x)}) FILTER (WHERE ${x.sql} IS NOT NULL), '[]'::jsonb)`,
    countStar: 'to_jsonb(count(*))',
    count: (x, dd) => `to_jsonb(count(${dd ? 'DISTINCT ' : ''}${x.sql}))`,
    agg: (name, x, dd) => {
      if (name === 'sum' || name === 'avg') return `to_jsonb(${name}(${dd ? 'DISTINCT ' : ''}${N(x)}))`;
      if (x.type === 'node') return `to_jsonb(${name}(${x.sql}))`;
      return `(array_agg(${J(x)} ORDER BY ${J(x)} ${name === 'min' ? 'ASC' : 'DESC'}) FILTER (WHERE ${x.sql} IS NOT NULL))[1]`;
    },
    labels: (k, p) => `${fn('cy_labels')}(${k}, ${p})`,
    pathPart: (p, part) => `(${p} -> '${part}')`,
    pathLength: (p) => `to_jsonb(jsonb_array_length(${p} -> 'rels'))`,
    size: (x) => `${fn('cy_size')}(${J(x)})`,
    coalesce: (args) => (args.every((a) => a.type === 'node') ? `coalesce(${args.map((a) => a.sql).join(', ')})` : `coalesce(${args.map(J).join(', ')})`),
    lower: (x) => `to_jsonb(lower(${T(x)}))`,
    upper: (x) => `to_jsonb(upper(${T(x)}))`,
    toString: (x) => `to_jsonb(${T(x)})`,
    toInteger: (x) => `to_jsonb(trunc(${N(x)})::bigint)`,
    shaOf: (u) => `substr(${u}, ${'mandate://commits/'.length + 1})`,
    relSeg: (r) => `jsonb_build_object('r', ${r})`,
    varSeg: (n, r) => `jsonb_build_object('vn', ${n}, 'vr', ${r})`,
    path: (parts) => `${fn('cy_path')}(jsonb_build_array(${parts.map((p) => (p.node ? `to_jsonb((${p.sql})::text)` : p.sql)).join(', ')}))`,
    reverse: (l) => `${fn('cy_reverse')}(${l})`,
    vlStart: (u) => ({ nodes: `jsonb_build_array(${u})`, rels: `'[]'::jsonb` }),
    vlAppend: (n, r, next, rel) => ({ nodes: `${n} || jsonb_build_array(${next})`, rels: `${r} || jsonb_build_array(${rel})` }),
    notVisited: (v, next) => `strpos(${v}, ',' || ${next} || ',') = 0`,
    vlDisjoint: (rels, v) => `NOT EXISTS (SELECT 1 FROM jsonb_array_elements(${rels}) AS x(value) WHERE strpos(${v}, ',' || (x.value ->> 'id') || ',') > 0)`,
    vlLimit: () => '',
    // No helper function to raise with: a cast of a non-constant text fails at run time (22P02, mapped by pg/runner.ts).
    budgetCheck: (c, n) => `(CASE WHEN ${c} > ${n} THEN CAST('CYPHER_BUDGET:' || ${c} AS integer) ELSE 1 END) = 1`,
    guard: () => 'TRUE',
    unwindFrom: (l) => `jsonb_array_elements(${arr(l)}) AS j(value)`,
    unwindValue: (elem) => (elem === 'node' ? `(j.value #>> '{}')` : `NULLIF(j.value, 'null'::jsonb)`),
    limitAll: 'ALL',
    limitExpr: (x) => `(${J(x)})::bigint`,
    joinTrue: 'TRUE',
    materialized: 'NOT MATERIALIZED',
    oneRow: ' LIMIT 1',
    orderOutside: true,
    subAlias: ' AS _r',
  };
}

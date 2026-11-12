/**
 * Read-only openCypher subset: recursive-descent parser producing a typed AST.
 * Anything outside the subset is rejected with the construct named and its position.
 */

export interface Pos {
  offset: number;
  line: number;
  column: number;
}

export class CypherError extends Error {
  constructor(
    message: string,
    readonly pos: Pos | null,
    readonly hint?: string,
    readonly code = 'cypher_syntax',
  ) {
    super(`${message}${pos ? ` (line ${pos.line}, column ${pos.column})` : ''}${hint ? `. ${hint}` : ''}`);
    this.name = 'CypherError';
  }
}

/* ------------------------------------------------------------------ AST */

export type Expr = (
  | { t: 'lit'; v: string | number | boolean | null }
  | { t: 'param'; name: string }
  | { t: 'var'; name: string }
  | { t: 'prop'; e: Expr; key: string }
  | { t: 'index'; e: Expr; i: Expr }
  | { t: 'list'; items: Expr[] }
  | { t: 'map'; entries: [string, Expr][] }
  | { t: 'call'; name: string; args: Expr[]; distinct: boolean; star: boolean }
  | { t: 'bin'; op: BinOp; l: Expr; r: Expr }
  | { t: 'not'; e: Expr }
  | { t: 'neg'; e: Expr }
  | { t: 'isnull'; e: Expr; not: boolean }
  | { t: 'exists'; patterns: Pattern[]; where?: Expr }
) & { pos: Pos };

export type BinOp = 'OR' | 'XOR' | 'AND' | '=' | '<>' | '<' | '>' | '<=' | '>=' | '=~' | 'IN' | 'STARTS WITH' | 'ENDS WITH' | 'CONTAINS' | '+' | '-' | '*' | '/' | '%';

export interface NodePat {
  var?: string;
  labels: string[];
  props: [string, Expr][];
  pos: Pos;
}

export interface RelPat {
  var?: string;
  types: string[];
  dir: 'out' | 'in' | 'both';
  varLength: boolean;
  min: number;
  max: number;
  props: [string, Expr][];
  pos: Pos;
}

export interface Pattern {
  pathVar?: string;
  nodes: NodePat[];
  rels: RelPat[];
  pos: Pos;
}

export interface ProjItem {
  e: Expr;
  alias: string;
  /** Explicit `AS` alias or a plain variable (usable as a variable after WITH). */
  named: boolean;
}

export type Clause =
  | { t: 'match'; optional: boolean; patterns: Pattern[]; where?: Expr; pos: Pos }
  | { t: 'unwind'; e: Expr; as: string; pos: Pos }
  | {
      t: 'with' | 'return';
      distinct: boolean;
      star: boolean;
      items: ProjItem[];
      order: { e: Expr; desc: boolean }[];
      skip?: Expr;
      limit?: Expr;
      where?: Expr;
      pos: Pos;
    };

export interface Query {
  clauses: Clause[];
}

/** Hard cap for variable-length relationships. */
export const MAX_VAR_LENGTH = 6;

/* ------------------------------------------------------------------ lexer */

type TokType = 'ident' | 'kw' | 'num' | 'str' | 'param' | 'punct' | 'eof';
interface Tok {
  type: TokType;
  value: string;
  /** Original spelling (for identifiers that look like keywords). */
  raw: string;
  pos: Pos;
}

const KEYWORDS = new Set(
  'MATCH OPTIONAL WHERE RETURN WITH DISTINCT AS ORDER BY ASC ASCENDING DESC DESCENDING SKIP LIMIT UNWIND AND OR XOR NOT IN STARTS ENDS WITH CONTAINS IS NULL TRUE FALSE EXISTS'.split(
    ' ',
  ),
);
/** Clauses and keywords outside the read-only subset. */
const REJECTED: Record<string, string> = {
  CREATE: 'writes are not allowed (read-only graph)',
  MERGE: 'writes are not allowed (read-only graph)',
  DELETE: 'writes are not allowed (read-only graph)',
  DETACH: 'writes are not allowed (read-only graph)',
  SET: 'writes are not allowed (read-only graph)',
  REMOVE: 'writes are not allowed (read-only graph)',
  DROP: 'writes are not allowed (read-only graph)',
  CALL: 'procedures (CALL) are not supported',
  LOAD: 'LOAD CSV is not supported',
  FOREACH: 'FOREACH is not supported (read-only graph)',
  UNION: 'UNION is not supported; run two queries (graph_batch)',
  CASE: 'CASE expressions are not supported; use coalesce() or filter in WHERE',
  USE: 'USE is not supported',
};

const PUNCT = ['..', '<>', '!=', '<=', '>=', '=~', '(', ')', '[', ']', '{', '}', ',', ':', '.', '|', '*', '=', '<', '>', '-', '+', '/', '%', ';'];

function lex(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  let line = 1;
  let col = 1;
  const pos = (): Pos => ({ offset: i, line, column: col });
  const adv = (n: number) => {
    for (let k = 0; k < n; k++) {
      if (src[i] === '\n') {
        line++;
        col = 1;
      } else col++;
      i++;
    }
  };
  while (i < src.length) {
    const c = src[i]!;
    if (/\s/.test(c)) {
      adv(1);
      continue;
    }
    if (src.startsWith('//', i)) {
      while (i < src.length && src[i] !== '\n') adv(1);
      continue;
    }
    if (src.startsWith('/*', i)) {
      const end = src.indexOf('*/', i + 2);
      adv((end < 0 ? src.length : end + 2) - i);
      continue;
    }
    const p = pos();
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j]!)) j++;
      const raw = src.slice(i, j);
      const up = raw.toUpperCase();
      toks.push({ type: KEYWORDS.has(up) ? 'kw' : 'ident', value: KEYWORDS.has(up) ? up : raw, raw, pos: p });
      adv(j - i);
      continue;
    }
    if (c === '`') {
      const end = src.indexOf('`', i + 1);
      if (end < 0) throw new CypherError('unterminated `quoted` identifier', p);
      toks.push({ type: 'ident', value: src.slice(i + 1, end), raw: src.slice(i, end + 1), pos: p });
      adv(end + 1 - i);
      continue;
    }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] ?? '') && toks.at(-1)?.value !== '.')) {
      const m = /^(?:\d+\.\d+|\d+|\.\d+)(?:[eE][+-]?\d+)?/.exec(src.slice(i))!;
      // `1..3` is a range, not a float.
      const text = /^\d+\.\.$/.test(src.slice(i, i + m[0].length + 1)) ? m[0].replace(/\.$/, '') : m[0];
      const t = /^\d+\.\./.test(src.slice(i)) ? /^\d+/.exec(src.slice(i))![0] : text;
      toks.push({ type: 'num', value: t, raw: t, pos: p });
      adv(t.length);
      continue;
    }
    if (c === "'" || c === '"') {
      let j = i + 1;
      let out = '';
      while (j < src.length && src[j] !== c) {
        if (src[j] === '\\') {
          const n = src[j + 1];
          out += n === 'n' ? '\n' : n === 't' ? '\t' : (n ?? '');
          j += 2;
        } else out += src[j++];
      }
      if (j >= src.length) throw new CypherError('unterminated string', p);
      toks.push({ type: 'str', value: out, raw: src.slice(i, j + 1), pos: p });
      adv(j + 1 - i);
      continue;
    }
    if (c === '$') {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)/.exec(src.slice(i));
      if (!m) throw new CypherError('invalid parameter name', p, 'parameters look like $name');
      toks.push({ type: 'param', value: m[1]!, raw: m[0], pos: p });
      adv(m[0].length);
      continue;
    }
    const pu = PUNCT.find((x) => src.startsWith(x, i));
    if (!pu) throw new CypherError(`unexpected character '${c}'`, p);
    toks.push({ type: 'punct', value: pu === '!=' ? '<>' : pu, raw: pu, pos: p });
    adv(pu.length);
  }
  toks.push({ type: 'eof', value: '', raw: '', pos: pos() });
  return toks;
}

/* ------------------------------------------------------------------ parser */

const AGGREGATES = new Set(['count', 'collect', 'min', 'max', 'sum', 'avg']);
export const FUNCTIONS = new Set([...AGGREGATES, 'labels', 'type', 'id', 'nodes', 'relationships', 'length', 'coalesce', 'tolower', 'toupper', 'size', 'tostring', 'tointeger', 'isancestor']);
export const isAggregate = (name: string) => AGGREGATES.has(name);

export function editDistance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...new Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0]![j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + (a[i - 1]!.toLowerCase() === b[j - 1]!.toLowerCase() ? 0 : 1));
  return d[a.length]![b.length]!;
}

/** "did you mean 'X'?" for the closest candidate. */
export function suggest(word: string, candidates: Iterable<string>): string | undefined {
  let best: string | undefined;
  let bd = Infinity;
  for (const c of candidates) {
    const d = editDistance(word, c);
    if (d < bd) {
      bd = d;
      best = c;
    }
  }
  return best && bd <= Math.max(2, Math.floor(word.length / 3)) ? `did you mean '${best}'?` : undefined;
}

class Parser {
  private i = 0;
  private anon = 0;
  constructor(private readonly toks: Tok[]) {}

  private get cur(): Tok {
    return this.toks[this.i]!;
  }
  private peek(n = 1): Tok {
    return this.toks[Math.min(this.i + n, this.toks.length - 1)]!;
  }
  private isKw(...kws: string[]) {
    return this.cur.type === 'kw' && kws.includes(this.cur.value);
  }
  private isP(...ps: string[]) {
    return this.cur.type === 'punct' && ps.includes(this.cur.value);
  }
  private next(): Tok {
    return this.toks[this.i++]!;
  }
  private fail(msg: string, tok = this.cur, hint?: string): never {
    throw new CypherError(msg, tok.pos, hint);
  }
  private expectKw(kw: string): Tok {
    if (!this.isKw(kw)) this.fail(`expected ${kw}, found ${this.describe(this.cur)}`);
    return this.next();
  }
  private expectP(p: string): Tok {
    if (!this.isP(p)) this.fail(`expected '${p}', found ${this.describe(this.cur)}`);
    return this.next();
  }
  private describe(t: Tok) {
    return t.type === 'eof' ? 'end of query' : `'${t.raw}'`;
  }
  private ident(what: string): string {
    // Keywords are allowed as names after ':' / '.' (e.g. `n.in`, `r.with`); here only identifiers.
    if (this.cur.type === 'ident') return this.next().value;
    if (this.cur.type === 'kw' && !['MATCH', 'RETURN', 'WHERE', 'WITH'].includes(this.cur.value)) return this.next().raw;
    this.fail(`expected ${what}, found ${this.describe(this.cur)}`);
  }
  private rejectWords() {
    const t = this.cur;
    if (t.type === 'ident' && REJECTED[t.value.toUpperCase()]) this.fail(`unsupported: ${t.value.toUpperCase()}`, t, REJECTED[t.value.toUpperCase()]);
  }

  parse(): Query {
    const clauses: Clause[] = [];
    while (this.cur.type !== 'eof') {
      if (this.isP(';')) {
        this.next();
        if (this.peek(0).type !== 'eof') this.fail('only one statement per query');
        break;
      }
      this.rejectWords();
      clauses.push(this.clause());
    }
    if (!clauses.length) this.fail('empty query');
    const last = clauses.at(-1)!;
    if (last.t !== 'return') this.fail('a query must end with RETURN', this.cur);
    clauses.slice(0, -1).forEach((c) => c.t === 'return' && this.fail('RETURN must be the last clause', { ...this.cur, pos: c.pos }));
    return { clauses };
  }

  private clause(): Clause {
    const t = this.cur;
    if (this.isKw('OPTIONAL')) {
      this.next();
      this.expectKw('MATCH');
      return this.match(true, t.pos);
    }
    if (this.isKw('MATCH')) {
      this.next();
      return this.match(false, t.pos);
    }
    if (this.isKw('UNWIND')) {
      this.next();
      const e = this.expr();
      this.expectKw('AS');
      return { t: 'unwind', e, as: this.ident('a variable'), pos: t.pos };
    }
    if (this.isKw('WITH') || this.isKw('RETURN')) return this.projection(this.next().value === 'WITH' ? 'with' : 'return', t.pos);
    if (t.type === 'ident' || t.type === 'kw') {
      this.fail(`unsupported clause '${t.raw}'`, t, suggest(t.raw.toUpperCase(), ['MATCH', 'OPTIONAL MATCH', 'WHERE', 'WITH', 'RETURN', 'UNWIND', 'ORDER BY', 'SKIP', 'LIMIT']));
    }
    this.fail(`expected a clause (MATCH, OPTIONAL MATCH, WITH, UNWIND, RETURN), found ${this.describe(t)}`);
  }

  private match(optional: boolean, pos: Pos): Clause {
    const patterns = [this.pattern()];
    while (this.isP(',')) {
      this.next();
      patterns.push(this.pattern());
    }
    let where: Expr | undefined;
    if (this.isKw('WHERE')) {
      this.next();
      where = this.expr();
    }
    return { t: 'match', optional, patterns, where, pos };
  }

  private pattern(): Pattern {
    const pos = this.cur.pos;
    let pathVar: string | undefined;
    if ((this.cur.type === 'ident') && this.peek().type === 'punct' && this.peek().value === '=') {
      pathVar = this.next().value;
      this.next();
    }
    if (this.cur.type === 'ident' && ['shortestpath', 'allshortestpaths'].includes(this.cur.value.toLowerCase())) {
      this.fail(`unsupported: ${this.cur.value}()`, this.cur, 'use graph_path for shortest paths, or a variable-length pattern with ORDER BY length(p) LIMIT 1');
    }
    const nodes = [this.nodePat()];
    const rels: RelPat[] = [];
    while (this.isP('-', '<')) {
      rels.push(this.relPat());
      nodes.push(this.nodePat());
    }
    return { pathVar, nodes, rels, pos };
  }

  private props(): [string, Expr][] {
    const out: [string, Expr][] = [];
    if (!this.isP('{')) return out;
    this.next();
    while (!this.isP('}')) {
      const k = this.ident('a property name');
      this.expectP(':');
      out.push([k, this.expr()]);
      if (!this.isP(',')) break;
      this.next();
    }
    this.expectP('}');
    return out;
  }

  private nodePat(): NodePat {
    const pos = this.expectP('(').pos;
    let v: string | undefined;
    if (this.cur.type === 'ident') v = this.next().value;
    const labels: string[] = [];
    if (this.isP(':')) {
      this.next();
      labels.push(this.ident('a label'));
      while (this.isP('|', ':')) {
        if (this.cur.value === ':') this.fail('multiple labels with ":" mean AND, which is not supported', this.cur, 'use (n:A|B) for either label');
        this.next();
        labels.push(this.ident('a label'));
      }
    }
    const props = this.props();
    this.expectP(')');
    return { var: v, labels, props, pos };
  }

  private relPat(): RelPat {
    const pos = this.cur.pos;
    let left = false;
    if (this.isP('<')) {
      this.next();
      left = true;
    }
    this.expectP('-');
    const rel: RelPat = { types: [], dir: 'both', varLength: false, min: 1, max: 1, props: [], pos };
    if (this.isP('[')) {
      this.next();
      if (this.cur.type === 'ident') rel.var = this.next().value;
      if (this.isP(':')) {
        this.next();
        rel.types.push(this.ident('a relationship type'));
        while (this.isP('|')) {
          this.next();
          if (this.isP(':')) this.next();
          rel.types.push(this.ident('a relationship type'));
        }
      }
      if (this.isP('*')) {
        const star = this.next();
        rel.varLength = true;
        rel.min = 1;
        rel.max = MAX_VAR_LENGTH;
        if (this.cur.type === 'num') {
          rel.min = Number(this.next().value);
          rel.max = rel.min;
        }
        if (this.isP('..')) {
          this.next();
          rel.max = this.cur.type === 'num' ? Number(this.next().value) : MAX_VAR_LENGTH;
        }
        if (rel.max > MAX_VAR_LENGTH) this.fail(`variable-length relationships are limited to ${MAX_VAR_LENGTH} hops`, star, `use *..${MAX_VAR_LENGTH} or less`);
        if (rel.min < 0 || rel.min > rel.max) this.fail('invalid hop range', star);
      }
      rel.props = this.props();
      this.expectP(']');
    }
    this.expectP('-');
    let right = false;
    if (this.isP('>')) {
      this.next();
      right = true;
    }
    if (left && right) this.fail('a relationship cannot point both ways', { ...this.cur, pos });
    rel.dir = right ? 'out' : left ? 'in' : 'both';
    return rel;
  }

  private projection(kind: 'with' | 'return', pos: Pos): Clause {
    let distinct = false;
    if (this.isKw('DISTINCT')) {
      this.next();
      distinct = true;
    }
    let star = false;
    const items: ProjItem[] = [];
    if (this.isP('*')) {
      this.next();
      star = true;
    } else {
      do {
        if (items.length) this.next();
        const start = this.cur.pos.offset;
        const e = this.expr();
        let alias: string;
        let named = false;
        if (this.isKw('AS')) {
          this.next();
          alias = this.ident('an alias');
          named = true;
        } else if (e.t === 'var') {
          alias = e.name;
          named = true;
        } else {
          alias = this.sourceText(start);
        }
        items.push({ e, alias, named });
      } while (this.isP(','));
    }
    const order: { e: Expr; desc: boolean }[] = [];
    let skip: Expr | undefined;
    let limit: Expr | undefined;
    let where: Expr | undefined;
    if (this.isKw('ORDER')) {
      this.next();
      this.expectKw('BY');
      do {
        if (order.length) this.next();
        const e = this.expr();
        let desc = false;
        if (this.isKw('DESC', 'DESCENDING')) {
          this.next();
          desc = true;
        } else if (this.isKw('ASC', 'ASCENDING')) this.next();
        order.push({ e, desc });
      } while (this.isP(','));
    }
    if (this.isKw('SKIP')) {
      this.next();
      skip = this.expr();
    }
    if (this.isKw('LIMIT')) {
      this.next();
      limit = this.expr();
    }
    if (kind === 'with' && this.isKw('WHERE')) {
      this.next();
      where = this.expr();
    }
    return { t: kind, distinct, star, items, order, skip, limit, where, pos };
  }

  private src = '';
  setSource(s: string) {
    this.src = s;
    return this;
  }
  private sourceText(start: number) {
    return this.src.slice(start, this.cur.pos.offset).trim();
  }

  /* -------------------------------------------------------------- expressions */

  expr(): Expr {
    return this.or();
  }
  private bin(next: () => Expr, ops: string[], kw: boolean): Expr {
    let l = next();
    while (kw ? this.isKw(...ops) : this.isP(...ops)) {
      const t = this.next();
      l = { t: 'bin', op: t.value as BinOp, l, r: next(), pos: t.pos };
    }
    return l;
  }
  private or(): Expr {
    return this.bin(() => this.xor(), ['OR'], true);
  }
  private xor(): Expr {
    return this.bin(() => this.and(), ['XOR'], true);
  }
  private and(): Expr {
    return this.bin(() => this.not(), ['AND'], true);
  }
  private not(): Expr {
    if (this.isKw('NOT')) {
      const t = this.next();
      return { t: 'not', e: this.not(), pos: t.pos };
    }
    return this.comparison();
  }
  private comparison(): Expr {
    let l = this.additive();
    for (;;) {
      const t = this.cur;
      if (this.isP('=', '<>', '<', '>', '<=', '>=', '=~')) {
        this.next();
        l = { t: 'bin', op: t.value as BinOp, l, r: this.additive(), pos: t.pos };
      } else if (this.isKw('IN')) {
        this.next();
        l = { t: 'bin', op: 'IN', l, r: this.additive(), pos: t.pos };
      } else if (this.isKw('STARTS', 'ENDS')) {
        this.next();
        this.expectKw('WITH');
        l = { t: 'bin', op: `${t.value} WITH` as BinOp, l, r: this.additive(), pos: t.pos };
      } else if (this.isKw('CONTAINS')) {
        this.next();
        l = { t: 'bin', op: 'CONTAINS', l, r: this.additive(), pos: t.pos };
      } else if (this.isKw('IS')) {
        this.next();
        let not = false;
        if (this.isKw('NOT')) {
          this.next();
          not = true;
        }
        this.expectKw('NULL');
        l = { t: 'isnull', e: l, not, pos: t.pos };
      } else return l;
    }
  }
  private additive(): Expr {
    return this.bin(() => this.multiplicative(), ['+', '-'], false);
  }
  private multiplicative(): Expr {
    return this.bin(() => this.unary(), ['*', '/', '%'], false);
  }
  private unary(): Expr {
    if (this.isP('-')) {
      const t = this.next();
      return { t: 'neg', e: this.unary(), pos: t.pos };
    }
    if (this.isP('+')) this.next();
    return this.postfix();
  }
  private postfix(): Expr {
    let e = this.atom();
    for (;;) {
      if (this.isP('.')) {
        const t = this.next();
        e = { t: 'prop', e, key: this.ident('a property name'), pos: t.pos };
      } else if (this.isP('[')) {
        const t = this.next();
        if (this.isP('..') || this.peek().value === '..') this.fail('list slices are not supported', t);
        const i = this.expr();
        this.expectP(']');
        e = { t: 'index', e, i, pos: t.pos };
      } else if (this.isP(':') && e.t === 'var') {
        this.fail('label predicates in expressions are not supported', this.cur, `use ${e.name}:Label in the MATCH pattern, or 'Label' IN labels(${e.name})`);
      } else return e;
    }
  }
  private atom(): Expr {
    const t = this.cur;
    switch (t.type) {
      case 'num':
        this.next();
        return { t: 'lit', v: Number(t.value), pos: t.pos };
      case 'str':
        this.next();
        return { t: 'lit', v: t.value, pos: t.pos };
      case 'param':
        this.next();
        return { t: 'param', name: t.value, pos: t.pos };
      case 'kw':
        if (t.value === 'TRUE' || t.value === 'FALSE') {
          this.next();
          return { t: 'lit', v: t.value === 'TRUE', pos: t.pos };
        }
        if (t.value === 'NULL') {
          this.next();
          return { t: 'lit', v: null, pos: t.pos };
        }
        if (t.value === 'EXISTS') {
          this.next();
          if (this.isP('(')) this.fail('exists(property) is not supported', t, 'use `x.prop IS NOT NULL`, or EXISTS { (a)-[:T]->() } for patterns');
          this.expectP('{');
          if (this.isKw('MATCH')) this.next();
          const patterns = [this.pattern()];
          while (this.isP(',')) {
            this.next();
            patterns.push(this.pattern());
          }
          let where: Expr | undefined;
          if (this.isKw('WHERE')) {
            this.next();
            where = this.expr();
          }
          this.expectP('}');
          return { t: 'exists', patterns, where, pos: t.pos };
        }
        this.fail(`unexpected ${t.value}`, t);
      // eslint-disable-next-line no-fallthrough
      case 'ident': {
        if (REJECTED[t.value.toUpperCase()]) this.rejectWords();
        this.next();
        if (this.isP('(')) return this.call(t);
        return { t: 'var', name: t.value, pos: t.pos };
      }
      case 'punct':
        if (t.value === '(') {
          this.next();
          if (this.cur.type === 'ident' && this.peek().type === 'punct' && [')', ':'].includes(this.peek().value) && this.peek(2).value !== ',') {
            // `(a)-->(b)` in an expression: a pattern predicate.
            if (this.peek().value === ':' || this.peek(2).value === '-' || this.peek(2).value === '<') {
              this.fail('pattern expressions are not supported', t, 'use EXISTS { (a)-[:T]->() }');
            }
          }
          const e = this.expr();
          this.expectP(')');
          return e;
        }
        if (t.value === '[') {
          this.next();
          const items: Expr[] = [];
          while (!this.isP(']')) {
            items.push(this.expr());
            if (!this.isP(',')) break;
            this.next();
          }
          if (this.isP('|') || this.isKw('IN')) this.fail('list comprehensions are not supported', this.cur);
          this.expectP(']');
          return { t: 'list', items, pos: t.pos };
        }
        if (t.value === '{') {
          this.next();
          const entries: [string, Expr][] = [];
          while (!this.isP('}')) {
            const k = this.ident('a key');
            this.expectP(':');
            entries.push([k, this.expr()]);
            if (!this.isP(',')) break;
            this.next();
          }
          this.expectP('}');
          return { t: 'map', entries, pos: t.pos };
        }
        this.fail(`unexpected '${t.value}'`, t);
      // eslint-disable-next-line no-fallthrough
      default:
        this.fail(`unexpected ${this.describe(t)}`, t);
    }
  }
  private call(nameTok: Tok): Expr {
    const name = nameTok.value.toLowerCase();
    if (!FUNCTIONS.has(name)) {
      this.fail(`unknown function '${nameTok.value}'`, nameTok, suggest(name, FUNCTIONS) ?? `supported: ${[...FUNCTIONS].join(', ')}`);
    }
    this.expectP('(');
    let distinct = false;
    let star = false;
    const args: Expr[] = [];
    if (this.isKw('DISTINCT')) {
      this.next();
      distinct = true;
    }
    if (this.isP('*')) {
      if (name !== 'count') this.fail('* is only valid in count(*)');
      this.next();
      star = true;
    } else {
      while (!this.isP(')')) {
        args.push(this.expr());
        if (!this.isP(',')) break;
        this.next();
      }
    }
    this.expectP(')');
    return { t: 'call', name, args, distinct, star, pos: nameTok.pos };
  }
}

export function parseCypher(src: string): Query {
  return new Parser(lex(src)).setSource(src).parse();
}

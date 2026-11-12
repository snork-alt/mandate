/**
 * Plain-text extraction for fenced section types, so search indexes what a reader sees
 * rather than diagram or markup syntax. Pure functions, no DOM.
 */

/** One line of extracted text and the (1-based) body line it came from. */
export interface IndexLine {
  text: string;
  line: number;
}

/* ------------------------------------------------------------------ mermaid */

const MERMAID_HEADER_RE =
  /^(?:flowchart|graph|sequenceDiagram|stateDiagram(?:-v2)?|classDiagram(?:-v2)?|erDiagram|gantt|pie|journey|gitGraph|mindmap|timeline|quadrantChart|requirementDiagram|C4\w*|block-beta|sankey-beta|xychart-beta)\b/;
const MERMAID_SKIP_RE = /^(?:%%|style\s|classDef\s|class\s|linkStyle\s|click\s|direction\s|autonumber\b|activate\s|deactivate\s|end$|accTitle|accDescr)/;
/** Node shapes: id[label], id(label), id{label}, id((label)), id[[label]], id[(label)], id{{label}}, id>label]. */
const NODE_RE = /([A-Za-z_][\w.-]*)\s*(\[\[|\[\(|\(\(|\(\[|\[\/|\[\\|\{\{|\[|\(|\{|>)\s*("?)(.*?)\3\s*(\]\]|\)\]|\)\)|\]\)|\/\]|\\\]|\}\}|\]|\)|\})/g;
const SEQ_ARROW_RE = /^\s*([^\s:+-][^:]*?)\s*(?:<<)?(?:-{1,2})(?:>>|>|x|\))[+-]?\s*([^:]+?)\s*:\s*(.*)$/;
const FLOW_LABEL_ARROW_RE = /\s*(?:--|==|-\.)\s+([^>|]+?)\s+(?:-->|==>|\.->|---|===)\s*/g;
const ARROW_RE = /\s*<?(?:-{2,}|={2,}|-\.+-?)(?:>|x|o)?(?:\|([^|]*)\|)?\s*/g;

const unquote = (s: string) => s.trim().replace(/^"(.*)"$/, '$1').replace(/<br\s*\/?>/gi, ' ').trim();

/** Readable lines from a Mermaid diagram: node and edge labels, participants, messages, notes, block labels. */
export function mermaidToLines(body: string): IndexLine[] {
  const lines = body.replace(/\r\n?/g, '\n').split('\n');
  const labels = new Map<string, string>();
  const out: IndexLine[] = [];
  const name = (id: string) => labels.get(id.trim()) ?? id.trim();
  const push = (text: string, i: number) => {
    const t = text.replace(/\s+/g, ' ').trim();
    if (t) out.push({ text: t, line: i + 1 });
  };

  lines.forEach((raw, i) => {
    let line = raw.trim().replace(/;$/, '');
    if (!line || MERMAID_SKIP_RE.test(line) || /^%%/.test(line)) return;
    if (i === 0 || MERMAID_HEADER_RE.test(line)) {
      const rest = line.replace(MERMAID_HEADER_RE, '').trim();
      if (!MERMAID_HEADER_RE.test(line) || !rest || /^(?:TD|TB|BT|RL|LR)$/.test(rest)) return;
      line = rest;
    }
    let m: RegExpExecArray | null;
    // Sequence diagrams
    if ((m = /^(participant|actor)\s+(\S+)(?:\s+as\s+(.+))?$/.exec(line))) {
      const label = unquote(m[3] ?? m[2]!);
      labels.set(m[2]!, label);
      return push(`${m[1] === 'actor' ? 'Actor' : 'Participant'}: ${label}`, i);
    }
    if ((m = /^note\s+(?:left of|right of|over)\s+([^:]+):\s*(.*)$/i.exec(line))) {
      return push(`Note (${m[1]!.split(',').map(name).join(', ')}): ${unquote(m[2]!)}`, i);
    }
    if ((m = /^(loop|alt|else|opt|par|and|critical|option|break|rect|section|title)\b\s*(.*)$/.exec(line))) {
      if (m[1] === 'rect') return;
      return push(m[2] ? `${m[1]![0]!.toUpperCase()}${m[1]!.slice(1)}: ${unquote(m[2])}` : '', i);
    }
    if ((m = /^state\s+"([^"]+)"\s+as\s+(\S+)/.exec(line))) {
      labels.set(m[2]!, m[1]!);
      return push(`State: ${m[1]}`, i);
    }
    if ((m = /^subgraph\s+(\S+)(?:\s*\[(.+)\])?(?:\s+(.+))?$/.exec(line))) {
      const label = unquote(m[2] ?? m[3] ?? m[1]!);
      labels.set(m[1]!, label);
      return push(`Group: ${label}`, i);
    }
    if ((m = SEQ_ARROW_RE.exec(line)) && !/[[\]{}()|]/.test(m[1]! + m[2]!)) {
      return push(`${name(m[1]!)} → ${name(m[2]!)}: ${unquote(m[3]!)}`, i);
    }
    // Flowchart / state / class lines: replace node definitions by labels, ids by known labels, arrows by →.
    line = line.replace(NODE_RE, (_all, id: string, _o, _q, label: string) => {
      const l = unquote(label);
      labels.set(id, l);
      return `\u0000${l}\u0001`;
    });
    line = line.replace(FLOW_LABEL_ARROW_RE, (_a, label: string) => ` → (${unquote(label)}) `);
    line = line.replace(ARROW_RE, (_a, label?: string) => (label ? ` → (${unquote(label)}) ` : ' → '));
    line = line.replace(/^\[\*\]/, 'start').replace(/\[\*\]/g, 'end');
    // State transitions `A --> B : event`
    line = line.replace(/\s+:\s+/g, ': ');
    line = line
      .split(/(\u0000[^\u0001]*\u0001)/)
      .map((part) =>
        part.startsWith('\u0000') ? part.slice(1, -1) : part.replace(/[A-Za-z_][\w.-]*/g, (w) => labels.get(w) ?? w),
      )
      .join('');
    push(line, i);
  });
  return out;
}

/* ------------------------------------------------------------------ html */

const BLOCK_TAGS = new Set(
  'address article aside blockquote body br dd details dialog div dl dt fieldset figcaption figure footer form h1 h2 h3 h4 h5 h6 header hr li main nav ol p pre section summary table tbody td tfoot th thead tr ul option label button legend caption'.split(
    ' ',
  ),
);
const SKIP_TAGS = new Set(['script', 'style', 'template', 'noscript', 'svg', 'head', 'title']);
const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', middot: '·', mdash: '—', ndash: '–', hellip: '…', copy: '©', rarr: '→', larr: '←', times: '×' };

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : all;
    }
    return ENTITIES[e.toLowerCase()] ?? all;
  });
}

function attr(tag: string, name: string): string | undefined {
  const m = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
  return m ? (m[1] ?? m[2] ?? m[3]) : undefined;
}

/**
 * Visible text of an HTML fragment, one line per block element. Scripts, styles and
 * comments are dropped; headings keep a `#` prefix; alt / placeholder / aria-label texts are kept.
 */
export function htmlToLines(body: string): IndexLine[] {
  const src = body.replace(/\r\n?/g, '\n');
  const out: IndexLine[] = [];
  let cur = '';
  let curLine = 0;
  let heading = 0;
  const lineAt = (offset: number) => {
    let n = 1;
    for (let k = src.indexOf('\n'); k >= 0 && k < offset; k = src.indexOf('\n', k + 1)) n++;
    return n;
  };
  const flush = () => {
    const t = cur.replace(/\s+/g, ' ').trim();
    if (t) out.push({ text: heading ? `${'#'.repeat(heading)} ${t}` : t, line: curLine });
    cur = '';
    curLine = 0;
  };
  const text = (t: string, offset: number) => {
    if (!t.trim()) {
      if (cur) cur += ' ';
      return;
    }
    if (!curLine) curLine = lineAt(offset + (t.length - t.trimStart().length));
    cur += decodeEntities(t);
  };

  let i = 0;
  while (i < src.length) {
    const lt = src.indexOf('<', i);
    if (lt < 0) {
      text(src.slice(i), i);
      break;
    }
    if (lt > i) text(src.slice(i, lt), i);
    if (src.startsWith('<!--', lt)) {
      const end = src.indexOf('-->', lt + 4);
      i = end < 0 ? src.length : end + 3;
      continue;
    }
    const m = /^<\/?([a-zA-Z][\w-]*)\b[^>]*>/.exec(src.slice(lt));
    if (!m) {
      text('<', lt);
      i = lt + 1;
      continue;
    }
    const tag = m[0];
    const name = m[1]!.toLowerCase();
    const closing = tag[1] === '/';
    i = lt + tag.length;
    if (!closing && SKIP_TAGS.has(name) && !tag.endsWith('/>')) {
      const close = src.toLowerCase().indexOf(`</${name}`, i);
      i = close < 0 ? src.length : src.indexOf('>', close) + 1 || src.length;
      continue;
    }
    const isHeading = /^h[1-6]$/.test(name);
    if (BLOCK_TAGS.has(name) || isHeading) {
      flush();
      if (isHeading) heading = closing ? 0 : Number(name[1]);
    }
    if (!closing) {
      const extra = attr(tag, 'alt') ?? attr(tag, 'placeholder') ?? attr(tag, 'aria-label') ?? (name === 'input' && /type\s*=\s*["']?(submit|button)/i.test(tag) ? attr(tag, 'value') : undefined);
      if (extra) text(` ${extra} `, lt);
    }
  }
  flush();
  return out;
}

export const linesToText = (lines: IndexLine[]): string => lines.map((l) => l.text).join('\n');

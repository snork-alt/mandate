import { useMemo, useState } from 'react';
import { diffText } from '@mandate/doc';

type Row = { kind: 'ctx' | 'add' | 'del'; text: string; a?: number; b?: number } | { kind: 'gap'; hidden: Row[] };

const CONTEXT = 3;

function buildRows(before: string, after: string): Row[] {
  const rows: Row[] = [];
  let a = 1;
  let b = 1;
  for (const op of diffText(before, after, 'lines')) {
    const lines = op.text.replace(/\n$/, '').split('\n');
    for (const text of lines) {
      if (op.op === 'equal') rows.push({ kind: 'ctx', text, a: a++, b: b++ });
      else if (op.op === 'delete') rows.push({ kind: 'del', text, a: a++ });
      else rows.push({ kind: 'add', text, b: b++ });
    }
  }
  // Collapse long unchanged runs, keeping a few lines of context around changes.
  const out: Row[] = [];
  for (let i = 0; i < rows.length; ) {
    if (rows[i]!.kind !== 'ctx') {
      out.push(rows[i++]!);
      continue;
    }
    let j = i;
    while (j < rows.length && rows[j]!.kind === 'ctx') j++;
    const run = rows.slice(i, j);
    const head = i === 0 ? 0 : CONTEXT;
    const tail = j === rows.length ? 0 : CONTEXT;
    if (run.length > head + tail + 2) {
      out.push(...run.slice(0, head), { kind: 'gap', hidden: run.slice(head, run.length - tail) }, ...run.slice(run.length - tail));
    } else out.push(...run);
    i = j;
  }
  return out;
}

/** Classic unified line diff with line numbers; unchanged runs collapse into expandable gaps. */
export function LineDiff({ before, after }: { before: string; after: string }) {
  const rows = useMemo(() => buildRows(before, after), [before, after]);
  const [open, setOpen] = useState<Set<number>>(new Set());
  const line = (r: Exclude<Row, { kind: 'gap' }>, k: string) => (
    <div key={k} className="line-diff-row" data-kind={r.kind}>
      <span className="ln">{r.a ?? ''}</span>
      <span className="ln">{r.b ?? ''}</span>
      <span className="sign">{r.kind === 'add' ? '+' : r.kind === 'del' ? '−' : ''}</span>
      <span className="code">{r.text || ' '}</span>
    </div>
  );
  return (
    <div className="line-diff">
      {rows.map((r, i) =>
        r.kind !== 'gap' ? (
          line(r, String(i))
        ) : open.has(i) ? (
          r.hidden.map((h, j) => line(h as Exclude<Row, { kind: 'gap' }>, `${i}-${j}`))
        ) : (
          <button key={i} type="button" className="line-diff-gap" onClick={() => setOpen((o) => new Set(o).add(i))}>
            ⋯ {r.hidden.length} unchanged lines
          </button>
        ),
      )}
    </div>
  );
}

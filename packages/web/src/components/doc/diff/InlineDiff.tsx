import type { TextOp } from '@mandate/doc';

/** Inline word/line diff: insertions highlighted green, deletions red and struck through. */
export function InlineDiff({ ops, mono }: { ops: TextOp[]; mono?: boolean }) {
  return (
    <div className={mono ? 'inline-diff inline-diff-mono' : 'inline-diff'}>
      {ops.map((o, i) =>
        o.op === 'equal' ? (
          <span key={i}>{o.text}</span>
        ) : o.op === 'insert' ? (
          <ins key={i} className="diff-ins">
            {o.text}
          </ins>
        ) : (
          <del key={i} className="diff-del">
            {o.text}
          </del>
        ),
      )}
    </div>
  );
}

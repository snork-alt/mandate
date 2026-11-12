import { parseNodeUri } from '@mandate/shared';
import { RefChip } from './RefChip';

const isRef = (v: unknown): v is string => typeof v === 'string' && /^(@mandate:)?mandate:\/\//.test(v) && parseNodeUri(v) !== null;

/** One cell: references as chips, lists of them as wrapped chips, other lists comma-separated (no raw JSON for lists). */
function Cell({ v: value }: { v: unknown }) {
  let v = value;
  if (isRef(v)) return <RefChip to={v} />;
  // "ref, ref" strings (models often join lists) render as chips too.
  if (typeof v === 'string' && v.includes(',')) {
    const parts = v.split(',').map((x) => x.trim()).filter(Boolean);
    if (parts.length > 1 && parts.every(isRef)) v = parts;
  }
  if (Array.isArray(v)) {
    if (v.length && v.every(isRef)) {
      return (
        <span className="ref-chips">
          {v.map((r) => (
            <RefChip key={r} to={r} />
          ))}
        </span>
      );
    }
    if (v.every((x) => x === null || typeof x !== 'object')) return <>{v.map((x) => String(x ?? '')).join(', ')}</>;
  }
  return <>{typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v ?? '')}</>;
}

/** A table whose cells that are references render as chips. Shared by `mandate-table` and Cypher tool results. */
export function RefTable({ columns, rows, truncated }: { columns: string[]; rows: unknown[][]; truncated?: boolean }) {
  return (
    <div className="embed-table-wrap">
      <table className="embed-table">
        <thead>
          <tr>{columns.map((c) => <th key={c}>{c}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i}>
              {row.map((cell, j) => (
                <td key={j}>
                  <Cell v={cell} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {truncated && <div className="embed-sub">Truncated.</div>}
    </div>
  );
}

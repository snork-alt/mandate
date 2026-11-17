/** Acceptance criteria: the tests that prove them ("Proved by <test>", with the work order that delivered it). */
import type { CodeRef } from '@mandate/shared';
import { Link } from 'react-router';
import { IconFlask } from '@tabler/icons-react';
import { CodeRefChip } from './Chips';

/** `repo:path#Lx-Ly` (or `repo:path`) as a code reference; null for a plain test name. */
export function parseTestRef(test: string): CodeRef | null {
  const m = /^([\w.@-]+):([^\s#:][^\s#]*)(?:#L(\d+)(?:-L?(\d+))?)?$/.exec(test.trim());
  if (!m || !/[/.]/.test(m[2]!)) return null;
  return { repo: m[1]!, path: m[2]!, ...(m[3] ? { lines: m[4] && m[4] !== m[3] ? `${m[3]}-${m[4]}` : m[3] } : {}) };
}

export interface ProvedByEntry {
  test: string;
  workOrder?: string;
  verification?: string;
  at?: string;
}

export function ProvedBy({ items }: { items: ProvedByEntry[] }) {
  if (!items.length) return null;
  return (
    <div className="proved-by" data-testid="proved-by">
      {items.map((p) => {
        const ref = parseTestRef(p.test);
        return (
          <span key={`${p.test}-${p.verification ?? ''}`} className="proved-by-item">
            <IconFlask size={12} />
            <span className="faint small">Proved by</span>
            {ref ? <CodeRefChip codeRef={ref} /> : <span className="chip chip-test mono">{p.test}</span>}
            {p.workOrder && (
              <Link to={`/work-orders/${p.workOrder}`} className="impl-badge impl-work-order" data-testid="proved-by-wo">
                <span className="mono">{p.workOrder}</span>
              </Link>
            )}
          </span>
        );
      })}
    </div>
  );
}

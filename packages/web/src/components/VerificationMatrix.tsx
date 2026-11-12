import type { StandardVerification } from '@mandate/shared';
import { Tooltip } from '@mantine/core';
import { Link } from 'react-router';
import { CriterionStateIcon } from './doc';

/** Specs using a standard × its criteria. */
export function VerificationMatrix({ v }: { v?: StandardVerification }) {
  if (!v || !v.criteria.length) return null;
  return (
    <section className="verif-matrix">
      <h2 className="criteria-group-title">Verification by spec</h2>
      {v.specs.length === 0 ? (
        <p className="section-empty">No spec uses this standard yet.</p>
      ) : (
        <div className="verif-matrix-scroll">
          <table>
            <thead>
              <tr>
                <th>Spec</th>
                {v.criteria.map((c) => (
                  <th key={c.uri}>
                    <Tooltip label={c.title} multiline maw={320} openDelay={300}>
                      <a href={`#section-${c.sectionId}`}>{c.title}</a>
                    </Tooltip>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {v.specs.map((s) => (
                <tr key={s.spec}>
                  <td>
                    <Link to={`/specs/${s.spec}`}>{s.title}</Link>
                  </td>
                  {v.criteria.map((c) => (
                    <td key={c.uri} className="verif-cell">
                      <CriterionStateIcon state={s.states[c.uri] ?? 'unverified'} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

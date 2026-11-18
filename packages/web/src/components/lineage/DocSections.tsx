import type { LineageEdge, LineageNode } from '@mandate/shared';
import { LineageStatusIcon } from './LineagePanel';
import { STATUS_META } from '../../lib/lineage';

const lastPart = (label: string) => label.split(' › ').pop() ?? label;

/**
 * Side panel of a document node (document level of the lineage graph): its sections with their status and links.
 * "Expand in graph" shows this one document's sections as nodes.
 */
export function DocSections({ sections, nodes, edges, onExpand }: { sections: LineageNode[]; nodes: LineageNode[]; edges: LineageEdge[]; onExpand?: () => void }) {
  const label = new Map(nodes.map((n) => [n.uri, n.label]));
  const name = (uri: string) => lastPart(label.get(uri) ?? uri.split('/').pop() ?? uri);
  return (
    <div className="lin-doc-sections" data-testid="doc-sections">
      <div className="lin-doc-sections-head">
        <strong>
          {sections.length} {sections.length === 1 ? 'section' : 'sections'}
        </strong>
        {onExpand && (
          <button type="button" className="arch-focus-pill" onClick={onExpand}>
            Expand in graph
          </button>
        )}
      </div>
      <ul>
        {sections.map((s) => {
          const links = edges.filter((e) => e.from === s.uri || e.to === s.uri);
          return (
            <li key={s.uri} data-testid="doc-section">
              <div className="lin-doc-section-title">
                <LineageStatusIcon status={s.status} size={12} /> {lastPart(s.label)}
                <span className="faint small"> · {s.rawStatus ? s.rawStatus.replace(/_/g, ' ') : STATUS_META[s.status].label}</span>
              </div>
              {links.slice(0, 6).map((e, i) => (
                <div key={i} className="faint small lin-doc-link">
                  {e.from === s.uri ? `${e.kind.replace(/_/g, ' ')} → ${name(e.to)}` : `${name(e.from)} → ${e.kind.replace(/_/g, ' ')}`}
                </div>
              ))}
              {links.length > 6 && <div className="faint small">+{links.length - 6} more</div>}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

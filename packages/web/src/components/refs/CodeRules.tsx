import { IconCircleCheck, IconCircleX } from '@tabler/icons-react';
import { useCodeRules } from '../../lib/lineage';
import '../lineage/lineage.css';

/**
 * Code-ref tooltip lines: "follows: <standard › rule>" and "violates: …" from `code_rules`. Lazy: mount it only while
 * the tooltip is open; results are cached per reference by react-query. Renders nothing when there is nothing to say.
 */
export function CodeRulesLines({ refUri, enabled = true }: { refUri: string; enabled?: boolean }) {
  const q = useCodeRules(refUri, enabled);
  if (!q.data) return null;
  const follows = q.data.follows ?? [];
  const violates = q.data.violates ?? [];
  if (!follows.length && !violates.length) return null;
  return (
    <div className="code-rules" data-testid="code-rules">
      {violates.map((r) => (
        <div key={`v-${r.rule}`} className="code-rules-row" data-kind="violates">
          <IconCircleX size={12} />
          <span className="code-rules-key">violates:</span> {r.label}
        </div>
      ))}
      {follows.slice(0, 6).map((r) => (
        <div key={`f-${r.rule}`} className="code-rules-row" data-kind="follows">
          <IconCircleCheck size={12} />
          <span className="code-rules-key">follows:</span> {r.label}
        </div>
      ))}
      {follows.length > 6 && <div className="faint">+{follows.length - 6} more rules</div>}
    </div>
  );
}

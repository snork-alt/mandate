import type { AuditFinding, AuditItemResult, AuditLevel, Section } from '@mandate/shared';
import { buildFindingRef } from '@mandate/shared/refs';
import { Markdown } from '../Markdown';
import { RefChip } from '../refs/RefChip';
import { useDocInfo } from '../doc/DocInfoContext';
import { LEVEL_LABEL, RESULT_LABEL } from '../../lib/audits';
import { useAuditView } from './context';
import { FindingCard, ItemResultIcon } from './parts';

type ItemSection = Section & {
  ref?: string;
  kind?: 'criterion' | 'rule';
  level?: AuditLevel;
  result?: AuditItemResult | 'pending';
  findings?: Omit<AuditFinding, 'uri' | 'audit' | 'ref' | 'section' | 'itemTitle' | 'kind' | 'level' | 'status' | 'rechecks' | 'resolution'> &
    { resolution?: AuditFinding['resolution']; rechecks?: AuditFinding['rechecks'] }[];
};

/** Result + level accent next to an audit item's title. */
export function AuditItemBadge({ section }: { section: Section }) {
  const s = section as ItemSection;
  if (section.type !== 'audit-item') return null;
  const result = s.result && s.result !== 'pending' ? s.result : undefined;
  return (
    <span className="audit-item-badge" data-result={result ?? 'pending'}>
      <ItemResultIcon result={result} size={12} />
      {RESULT_LABEL[result ?? 'pending']}
      {s.level && <span className="audit-item-level">{LEVEL_LABEL[s.level]}</span>}
    </span>
  );
}

/** Body of an `audit-item` section: what it checks, the prose, then its findings (joined with the derived audit when shown at HEAD). */
export function AuditItemBody({ section }: { section: Section }) {
  const s = section as ItemSection;
  const doc = useDocInfo();
  const view = useAuditView();
  const auditId = view?.id ?? doc?.id ?? '';
  const joined = new Map((view?.items.find((i) => i.sectionId === section.id)?.findings ?? []).map((f) => [f.id, f]));
  const findings: AuditFinding[] = (s.findings ?? []).map((m) => {
    const j = joined.get(m.id);
    const resolution = j?.resolution ?? m.resolution ?? { status: 'open' as const };
    return {
      ...m,
      codeRefs: m.codeRefs ?? [],
      uri: j?.uri ?? buildFindingRef({ audit: auditId, id: m.id }),
      audit: auditId,
      ref: s.ref ?? '',
      section: section.id,
      itemTitle: section.title,
      kind: s.kind ?? 'criterion',
      level: s.level ?? 'should',
      status: j?.status ?? resolution.status,
      resolution,
      rechecks: j?.rechecks ?? m.rechecks ?? [],
    };
  });
  const code = view?.code ? { repo: view.code.repo, commit: view.code.commit } : undefined;
  return (
    <div className="audit-item-body">
      {s.ref && (
        <div className="audit-item-checks small">
          <span className="faint">Checks {s.kind === 'rule' ? 'rule' : 'criterion'}</span>
          <RefChip to={s.ref} />
        </div>
      )}
      {section.body.trim() ? <Markdown>{section.body}</Markdown> : <p className="faint small">{s.result === 'pending' || !s.result ? 'Not checked yet.' : 'No notes.'}</p>}
      {findings.length > 0 && (
        <div className="audit-item-findings">
          <div className="audit-finding-label">Findings · {findings.length}</div>
          {findings.map((f) => (
            <FindingCard key={f.id} f={f} code={code} />
          ))}
        </div>
      )}
    </div>
  );
}

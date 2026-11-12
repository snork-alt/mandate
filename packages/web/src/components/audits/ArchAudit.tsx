import { createContext, useContext, type ReactNode } from 'react';
import { Tooltip } from '@mantine/core';
import type { AuditOverview, ComponentAuditStatus } from '@mandate/shared';
import { useMcpTool } from '../../mcp/queries';
import { plural } from '../../lib/audits';
import { AuditDot } from './parts';

const ArchAuditContext = createContext<Record<string, ComponentAuditStatus>>({});

const LABEL: Record<ComponentAuditStatus['status'], string> = {
  fail: 'Open must findings',
  warn: 'Open should findings',
  pass: 'Audited, no open findings',
  stale: 'Audits stale',
  none: 'Not audited',
};

/** Loads `audit_overview` once for the architecture canvas. */
export function ArchAuditProvider({ children }: { children: ReactNode }) {
  const q = useMcpTool<AuditOverview>('audit_overview', {});
  return <ArchAuditContext.Provider value={q.data?.components ?? {}}>{children}</ArchAuditContext.Provider>;
}

/** Audit status dot of a component (fail red / warn orange / pass green / stale grey dashed / none: nothing). */
export function ArchAuditDot({ id }: { id: string }) {
  const s = useContext(ArchAuditContext)[id];
  if (!s || s.status === 'none') return null;
  const tip = (
    <div>
      <div style={{ fontWeight: 600 }}>Audit: {LABEL[s.status]}</div>
      {(s.openMust > 0 || s.openShould > 0) && (
        <div>
          {plural(s.openMust, 'open must finding')} · {plural(s.openShould, 'open should finding')}
        </div>
      )}
      <div>{plural(s.specs.length, 'audited spec')} affecting it</div>
    </div>
  );
  return (
    <Tooltip label={tip} multiline maw={260} withinPortal>
      <span className="arch-audit-dot" data-status={s.status}>
        <AuditDot tone={s.status} size={8} label={`Audit: ${LABEL[s.status]}`} />
      </span>
    </Tooltip>
  );
}

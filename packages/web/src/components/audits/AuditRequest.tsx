/**
 * "Audit" on a spec / standard page: ask one of the active agents to audit the whole target (every section, own and
 * inherited criteria). The audit is queued for that agent (an offline one catches up when it connects) and its progress
 * shows live on the page and on the audit page.
 */
import { useEffect, useState } from 'react';
import { Button, Modal } from '@mantine/core';
import { IconChecklist } from '@tabler/icons-react';
import { Link } from 'react-router';
import { activeAgents, AgentPicker, defaultAgent } from '../comments/CommentsPanel';
import { useAgentsPresence } from '../../lib/comments';
import { useActiveAudits, useRequestAudit } from '../../lib/auditRequest';
import { auditPath, plural } from '../../lib/audits';
import '../comments/comments.css';
import './audits.css';

export function AuditRequestModal({ opened, onClose, target, title, note }: { opened: boolean; onClose: () => void; target: string; title: string; note?: string }) {
  const presence = useAgentsPresence(undefined);
  const [pick, setPick] = useState<string | undefined>();
  const request = useRequestAudit(() => onClose());
  useEffect(() => {
    if (!opened) setPick(undefined);
  }, [opened]);
  const p = presence.data;
  const assignee = pick && activeAgents(p).some((a) => a.handle === pick) ? pick : defaultAgent(p);
  const chosen = p?.agents?.find((a) => a.handle === assignee);
  return (
    <Modal opened={opened} onClose={onClose} title={`Audit ${title}`} size="lg" centered data-testid="audit-request">
      <div className="nr-form">
        <div className="nr-hint">
          A full audit: the agent checks every section, the own and inherited criteria against the code, and whether the linked tests really prove them. Findings become requests (the code deviates) or questions for you (the spec is wrong or ambiguous). A clean audit confirms the sections and clears their Outdated / Upstream changed badges.
        </div>
        <div>
          <div className="nr-label">Who should audit it?</div>
          <AgentPicker presence={p} value={assignee} onChange={setPick} name="audit-agent" />
        </div>
        <div className="nr-foot">
          <Button variant="default" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={request.isPending} disabled={!assignee} data-testid="audit-request-submit" onClick={() => assignee && request.mutate({ target, assignee, ...(note ? { note } : {}) })}>
            Ask {chosen?.label ?? 'agent'} to audit
          </Button>
        </div>
      </div>
    </Modal>
  );
}

/** The "Audit" button (disabled with the `mandate claude` hint when no agent is active). */
export function AuditRequestButton({ target, title }: { target: string; title: string }) {
  const [open, setOpen] = useState(false);
  const presence = useAgentsPresence(undefined);
  const none = !!presence.data && activeAgents(presence.data).length === 0;
  return (
    <>
      <Button
        size="compact-sm"
        variant="default"
        leftSection={<IconChecklist size={14} />}
        onClick={() => setOpen(true)}
        disabled={none}
        title={none ? 'No agent active: start Claude Code with `mandate claude`.' : 'Ask an agent to audit the code against this'}
        data-testid="audit-button"
      >
        Audit
      </Button>
      {none && (
        <span className="faint" data-testid="audit-no-agent">
          No agent active: start Claude Code with <code>mandate claude</code>.
        </span>
      )}
      <AuditRequestModal opened={open} onClose={() => setOpen(false)} target={target} title={title} />
    </>
  );
}

/** Live line for audits waiting for an agent or running: "Auditing · 3/12 items · 2/5 sections". */
export function AuditProgressLine({ target }: { target: string }) {
  const active = useActiveAudits(target);
  const presence = useAgentsPresence(undefined);
  const list = active.data ?? [];
  if (!list.length) return null;
  const label = (id?: string) => presence.data?.agents?.find((a) => a.id === id)?.label ?? id ?? 'an agent';
  return (
    <div className="audit-progress-lines" data-testid="audit-progress">
      {list.map((a) => {
        const p = a.progress;
        const pct = p.items.total ? Math.round((p.items.done / p.items.total) * 100) : 0;
        return (
          <Link key={a.id} to={auditPath(a.id)} className="audit-progress" data-status={a.status}>
            <span className="audit-progress-text">
              {a.status === 'requested' ? `Audit queued for ${label(a.assignee)}: waiting for it to start` : `${label(a.assignee ?? a.auditor.agent)} is auditing: ${p.items.done}/${p.items.total} ${p.items.total === 1 ? 'item' : 'items'}${p.sections.total ? ` · ${plural(p.sections.done, 'section')} of ${p.sections.total} checked` : ''}`}
            </span>
            <span className="audit-progress-bar" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
              <span style={{ width: `${pct}%` }} />
            </span>
          </Link>
        );
      })}
    </div>
  );
}

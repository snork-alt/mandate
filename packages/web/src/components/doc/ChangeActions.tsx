/**
 * The Outdated / Upstream changed badges of a spec section as a popover: what changed (the editors' plain-language
 * summaries, never a code diff) and three actions:
 *  - Accept: no work needed (wording only / no impact), recorded with who;
 *  - Update: one click files a request for that section (the change summaries and an @-reference in it) for the suggested
 *    active agent (queued when none is active); Alt-click opens the New request form to edit it first;
 *  - Audit: asks an agent to audit the whole spec; a clean audit clears the badge.
 */
import { createContext, useContext, useState, type MouseEvent, type ReactNode } from 'react';
import { Button, Popover } from '@mantine/core';
import type { SectionChange } from '@mandate/shared';
import { buildRef } from '@mandate/shared/refs';
import { activeAgents, defaultAgent } from '../comments/CommentsPanel';
import { AuditRequestModal } from '../audits/AuditRequest';
import { NewRequestModal } from '../requests/NewRequestModal';
import { useAgentsPresence } from '../../lib/comments';
import { useCreateRequest } from '../../lib/requests';
import { useAcceptSection } from '../../lib/auditRequest';
import { relativeTime } from '../../lib/time';
import './changes.css';

/** The spec on screen (provided by the spec page: the badges of its sections get the actions). */
export const SectionChangeContext = createContext<{ specId: string; specTitle: string } | null>(null);

export const NO_SUMMARY = 'No summary; run an Audit to refresh this section.';

export function changeLines(changes: SectionChange[] | undefined): { text: string; by?: string; at?: string; missing?: boolean }[] {
  return (changes ?? []).map((c) => (c.summary ? { text: c.summary, by: c.by, at: c.at } : { text: NO_SUMMARY, by: c.by, at: c.at, missing: true }));
}

export function ChangePopover({
  kind,
  sectionId,
  sectionTitle,
  changes,
  upstream,
  children,
}: {
  kind: 'outdated' | 'upstream';
  sectionId: string;
  sectionTitle?: string;
  changes?: SectionChange[];
  /** Upstream changed: the upstream section (reference and title). */
  upstream?: { to: string; title: string };
  children: ReactNode;
}) {
  const ctx = useContext(SectionChangeContext);
  const [open, setOpen] = useState(false);
  const [auditing, setAuditing] = useState(false);
  const [form, setForm] = useState<string | undefined>();
  const presence = useAgentsPresence(undefined);
  const accept = useAcceptSection();
  const update = useCreateRequest(() => setOpen(false));
  if (!ctx) return <>{children}</>;
  const ref = buildRef({ kind: 'specs', id: ctx.specId, sectionId });
  const lines = changeLines(changes);
  const said = lines.filter((l) => !l.missing).map((l) => l.text);
  const what = kind === 'outdated' ? 'it changed after it was implemented' : `${upstream?.title ?? 'an item it depends on'} changed`;
  const body = `Update ${ref} (${sectionTitle ?? sectionId}): ${what}.${said.length ? ` What changed: ${said.join(' ')}` : ''}${kind === 'upstream' && upstream ? ` See ${upstream.to}.` : ''}`;
  const agent = activeAgents(presence.data).length ? defaultAgent(presence.data) : 'any';
  const onUpdate = (e: MouseEvent) => {
    if (e.altKey) {
      setForm(body);
      return;
    }
    update.mutate({ body, assignee: agent, priority: 'normal', planOnly: false, context: [ref, ...(upstream ? [upstream.to] : [])] });
  };
  return (
    <>
      <Popover opened={open} onChange={setOpen} width={360} position="bottom-start" withArrow shadow="md" trapFocus={false}>
        <Popover.Target>
          <span
            role="button"
            tabIndex={0}
            data-testid={`change-badge-${kind}`}
            onClick={() => setOpen((o) => !o)}
            onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && setOpen((o) => !o)}
            style={{ cursor: 'pointer' }}
          >
            {children}
          </span>
        </Popover.Target>
        <Popover.Dropdown data-testid="change-popover">
          <div className="change-head">{kind === 'outdated' ? 'Changed since implemented' : `Upstream changed${upstream ? `: ${upstream.title}` : ''}`}</div>
          {lines.length ? (
            <ul className="change-list">
              {lines.map((l, i) => (
                <li key={i} data-missing={l.missing || undefined}>
                  <span>{l.text}</span>
                  {(l.by || l.at) && (
                    <span className="change-by">
                      {' '}
                      {l.by}
                      {l.at ? `, ${relativeTime(l.at)}` : ''}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <div className="change-none">{NO_SUMMARY}</div>
          )}
          <div className="change-actions">
            <Button size="compact-xs" variant="default" loading={accept.isPending} data-testid="change-accept" title={kind === 'outdated' ? 'Wording only: nothing to do. Recorded with your name.' : 'The change has no impact on this section.'} onClick={() => accept.mutate({ ref, kind, ...(upstream ? { to: upstream.to } : {}) }, { onSuccess: () => setOpen(false) })}>
              Accept
            </Button>
            <Button size="compact-xs" variant="filled" loading={update.isPending} data-testid="change-update" title={`Files a request for ${agent === 'any' ? 'the next agent (none is active: queued)' : 'the suggested agent'}. Alt-click edits it first.`} onClick={onUpdate}>
              Update
            </Button>
            <Button size="compact-xs" variant="default" data-testid="change-audit" title="Ask an agent to audit the whole spec" onClick={() => setAuditing(true)}>
              Audit
            </Button>
          </div>
        </Popover.Dropdown>
      </Popover>
      <AuditRequestModal opened={auditing} onClose={() => setAuditing(false)} target={buildRef({ kind: 'specs', id: ctx.specId })} title={ctx.specTitle} note={`${kind === 'outdated' ? 'Outdated' : 'Upstream changed'}: ${sectionTitle ?? sectionId}`} />
      <NewRequestModal opened={form !== undefined} onClose={() => setForm(undefined)} initialBody={form} />
    </>
  );
}

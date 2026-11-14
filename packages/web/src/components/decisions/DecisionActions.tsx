/**
 * Item actions on pending items (Overview, feedback page, work order page): a "…" menu with "Copy prompt for your
 * coding agent" and, for pure human decisions only, direct actions behind a concise confirmation dialog.
 * Nothing here edits document content.
 */
import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';
import { ActionIcon, Button, Group, Menu, Modal, SegmentedControl, Select, Text, Textarea, Tooltip } from '@mantine/core';
import { IconCheck, IconCopy, IconDots, IconMoonStars, IconPlayerStop, IconX, IconCopyCheck, IconUserCheck } from '@tabler/icons-react';
import { copyText } from '../../lib/copy';
import { useDecide, useDecisionAccess, type DecisionAccess } from '../../lib/decisions';
import { useFeedback } from '../../lib/queries';
import './decisions.css';

/* ---------------------------------------------------------------- dialogs */

export type DialogRequest =
  | { type: 'accept'; ref: string; title: string; /** Waiver approvals the user wrote themselves: needs an override with a reason. */ selfApproval?: boolean }
  | { type: 'reject'; ref: string; title: string }
  | { type: 'duplicate'; ref: string; title: string }
  | { type: 'release'; ref: string; title: string; agent?: string; heartbeat?: string }
  | { type: 'snooze'; rule: string; uri: string; title: string }
  | { type: 'confirm_override'; ref: string; title: string }
  /** Several open feedback items at once (Actions › Feedback: the selected or suggested ones). */
  | { type: 'accept_many'; refs: string[]; title: string };

interface DialogApi {
  open: (r: DialogRequest) => void;
  access: DecisionAccess | undefined;
}
const DialogCtx = createContext<DialogApi | null>(null);
export const useDecisionDialogs = () => useContext(DialogCtx);

const RECORDED = 'Recorded in the project history (a commit attributed to you), visible in Activity.';

function DialogBody({ req, onClose, access }: { req: DialogRequest; onClose: () => void; access: DecisionAccess | undefined }) {
  const decide = useDecide(onClose);
  const [note, setNote] = useState('');
  const [days, setDays] = useState('7');
  const [dup, setDup] = useState<string | null>(null);
  const feedback = useFeedback();
  const busy = decide.isPending;
  const footer = (label: string, disabled: boolean, run: () => void, color?: string) => (
    <Group justify="flex-end" mt="md" gap="xs">
      <Button variant="default" onClick={onClose} disabled={busy}>
        Cancel
      </Button>
      <Button onClick={run} disabled={disabled} loading={busy} color={color} data-testid="decision-confirm">
        {label}
      </Button>
    </Group>
  );
  const meta = <Text size="xs" c="dimmed" mt={8}>{RECORDED}</Text>;

  if (req.type === 'accept') {
    const needsOverride = !!req.selfApproval;
    const eligible = access?.override.ok ?? false;
    return (
      <>
        <Text size="sm">
          Accept <strong>{req.title}</strong>: it will be acted on (a coding agent changes the spec or standard through a work order).
        </Text>
        {needsOverride && (
          <>
            <Text size="sm" mt="sm">
              This approves a change you wrote yourself, so it needs an <strong>approval override</strong> with a reason. {eligible ? `You are eligible (${access?.override.why}).` : `You are not eligible: ${access?.override.why ?? 'unknown'}.`}
            </Text>
            <Textarea label="Override reason" required mt="xs" autosize minRows={2} maxLength={500} value={note} onChange={(e) => setNote(e.currentTarget.value)} disabled={!eligible} data-testid="override-reason" />
          </>
        )}
        {meta}
        {footer(needsOverride ? 'Accept with override' : 'Accept', (needsOverride && (!eligible || !note.trim())) || busy, () =>
          decide.mutate({ tool: 'feedback_accept', args: { ref: req.ref, ...(needsOverride ? { override: true, overrideReason: note.trim() } : {}) } }),
        )}
      </>
    );
  }
  if (req.type === 'accept_many') return <AcceptMany refs={req.refs} onClose={onClose} />;
  if (req.type === 'reject') {
    return (
      <>
        <Text size="sm">
          Reject <strong>{req.title}</strong>. Closed feedback cannot be reopened; the reason is shown to everyone.
        </Text>
        <Textarea label="Reason" required mt="xs" autosize minRows={2} maxLength={1000} value={note} onChange={(e) => setNote(e.currentTarget.value)} data-autofocus data-testid="reject-reason" />
        {meta}
        {footer('Reject', !note.trim() || busy, () => decide.mutate({ tool: 'feedback_close', args: { ref: req.ref, resolution: 'rejected', resolutionNote: note.trim() } }), 'red')}
      </>
    );
  }
  if (req.type === 'duplicate') {
    const id = req.ref.split('/').pop();
    const options = (feedback.data ?? []).filter((f) => f.id !== id).map((f) => ({ value: f.id, label: `${f.id} · ${f.body.replace(/\s+/g, ' ').slice(0, 70)}` }));
    return (
      <>
        <Text size="sm">
          Close <strong>{req.title}</strong> as a duplicate of another feedback item.
        </Text>
        <Select label="Original item" required mt="xs" searchable data={options} value={dup} onChange={setDup} nothingFoundMessage="No feedback item" data-testid="duplicate-of" comboboxProps={{ withinPortal: true }} />
        {meta}
        {footer('Mark duplicate', !dup || busy, () => decide.mutate({ tool: 'feedback_close', args: { ref: req.ref, resolution: 'duplicate', duplicateOf: dup! } }))}
      </>
    );
  }
  if (req.type === 'confirm_override') {
    return (
      <>
        <Text size="sm">
          Confirm the self-approved acceptance of <strong>{req.title}</strong>: you are a second person and reviewed it. It leaves the integrity warnings, and the coding agent that self-approved it is told. The person who made the override cannot confirm it.
        </Text>
        <Textarea label="Review note" required mt="xs" autosize minRows={2} maxLength={500} value={note} onChange={(e) => setNote(e.currentTarget.value)} data-autofocus data-testid="confirm-override-note" />
        {meta}
        {footer('Confirm override', !note.trim() || busy, () => decide.mutate({ tool: 'approval_override_confirm', args: { ref: req.ref, note: note.trim().replace(/\s+/g, ' ') } }))}
      </>
    );
  }
  if (req.type === 'release') {
    return (
      <>
        <Text size="sm">
          Release the claim of <strong>{req.agent ?? 'the agent'}</strong> on <strong>{req.title}</strong>? It sent no heartbeat recently{req.heartbeat ? ` (last ${req.heartbeat})` : ''}. The work order goes back to pending; its notes and progress stay, and another agent can claim it.
        </Text>
        {meta}
        {footer('Release claim', busy, () => decide.mutate({ tool: 'work_order_release', args: { ref: req.ref } }), 'orange')}
      </>
    );
  }
  return (
    <>
      <Text size="sm">
        Acknowledge the warning <strong>{req.title}</strong>: it leaves the attention counts for the chosen time, then comes back if it still applies.
      </Text>
      <Text size="xs" fw={500} mt="sm" mb={4}>
        Snooze for
      </Text>
      <SegmentedControl value={days} onChange={setDays} data={['1', '7', '14', '30', '90'].map((d) => ({ value: d, label: `${d} day${d === '1' ? '' : 's'}` }))} size="xs" />
      <Textarea label="Note" required mt="xs" autosize minRows={2} maxLength={500} value={note} onChange={(e) => setNote(e.currentTarget.value)} placeholder="Why this is acceptable for now" data-testid="snooze-note" />
      {meta}
      {footer('Snooze', !note.trim() || busy, () => decide.mutate({ tool: 'integrity_snooze', args: { rule: req.rule, uri: req.uri, days: Number(days), note: note.trim() } }))}
    </>
  );
}

/** Accepts several feedback items one after the other (each is its own recorded decision). */
function AcceptMany({ refs, onClose }: { refs: string[]; onClose: () => void }) {
  const decide = useDecide();
  const [done, setDone] = useState(0);
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try {
      for (const ref of refs) {
        await decide.mutateAsync({ tool: 'feedback_accept', args: { ref } });
        setDone((n) => n + 1);
      }
      onClose();
    } catch {
      /* the failure is shown by useDecide; the rest stays pending */
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Text size="sm">
        Accept <strong>{refs.length === 1 ? '1 feedback item' : `${refs.length} feedback items`}</strong>: each will be acted on (a coding agent changes the spec or standard through a work order).
      </Text>
      <Text size="xs" c="dimmed" mt={8}>{RECORDED} One decision per item.</Text>
      <Group justify="flex-end" mt="md" gap="xs">
        <Button variant="default" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button onClick={() => void run()} loading={busy} disabled={!refs.length} data-testid="decision-confirm">
          {busy ? `Accepting ${done + 1} of ${refs.length}` : `Accept ${refs.length}`}
        </Button>
      </Group>
    </>
  );
}

const TITLE: Record<DialogRequest['type'], string> = {
  accept: 'Accept feedback',
  reject: 'Reject feedback',
  duplicate: 'Mark as duplicate',
  release: 'Release stale claim',
  snooze: 'Snooze integrity warning',
  confirm_override: 'Confirm approval override',
  accept_many: 'Accept feedback',
};

/** Hosts the confirmation dialogs for everything below it. */
export function DecisionDialogs({ children }: { children: ReactNode }) {
  const [req, setReq] = useState<DialogRequest | null>(null);
  const access = useDecisionAccess().data;
  const api = useMemo<DialogApi>(() => ({ open: setReq, access }), [access]);
  return (
    <DialogCtx.Provider value={api}>
      {children}
      <Modal opened={!!req} onClose={() => setReq(null)} title={req ? TITLE[req.type] : ''} size="md" centered data-testid="decision-dialog">
        {req && <DialogBody key={JSON.stringify(req)} req={req} onClose={() => setReq(null)} access={access} />}
      </Modal>
    </DialogCtx.Provider>
  );
}

/* ---------------------------------------------------------------- menus */

export interface ItemAction {
  id: string;
  label: string;
  icon?: ReactNode;
  dialog: DialogRequest;
  /** Shown first as a button next to the menu. */
  primary?: boolean;
  /** Also shown as a subtle button next to the primary one (Actions page rows). */
  inline?: boolean;
  danger?: boolean;
}

const ICON: Record<DialogRequest['type'], ReactNode> = {
  accept: <IconCheck size={14} />,
  reject: <IconX size={14} />,
  duplicate: <IconCopyCheck size={14} />,
  release: <IconPlayerStop size={14} />,
  snooze: <IconMoonStars size={14} />,
  confirm_override: <IconUserCheck size={14} />,
  accept_many: <IconCheck size={14} />,
};

/** Why direct actions are unavailable (no write access to the repository), or null. */
export function useActionBlock(): string | null {
  const d = useDecisionDialogs();
  if (!d) return 'Unavailable here';
  if (!d.access) return null;
  return d.access.canDecide ? null : 'Recording decisions needs write (push) access to this project\'s repository';
}

/** "…" menu: copy a prompt for the coding agent, plus the item's direct decisions (if any). */
export function ItemMenu({ label, prompt, actions = [], showPrimary = true }: { label: string; prompt: string; actions?: ItemAction[]; showPrimary?: boolean }) {
  const dialogs = useDecisionDialogs();
  const block = useActionBlock();
  const primary = showPrimary ? actions.find((a) => a.primary) : undefined;
  const run = (a: ItemAction) => dialogs?.open(a.dialog);
  return (
    <span className="item-actions" onClick={(e) => e.stopPropagation()}>
      {primary && (
        <Tooltip label={block ?? primary.label} openDelay={300} disabled={!block}>
          <Button size="compact-xs" variant="default" leftSection={primary.icon ?? ICON[primary.dialog.type]} onClick={() => run(primary)} disabled={!!block} data-testid="item-primary">
            {primary.label}
          </Button>
        </Tooltip>
      )}
      {showPrimary &&
        actions
          .filter((a) => a.inline && !a.primary)
          .map((a) => (
            <Tooltip key={a.id} label={block ?? a.label} openDelay={300} disabled={!block}>
              <Button size="compact-xs" variant="subtle" color="gray" onClick={() => run(a)} disabled={!!block} data-testid={`item-inline-${a.id}`}>
                {a.label}
              </Button>
            </Tooltip>
          ))}
      <Menu position="bottom-end" width={260} withinPortal shadow="md">
        <Menu.Target>
          <ActionIcon variant="subtle" size="sm" aria-label={`Actions for ${label}`} data-testid="item-menu">
            <IconDots size={15} />
          </ActionIcon>
        </Menu.Target>
        <Menu.Dropdown>
          <Menu.Item leftSection={<IconCopy size={14} />} onClick={() => void copyText(prompt, 'Prompt copied: paste it into your coding agent')} data-testid="copy-prompt">
            Copy prompt for your coding agent
          </Menu.Item>
          {actions.length > 0 && <Menu.Divider />}
          {actions.map((a) => (
            <Tooltip key={a.id} label={block} disabled={!block} position="left" openDelay={200}>
              <div>
                <Menu.Item leftSection={a.icon ?? ICON[a.dialog.type]} color={a.danger ? 'red' : undefined} onClick={() => run(a)} disabled={!!block} data-testid={`action-${a.id}`}>
                  {a.label}…
                </Menu.Item>
              </div>
            </Tooltip>
          ))}
        </Menu.Dropdown>
      </Menu>
    </span>
  );
}

/** Section-level "Copy prompt for all" / "Resolve with your coding agent" button. */
export function CopyPromptButton({ prompt, label = 'Copy prompt for all', testId = 'copy-all' }: { prompt: string; label?: string; testId?: string }) {
  return (
    <Tooltip label="Copies a short prompt: paste it into your coding agent" openDelay={400}>
      <Button size="compact-xs" variant="subtle" color="gray" leftSection={<IconCopy size={13} />} onClick={() => void copyText(prompt, 'Prompt copied: paste it into your coding agent')} data-testid={testId}>
        {label}
      </Button>
    </Tooltip>
  );
}

/** Feedback decisions (accept primary, reject, duplicate). */
export const feedbackActions = (ref: string, title: string, opts: { status: 'open' | 'accepted'; selfApproval?: boolean } = { status: 'open' }): ItemAction[] =>
  opts.status === 'open'
    ? [
        { id: 'accept', label: opts.selfApproval ? 'Approve with override' : 'Accept', primary: true, dialog: { type: 'accept', ref, title, selfApproval: opts.selfApproval } },
        { id: 'reject', label: 'Reject', danger: true, dialog: { type: 'reject', ref, title } },
        { id: 'duplicate', label: 'Mark duplicate', dialog: { type: 'duplicate', ref, title } },
      ]
    : [{ id: 'reject', label: 'Reject', danger: true, dialog: { type: 'reject', ref, title } }];

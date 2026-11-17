/**
 * A textarea with @-autocomplete: agents / people (their handle) and Mandate objects (specs, spec / standard / component
 * sections, standards, components, requests, work orders). Choosing an object inserts its canonical reference into
 * the text (it renders as a reference chip wherever the text is shown) and shows it as a removable chip below the box;
 * the server stores the references of a request / comment found in the text. Used by the comment boxes and the New
 * request form.
 */
import { useMemo, useState } from 'react';
import { Textarea } from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { IconX } from '@tabler/icons-react';
import { buildRef, extractRefs, REF_SCHEME, type NodeKind } from '@mandate/shared';
import { KindIcon } from '../refs/KindIcon';
import { refKind } from '../refs/kinds';
import { useMcpSearch } from '../../mcp/queries';
import { useFeedback, useWorkOrders } from '../../lib/queries';
import { firstLine } from '../../lib/feedback';
import type { PresenceReply } from '../../lib/comments';

const TRIGGER = /(^|\s)@([\w.:/-]*)$/;

interface Option {
  key: string;
  insert: string;
  label: string;
  sub: string;
  kind?: NodeKind;
}

const stripLines = (uri: string) => uri.replace(/#L\d+(-L\d+)?$/, '');
const short = (ref: string) => ref.replace(REF_SCHEME, '');

/** Remove every occurrence of a reference (and one following space) from a text. */
export const withoutRef = (text: string, ref: string) => text.split(ref).join('').replace(/ {2,}/g, ' ').replace(/^ +| +$/g, (m) => (m.includes('\n') ? m : ''));

export function RefMentionBox({
  value,
  onChange,
  presence,
  placeholder,
  onSubmit,
  autoFocus,
  label = 'Comment',
  minRows = 2,
  maxRows = 8,
  required,
  error,
  chips = true,
}: {
  value: string;
  onChange: (v: string) => void;
  presence?: PresenceReply | undefined;
  placeholder: string;
  onSubmit?: () => void;
  autoFocus?: boolean;
  label?: string;
  minRows?: number;
  maxRows?: number;
  required?: boolean;
  error?: string | undefined;
  /** Show the referenced objects as chips below the box. */
  chips?: boolean;
}) {
  const m = TRIGGER.exec(value);
  const q = m?.[2] ?? '';
  const [dq] = useDebouncedValue(q, 200);
  const [active, setActive] = useState(0);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const search = useMcpSearch(dq, { kinds: [], status: [] }, !!m && dq.length > 0);
  const requests = useFeedback();
  const workOrders = useWorkOrders();

  const opts = useMemo<Option[]>(() => {
    if (!m) return [];
    const lq = q.toLowerCase();
    const out: Option[] = [];
    const agents = new Map<string, string>();
    for (const a of presence?.agents ?? []) {
      agents.set(a.handle, `${a.label} · ${a.state}`);
      if (a.user) agents.set(a.user.toLowerCase(), `${a.user} (all their agents)`);
    }
    for (const [h, sub] of agents) if (h.toLowerCase().startsWith(lq)) out.push({ key: `a:${h}`, insert: `@${h} `, label: `@${h}`, sub });
    if (lq) {
      // Requests and work orders by id or words (lists are cached); everything else through search.
      for (const f of requests.data ?? []) {
        if (out.length > 14) break;
        if (f.id.toLowerCase().startsWith(lq) || (lq.length > 2 && f.body.toLowerCase().includes(lq))) out.push({ key: `r:${f.id}`, insert: `${buildRef({ kind: 'feedback', id: f.id })} `, label: f.id, sub: `Request · ${firstLine(f.body).slice(0, 60)}`, kind: 'feedback' });
      }
      for (const w of workOrders.data ?? []) {
        if (out.length > 14) break;
        if (w.id.toLowerCase().startsWith(lq)) out.push({ key: `w:${w.id}`, insert: `${buildRef({ kind: 'work-orders', id: w.id })} `, label: w.id, sub: `Work order${w.title ? ` · ${w.title.slice(0, 60)}` : ''}`, kind: 'work_order' });
      }
      for (const g of search.data?.groups ?? []) {
        for (const h of g.hits.slice(0, 3)) {
          const uri = stripLines(h.uri);
          if (out.some((o) => o.insert.trim() === uri)) continue;
          out.push({ key: `s:${uri}`, insert: `${uri} `, label: h.sectionTitle ?? h.docTitle, sub: h.sectionTitle ? `${h.docKind} · ${h.docTitle}` : h.docKind, kind: refKind(uri) ?? undefined });
        }
      }
    }
    return out.slice(0, 8);
  }, [m, q, presence, requests.data, workOrders.data, search.data]);

  const open = opts.length > 0 && dismissed !== value;
  const pick = (o: Option) => {
    onChange(value.replace(/@[\w.:/-]*$/, o.insert));
    setActive(0);
  };
  const refs = useMemo(() => (chips ? extractRefs(value) : []), [chips, value]);

  return (
    <div className="cmt-mention" data-testid="ref-mention-box">
      <Textarea
        autosize
        minRows={minRows}
        maxRows={maxRows}
        value={value}
        placeholder={placeholder}
        autoFocus={autoFocus}
        required={required}
        error={error}
        onChange={(e) => {
          setDismissed(null);
          setActive(0);
          onChange(e.currentTarget.value);
        }}
        onKeyDown={(e) => {
          if (open) {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setActive((a) => (a + 1) % opts.length);
              return;
            }
            if (e.key === 'ArrowUp') {
              e.preventDefault();
              setActive((a) => (a - 1 + opts.length) % opts.length);
              return;
            }
            if (e.key === 'Enter' || e.key === 'Tab') {
              e.preventDefault();
              pick(opts[Math.min(active, opts.length - 1)]!);
              return;
            }
            if (e.key === 'Escape') {
              e.stopPropagation();
              setDismissed(value);
              return;
            }
          }
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') onSubmit?.();
        }}
        aria-label={label}
      />
      {open && (
        <ul className="cmt-mention-list" role="listbox" aria-label="Mention suggestions">
          {opts.map((o, i) => (
            <li key={o.key}>
              <button type="button" role="option" aria-selected={i === active} data-active={i === active || undefined} onMouseDown={(e) => e.preventDefault()} onClick={() => pick(o)}>
                {o.kind && <KindIcon kind={o.kind} size={13} />} <b>{o.label}</b> <span className="cmt-faint">{o.sub}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {refs.length > 0 && (
        <div className="cmt-refchips" data-testid="ref-chips">
          {refs.map((r) => {
            const k = refKind(r);
            return (
              <span key={r} className="cmt-refchip" title={r}>
                {k && <KindIcon kind={k} size={12} />}
                {short(r)}
                <button type="button" aria-label={`Remove ${short(r)}`} onClick={() => onChange(withoutRef(value, r))}>
                  <IconX size={11} />
                </button>
              </span>
            );
          })}
        </div>
      )}
    </div>
  );
}

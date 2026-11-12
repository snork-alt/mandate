import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Skeleton } from '@mantine/core';
import { IconGitCommit } from '@tabler/icons-react';
import { parseNodeUri, mentionOf, type Section, type Spec, type Standard } from '@mandate/shared';
import { api } from '../../api';
import { AcceptanceCard } from '../doc/Acceptance';
import { ClaimCard } from '../doc/Claim';
import { SectionBlock } from '../doc/SectionBlock';
import { sectionTarget } from '../../lib/refs';
import { copyText } from '../../lib/copy';
import { RefChip } from './RefChip';
import { StatusGlyph } from './StatusGlyph';
import { useRefNode } from './useRefNode';
import { refKind } from './kinds';

const Card = ({ children, invalid }: { children: React.ReactNode; invalid?: boolean }) => (
  <div className="embed-card" data-invalid={invalid || undefined}>
    {children}
  </div>
);

function Loading() {
  return (
    <Card>
      <Skeleton height={14} width="50%" mb={8} />
      <Skeleton height={10} />
    </Card>
  );
}

function Unavailable({ uri, error }: { uri: string; error?: string }) {
  return (
    <Card invalid>
      <RefChip to={uri} resolve={false} />
      <div className="embed-sub">{error ?? 'Could not load this reference.'}</div>
    </Card>
  );
}

/** A section as a live compact card (criteria as the criterion card with its verification state). */
function SectionEmbed({ uri, kind, id, sectionId, commit }: { uri: string; kind: 'specs' | 'standards'; id: string; sectionId: string; commit?: string }) {
  const doc = useQuery({ queryKey: [kind, id], queryFn: () => api.get(kind, id) as Promise<Spec | Standard>, staleTime: 10_000 });
  if (doc.isPending) return <Loading />;
  const section: Section | undefined = doc.data?.sections.find((s) => s.id === sectionId);
  if (!section) return <Unavailable uri={uri} error={doc.error ? (doc.error as Error).message : `Section "${sectionId}" not found in ${id}.`} />;
  const target = sectionTarget(kind, id, section, commit);
  const state = kind === 'specs' ? (doc.data as Spec & { verification?: { own: { sectionId: string }[] } }).verification?.own.find((c) => c.sectionId === sectionId) : undefined;
  return (
    <Card>
      <div className="embed-head">
        <RefChip to={uri} />
        {commit && <span className="embed-sub">pinned to @{commit.slice(0, 7)}</span>}
      </div>
      <div className="embed-compact">
        {section.type === 'acceptance' ? <AcceptanceCard section={section} state={state as never} target={target} /> : <SectionBlock section={section} target={target} />}
      </div>
    </Card>
  );
}

function DocEmbed({ uri, kind, id }: { uri: string; kind: 'specs' | 'standards'; id: string }) {
  const doc = useQuery({ queryKey: [kind, id], queryFn: () => api.get(kind, id) as Promise<Spec | Standard>, staleTime: 10_000 });
  if (doc.isPending) return <Loading />;
  if (!doc.data) return <Unavailable uri={uri} error={(doc.error as Error | null)?.message} />;
  const d = doc.data;
  return (
    <Card>
      <div className="embed-head">
        <RefChip to={uri} />
        {'status' in d && <StatusGlyph status={(d as Spec).status} />}
      </div>
      {d.summary && <div>{d.summary}</div>}
      <div className="embed-sub">{d.sections.length} sections</div>
    </Card>
  );
}

function WorkOrderEmbed({ uri, id }: { uri: string; id: string }) {
  const q = useQuery({ queryKey: ['work-orders', id, 'resolved'], queryFn: () => api.workOrder(id), staleTime: 10_000 });
  if (q.isPending) return <Loading />;
  if (!q.data) return <Unavailable uri={uri} error={(q.error as Error | null)?.message} />;
  const { item, spec } = q.data;
  const done = item.sections.filter((s) => s.status === 'done').length;
  const pct = item.sections.length ? Math.round((done / item.sections.length) * 100) : 0;
  return (
    <Card>
      <div className="embed-head">
        <RefChip to={uri} />
        <span className="embed-sub">{item.kind}{spec ? ` · ${spec.title}` : ''}</span>
      </div>
      <div className="embed-progress" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
        <span style={{ width: `${pct}%` }} />
      </div>
      <div className="embed-sub">
        {done}/{item.sections.length} sections done · {item.status.replace('_', ' ')}
      </div>
      {item.claim && <ClaimCard claim={item.claim} now={Date.now()} />}
    </Card>
  );
}

function FeedbackEmbed({ uri, id }: { uri: string; id: string }) {
  const q = useQuery({ queryKey: ['feedback', id, 'resolved'], queryFn: () => api.feedbackItem(id), staleTime: 10_000 });
  if (q.isPending) return <Loading />;
  if (!q.data) return <Unavailable uri={uri} error={(q.error as Error | null)?.message} />;
  const f = q.data.feedback;
  return (
    <Card>
      <div className="embed-head">
        <RefChip to={uri} />
        <span className="embed-sub">{f.kind}{f.resolution ? ` · ${String(f.resolution).replace('_', ' ')}` : ''}</span>
      </div>
      <div>{f.body.split('\n')[0]}</div>
    </Card>
  );
}

/** Commit: subject, author and date; opens the track-changes view of the document it touched when known. */
function CommitEmbed({ uri }: { uri: string }) {
  const node = useRefNode(uri);
  if (node.isPending) return <Loading />;
  if (!node.data) return <Unavailable uri={uri} error={node.error?.message} />;
  const p = node.data.props as { sha?: string; subject?: string; author?: string; date?: string };
  return (
    <Card>
      <div className="embed-head">
        <IconGitCommit size={15} />
        <span className="embed-title">{p.subject ?? node.data.label}</span>
      </div>
      <div className="embed-sub">
        {(p.sha ?? '').slice(0, 7)} · {p.author} · {p.date ? new Date(p.date).toLocaleString() : ''}
      </div>
      <button type="button" className="ask-add" onClick={() => void copyText(mentionOf(uri), 'Copied reference')} style={{ marginTop: 6 }}>
        Copy reference
      </button>
    </Card>
  );
}

/** One live card for any reference (the `mandate-embed` block). */
export function RefEmbed({ uri }: { uri: string }) {
  const r = useMemo(() => parseNodeUri(uri), [uri]);
  const kind = refKind(uri);
  if (!r || !kind) return <Unavailable uri={uri} error="Not a valid Mandate reference." />;
  if ((r.kind === 'specs' || r.kind === 'standards') && r.sectionId) return <SectionEmbed uri={uri} kind={r.kind} id={r.id} sectionId={r.sectionId} commit={r.commit} />;
  if (r.kind === 'specs' || r.kind === 'standards') return <DocEmbed uri={uri} kind={r.kind} id={r.id} />;
  if (r.kind === 'work-orders') return <WorkOrderEmbed uri={uri} id={r.id} />;
  if (r.kind === 'feedback') return <FeedbackEmbed uri={uri} id={r.id} />;
  if (r.kind === 'commits') return <CommitEmbed uri={uri} />;
  return (
    <Card>
      <RefChip to={uri} />
    </Card>
  );
}

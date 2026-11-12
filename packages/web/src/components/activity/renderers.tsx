import type { ReactNode } from 'react';
import { IconArrowRight } from '@tabler/icons-react';
import { RefChip } from '../refs/RefChip';
import { StatusGlyph } from '../refs/StatusGlyph';
import type { ActivityEvent, ActivityRendererRegistry } from './types';

type Details = NonNullable<ActivityEvent['details']>;
const subject = (e: ActivityEvent) => (e.refs[0] ? <RefChip to={e.refs[0]} /> : null);
const label = (s: string) => s.replace(/_/g, ' ');

/** Mini word diff of a section edit: inserted text green, deleted red. */
export function WordPreview({ ops }: { ops: NonNullable<Details['preview']> }) {
  return (
    <div className="activity-preview" aria-label="Edit preview">
      {ops.map((o, i) => (
        <span key={i} className={o.op === 'insert' ? 'wp-ins' : o.op === 'delete' ? 'wp-del' : undefined} data-op={o.op}>
          {o.text}
        </span>
      ))}
    </div>
  );
}

export function Progress({ done, total }: { done: number; total: number }) {
  const pct = total ? Math.round((done / total) * 100) : 0;
  return (
    <div className="activity-progress" title={`${done}/${total}`}>
      <div className="embed-progress" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
        <span style={{ width: `${pct}%` }} />
      </div>
      <span className="rail-faint">{done}/{total}</span>
    </div>
  );
}

const summaryLine = (e: ActivityEvent) => <div className="activity-summary">{e.summary}</div>;

const sectionEdit = (e: ActivityEvent): ReactNode => (
  <>
    {subject(e)}
    {summaryLine(e)}
    {e.details?.preview && e.details.preview.length > 0 && <WordPreview ops={e.details.preview} />}
  </>
);

const statusChange = (e: ActivityEvent): ReactNode => {
  const s = e.details?.status;
  return (
    <>
      {subject(e)}
      {s ? (
        <div className="activity-status">
          {s.from ? <StatusGlyph status={s.from} /> : null}
          <span>{s.from ? label(s.from) : 'none'}</span>
          <IconArrowRight size={12} />
          {s.to ? <StatusGlyph status={s.to} /> : null}
          <span>{s.to ? label(s.to) : 'none'}</span>
        </div>
      ) : (
        summaryLine(e)
      )}
    </>
  );
};

const workOrder = (e: ActivityEvent): ReactNode => (
  <>
    {subject(e)}
    {summaryLine(e)}
    {e.details?.progress && <Progress done={e.details.progress.done} total={e.details.progress.total} />}
    {e.details?.sectionTitle && <div className="rail-faint">Section: {e.details.sectionTitle}</div>}
  </>
);

const feedback = (e: ActivityEvent): ReactNode => (
  <>
    {subject(e)}
    {summaryLine(e)}
    <div className="activity-tags">
      {e.details?.kind && <span className="cmdk-badge">{String(e.details.kind)}</span>}
      {e.details?.resolution && <span className="cmdk-badge">{label(String(e.details.resolution))}</span>}
    </div>
  </>
);

const verification = (e: ActivityEvent): ReactNode => (
  <>
    {subject(e)}
    <div className="activity-status">
      {e.details?.result && <StatusGlyph status={e.details.result} />}
      <span>{e.details?.result ?? 'recorded'}</span>
    </div>
    {summaryLine(e)}
  </>
);

const pulled = (e: ActivityEvent): ReactNode => (
  <>
    {summaryLine(e)}
    {e.details?.commits && <div className="rail-faint">{e.details.commits.length} commit{e.details.commits.length === 1 ? '' : 's'} pulled</div>}
  </>
);

const pushed = (e: ActivityEvent): ReactNode => {
  const r = e.details?.range as { from: string | null; to: string } | undefined;
  return (
    <>
      {summaryLine(e)}
      {r && (
        <div className="rail-faint" style={{ fontFamily: 'var(--mantine-font-family-monospace)' }}>
          {(r.from ?? 'new branch').slice(0, 7)}..{r.to.slice(0, 7)}
        </div>
      )}
    </>
  );
};

const pushFailed = (e: ActivityEvent): ReactNode => (
  <>
    {summaryLine(e)}
    {typeof e.details?.error === 'string' && (
      <div className="rail-faint" style={{ color: 'var(--mantine-color-red-6)' }}>
        {e.details.error}
      </div>
    )}
  </>
);

/** Per-type rendering of events (`x.*` matches a prefix); anything not listed uses the default (summary + reference chips). */
export const activityRenderers: ActivityRendererRegistry = {
  'spec.section.*': sectionEdit,
  'standard.section.*': sectionEdit,
  'spec.status_changed': statusChange,
  'standard.status_changed': statusChange,
  'work_order.status_changed': statusChange,
  'work_order.*': workOrder,
  'feedback.*': feedback,
  'verification.recorded': verification,
  'git.pulled': pulled,
  'git.pushed': pushed,
  'git.push_failed': pushFailed,
};

import type { ReactNode } from 'react';
import { Tooltip } from '@mantine/core';
import { IconArrowRight } from '@tabler/icons-react';
import { RefChip } from '../refs/RefChip';
import { StatusGlyph } from '../refs/StatusGlyph';
import type { GitContext } from '@mandate/shared';
import { BranchLabel, PrBadge } from '../work-orders/parts';
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
    <Tooltip label={`${done}/${total} done`} openDelay={300}>
      <div className="activity-progress">
        <div className="embed-progress" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
          <span style={{ width: `${pct}%` }} />
        </div>
        <span className="rail-faint">{done}/{total}</span>
      </div>
    </Tooltip>
  );
}

/** The header already says what happened (eventTitle): bodies render only extra detail, never the summary again. */
const summaryLine = (_e: ActivityEvent) => null;

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

/** audit.*: refs[0] = the audit (or finding), refs[1] = the audited spec / standard; result, level, findings, severity, status, outcome. */
const audit = (e: ActivityEvent): ReactNode => {
  const d = e.details ?? {};
  const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
  const result = str(d.result) ?? str(d.outcome);
  const findings = typeof d.findings === 'number' ? d.findings : undefined;
  const s = d.status;
  return (
    <>
      {subject(e)}
      {e.refs[1] && (
        <div className="activity-status">
          <span className="rail-faint">of</span>
          <RefChip to={e.refs[1]} />
        </div>
      )}
      {summaryLine(e)}
      {str(d.sectionTitle) && <div className="rail-faint">Item: {str(d.sectionTitle)}</div>}
      {s ? (
        <div className="activity-status">
          <span>{s.from ? label(s.from) : 'none'}</span>
          <IconArrowRight size={12} />
          {s.to ? <StatusGlyph status={s.to === 'resolved' ? 'pass' : s.to} /> : null}
          <span>{s.to ? label(s.to) : 'none'}</span>
        </div>
      ) : null}
      <div className="activity-tags">
        {result && (
          <span className="cmdk-badge" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <StatusGlyph status={result === 'warn' ? 'partial' : result} size={12} />
            {label(result)}
          </span>
        )}
        {str(d.level) && <span className="cmdk-badge">{str(d.level)}</span>}
        {str(d.severity) && <span className="cmdk-badge">{str(d.severity)}</span>}
        {findings !== undefined && findings > 0 && <span className="cmdk-badge">{findings} finding{findings === 1 ? '' : 's'}</span>}
      </div>
    </>
  );
};

/** work_order.plan_set: the plan preview. */
const planSet = (e: ActivityEvent): ReactNode => (
  <>
    {subject(e)}
    {summaryLine(e)}
    {e.details?.preview && e.details.preview.length > 0 && <WordPreview ops={e.details.preview} />}
  </>
);

/** work_order.touched: the files recorded. */
const touched = (e: ActivityEvent): ReactNode => {
  const files = Array.isArray(e.details?.files) ? (e.details.files as string[]) : [];
  return (
    <>
      {subject(e)}
      {summaryLine(e)}
      {files.length > 0 && (
        <div className="activity-files">
          {files.slice(0, 5).map((f) => (
            <div key={f} className="rail-faint" style={{ fontFamily: 'var(--mantine-font-family-monospace)', fontSize: 11.5 }}>
              {f}
            </div>
          ))}
          {files.length > 5 && <div className="rail-faint">+{files.length - 5} more</div>}
        </div>
      )}
    </>
  );
};

/** work_order.git_updated: branch and PR per repo. */
const gitUpdated = (e: ActivityEvent): ReactNode => {
  const git = Array.isArray(e.details?.git) ? (e.details.git as GitContext[]) : [];
  return (
    <>
      {subject(e)}
      {summaryLine(e)}
      {git.map((g) => (
        <div key={g.repo} className="activity-tags">
          <span className="cmdk-badge">{g.repo}</span>
          {g.branch && <BranchLabel g={g} />}
          {g.pr && <PrBadge pr={g.pr} />}
        </div>
      ))}
    </>
  );
};

/** comment.*: the comment (refs[0]), what it is on (refs[1]), its text and the blocking marker. */
const comment = (e: ActivityEvent): ReactNode => (
  <>
    {e.refs[1] && <RefChip to={e.refs[1]} />}
    {summaryLine(e)}
    {e.details?.preview && e.details.preview.length > 0 && <WordPreview ops={e.details.preview} />}
    <div className="activity-tags">
      {e.details?.blocking === true && <span className="cmdk-badge" style={{ color: 'var(--mantine-color-red-6)' }}>blocking</span>}
      {e.type === 'comment.resolved' && <span className="cmdk-badge">resolved</span>}
      {e.type === 'comment.reopened' && <span className="cmdk-badge">reopened</span>}
      {e.refs[0] && <RefChip to={e.refs[0]} />}
    </div>
  </>
);

/** commit: the short hash only (the title is the commit message). */
const commit = (e: ActivityEvent): ReactNode => (
  <div className="activity-tags">
    <Tooltip label={e.commit} openDelay={300}>
      <span className="activity-hash mono">{e.commit.slice(0, 7)}</span>
    </Tooltip>
  </div>
);

/** approval.override: the reason given. */
const override = (e: ActivityEvent): ReactNode => (
  <>
    {subject(e)}
    {typeof e.details?.reason === 'string' && <div className="activity-reason">{e.details.reason}</div>}
  </>
);

/** question.*: the question (link), what it is about (other refs) and, once answered, the answer. */
const question = (e: ActivityEvent): ReactNode => {
  const answers = e.details?.answers;
  const text =
    answers && typeof answers === 'object'
      ? Object.values(answers as Record<string, unknown>)
          .map((v) => (Array.isArray(v) ? v.join(', ') : String(v)))
          .join(' · ')
      : undefined;
  return (
    <>
      <div className="activity-tags">
        {e.refs.map((r) => (
          <RefChip key={r} to={r} />
        ))}
        {e.details?.blocking === true && e.type === 'question.asked' && <span className="cmdk-badge">blocking</span>}
      </div>
      {text && <div className="activity-reason">Answer: {text}</div>}
      {e.type === 'question.cancelled' && typeof e.details?.reason === 'string' && <div className="activity-reason">{e.details.reason}</div>}
    </>
  );
};

/** Per-type rendering of events (`x.*` matches a prefix); anything not listed uses the default (summary + reference chips). */
export const activityRenderers: ActivityRendererRegistry = {
  'spec.section.*': sectionEdit,
  'standard.section.*': sectionEdit,
  'spec.status_changed': statusChange,
  'standard.status_changed': statusChange,
  'work_order.status_changed': statusChange,
  'work_order.plan_set': planSet,
  'work_order.touched': touched,
  'work_order.git_updated': gitUpdated,
  'comment.*': comment,
  'work_order.*': workOrder,
  'request.*': feedback,
  'feedback.*': feedback,
  'verification.recorded': verification,
  'audit.*': audit,
  'git.pulled': pulled,
  'git.pushed': pushed,
  'git.push_failed': pushFailed,
  commit,
  'approval.override': override,
  'question.*': question,
};

import { IconCircleCheckFilled, IconCircleDashed, IconCircleOff, IconPlayerPlayFilled } from '@tabler/icons-react';
import { Link } from 'react-router';
import { buildRef } from '@mandate/shared/refs';
import { currentStep, type PlanStep } from '@mandate/shared';
import { TimeAgo } from '../TimeAgo';
import { StepComments } from '../comments/CommentBadge';

const ICON = {
  pending: <IconCircleDashed size={15} aria-label="pending" />,
  in_progress: <IconPlayerPlayFilled size={15} color="var(--mantine-color-blue-6)" aria-label="in progress" />,
  done: <IconCircleCheckFilled size={15} color="var(--mantine-color-teal-6)" aria-label="done" />,
  skipped: <IconCircleOff size={15} color="var(--app-text-faint)" aria-label="skipped" />,
};

/** The tasks of a work order as a live checklist (read-only: agents set them with work_order_task_set). */
export function PlanSteps({ steps, spec, workOrder }: { steps: PlanStep[]; spec: string; workOrder?: string }) {
  if (!steps.length) return null;
  const cur = currentStep(steps);
  const finished = steps.filter((s) => s.status === 'done' || s.status === 'skipped').length;
  return (
    <section className="wo-steps" data-testid="wo-steps" aria-label="Tasks">
      <h3 className="wo-steps-title">
        Tasks <span className="faint small">{finished}/{steps.length}</span>
      </h3>
      <ol className="wo-steps-list">
        {steps.map((s) => (
          <li key={s.id} className={`wo-step is-${s.status}${cur?.id === s.id ? ' is-current' : ''}`} data-step={s.id} data-status={s.status} aria-current={cur?.id === s.id ? 'step' : undefined}>
            <span className="wo-step-icon">{ICON[s.status]}</span>
            <div className="wo-step-body">
              <div className="wo-step-text">
                <span className="mono faint small">{s.id}</span> <span className={s.status === 'skipped' ? 'wo-step-skipped' : undefined}>{s.text}</span>
              </div>
              {s.note && <div className="wo-step-note small faint">{s.note}</div>}
              {(s.sections?.length || s.proves?.length || s.codeRefs?.length) && (
                <div className="wo-step-chips">
                  {s.sections?.map((x) => (
                    <Link key={`s-${x}`} to={`/specs/${spec}#section-${x}`} className="wo-step-chip" title="Spec section this task implements">
                      {x}
                    </Link>
                  ))}
                  {s.proves?.map((x) => (
                    <Link key={`p-${x}`} to={`/specs/${spec}#section-${x}`} className="wo-step-chip is-proves" title="Acceptance criterion proved">
                      proves {x}
                    </Link>
                  ))}
                  {s.codeRefs?.map((c) => (
                    <span key={`${c.repo}:${c.path}`} className="wo-step-chip is-code mono">
                      {c.repo}:{c.path}
                    </span>
                  ))}
                </div>
              )}
            </div>
            {workOrder && <StepComments target={`${buildRef({ kind: 'work-orders', id: workOrder })}/tasks/${s.id}`} />}
            {s.status !== 'pending' && (
              <span className="wo-step-who small faint">
                {s.by} · <TimeAgo iso={s.updatedAt} />
              </span>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}

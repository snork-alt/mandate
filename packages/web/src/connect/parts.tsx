/** Form pieces shared by the New-project modals, the setup wizard and Settings (`np-*` styles). */
import { IconCheck } from '@tabler/icons-react';
import type { ReactNode } from 'react';

export function StepBar({ steps, step, onStep }: { steps: string[]; step: number; onStep?: (i: number) => void }) {
  return (
    <div className="np-steps" style={{ gridTemplateColumns: `repeat(${steps.length}, 1fr)` }} aria-label={`Step ${step + 1} of ${steps.length}`}>
      {steps.map((label, i) => (
        <div
          key={label}
          className="np-step"
          data-state={i < step ? 'done' : i === step ? 'current' : 'todo'}
          data-clickable={(onStep && i !== step) || undefined}
          onClick={onStep && i !== step ? () => onStep(i) : undefined}
        >
          <span className="np-step-bar" />
          <span className="np-step-label">
            {i < step && <IconCheck size={11} stroke={2.4} />}
            {label}
          </span>
        </div>
      ))}
    </div>
  );
}

export function Field({ label, hint, error, children, htmlFor, right }: { label: ReactNode; hint?: ReactNode; error?: string | null; children: ReactNode; htmlFor?: string; right?: ReactNode }) {
  return (
    <div className="np-field">
      <div className="np-label-row">
        <label className="np-label" htmlFor={htmlFor}>
          {label}
        </label>
        {right}
      </div>
      {children}
      {error ? <div className="np-error">{error}</div> : hint ? <div className="np-hint">{hint}</div> : null}
    </div>
  );
}

export function Notice({ icon, title, children, actions, tone = 'neutral', testId }: { icon: ReactNode; title: ReactNode; children?: ReactNode; actions?: ReactNode; tone?: 'neutral' | 'warn' | 'danger' | 'ok'; testId?: string }) {
  return (
    <div className="np-notice" data-tone={tone} data-testid={testId}>
      <div className="np-notice-icon">{icon}</div>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div className="np-notice-title">{title}</div>
        {children && <div className="np-notice-body">{children}</div>}
        {actions && <div className="np-notice-actions">{actions}</div>}
      </div>
    </div>
  );
}

export function SummaryRow({ icon, label, value, mono }: { icon: ReactNode; label: string; value: ReactNode; mono?: boolean }) {
  return (
    <div className="np-summary-row">
      <span className="np-summary-label">
        {icon}
        {label}
      </span>
      <span className={mono ? 'np-summary-value np-mono' : 'np-summary-value'}>{value}</span>
    </div>
  );
}

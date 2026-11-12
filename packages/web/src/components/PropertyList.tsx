import { Link } from 'react-router';
import type { ReactNode } from 'react';

/** Titled block in a properties sidebar. */
export function PropGroup({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  return (
    <div className="prop-group">
      <div className="prop-group-title">
        <span>{title}</span>
        {action}
      </div>
      {children}
    </div>
  );
}

/** Label / value row (Linear-style: plain value, subtle hover; optional link, e.g. to a filtered list). */
export function Prop({ label, children, to }: { label: string; children: ReactNode; to?: string }) {
  const body = (
    <>
      <span className="prop-label">{label}</span>
      <div className="prop-value">{children}</div>
    </>
  );
  return to ? (
    <Link to={to} className="prop-row prop-row-link">
      {body}
    </Link>
  ) : (
    <div className="prop-row">{body}</div>
  );
}

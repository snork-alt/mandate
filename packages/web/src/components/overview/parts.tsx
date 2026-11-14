/** Building blocks of the Overview: cards, empty states, times and capped lists ("Show all (N)"). */
import { useState, type ReactNode } from 'react';
import { Tooltip } from '@mantine/core';
import { absoluteTime, compactTime } from '../../lib/time';
import './overview.css';

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
export const pct = (a: number, b: number) => (b ? Math.round((a / b) * 100) : 0);

export function When({ iso, prefix = '', now }: { iso: string; prefix?: string; now?: number }) {
  return (
    <Tooltip label={absoluteTime(iso)} openDelay={300}>
      <time dateTime={iso} className="ov-time">
        {prefix}
        {compactTime(iso, now)}
      </time>
    </Tooltip>
  );
}

/** One card: title, count and a body (or its empty state). */
export function Card({ id, icon, title, count, action, children, wide, flat }: { id: string; icon: ReactNode; title: string; count?: number; action?: ReactNode; children: ReactNode; wide?: boolean; /** No border (inside a tab: no card in a card). */ flat?: boolean }) {
  return (
    <section className="ov-card" data-wide={wide || undefined} data-flat={flat || undefined} aria-labelledby={`ov-${id}`} data-testid={`ov-${id}`} id={`card-${id}`}>
      <header className="ov-card-head">
        <span className="ov-card-icon" aria-hidden>
          {icon}
        </span>
        <h2 id={`ov-${id}`} className="ov-card-title">
          {title}
        </h2>
        {count !== undefined && <span className="ov-card-count">{count}</span>}
        {action && <span className="ov-card-action">{action}</span>}
      </header>
      <div className="ov-card-body">{children}</div>
    </section>
  );
}

/** Count next to a tab label (Overview and Actions tabs); nothing when zero. */
export const TabCount = ({ n, tone }: { n: number | undefined; tone?: 'danger' }) => (n ? <span className="ov-tab-count" data-tone={tone}>{n}</span> : null);

/** Empty state inside a card: what would appear here and why it matters. */
export function Empty({ icon, title, children }: { icon?: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="ov-empty" data-testid="ov-empty">
      {icon && <span className="ov-empty-icon">{icon}</span>}
      <div>
        <div className="ov-empty-title">{title}</div>
        {children && <div className="ov-empty-text">{children}</div>}
      </div>
    </div>
  );
}

/** The first `cap` items, then a "Show all (N)" toggle. */
export function Capped<T>({ items, cap, render, className = 'ov-list' }: { items: T[]; cap: number; render: (item: T) => ReactNode; className?: string }) {
  const [all, setAll] = useState(false);
  const shown = all ? items : items.slice(0, cap);
  return (
    <>
      <ul className={className}>{shown.map(render)}</ul>
      {items.length > cap && (
        <button type="button" className="ov-show-all" onClick={() => setAll((a) => !a)} aria-expanded={all}>
          {all ? 'Show fewer' : `Show all (${items.length})`}
        </button>
      )}
    </>
  );
}

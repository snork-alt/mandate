import { Tooltip } from '@mantine/core';
import type { Priority } from '@mandate/shared';
import { PRIORITY_META } from '../../lib/specs';

const BARS: Record<Priority, number> = { p0: 3, p1: 3, p2: 2, p3: 1 };

/** Linear-style priority: bars for high/medium/low, an orange "!" square for urgent, dots for none. */
export function PriorityIcon({ priority, size = 14, withTooltip }: { priority?: Priority; size?: number; withTooltip?: boolean }) {
  const label = priority ? `${PRIORITY_META[priority].label} priority` : 'No priority';
  let svg;
  if (!priority) {
    svg = (
      <svg width={size} height={size} viewBox="0 0 14 14" role="img" aria-label={label}>
        {[2.5, 6.25, 10].map((x) => (
          <rect key={x} x={x} y="6.25" width="1.6" height="1.6" rx="0.5" fill="var(--app-text-faint)" />
        ))}
      </svg>
    );
  } else if (priority === 'p0') {
    svg = (
      <svg width={size} height={size} viewBox="0 0 14 14" role="img" aria-label={label}>
        <rect x="1" y="1" width="12" height="12" rx="3" fill="var(--mantine-color-orange-6)" />
        <path d="M7 3.8v4" stroke="#fff" strokeWidth="1.7" strokeLinecap="round" />
        <circle cx="7" cy="10.1" r="0.95" fill="#fff" />
      </svg>
    );
  } else {
    const on = BARS[priority];
    svg = (
      <svg width={size} height={size} viewBox="0 0 14 14" role="img" aria-label={label}>
        {[0, 1, 2].map((i) => (
          <rect
            key={i}
            x={1.5 + i * 4}
            y={9 - i * 3}
            width="3"
            height={3.5 + i * 3}
            rx="0.8"
            fill={i < on ? 'var(--app-text-muted)' : 'var(--app-border-strong)'}
          />
        ))}
      </svg>
    );
  }
  const wrapped = <span style={{ display: 'inline-flex', flexShrink: 0 }}>{svg}</span>;
  return withTooltip ? <Tooltip label={label}>{wrapped}</Tooltip> : wrapped;
}

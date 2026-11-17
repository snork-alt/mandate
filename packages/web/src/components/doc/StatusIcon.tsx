import { Tooltip } from '@mantine/core';
import type { SpecStatus } from '@mandate/shared';
import { SPEC_STATUS_META } from '../../lib/specs';

interface Props {
  status: SpecStatus;
  size?: number;
  /** Small marker for specs that were done and got reopened. */
  reopened?: boolean;
  withTooltip?: boolean;
}

/** Linear-style status glyph: ring = active, half = in progress, check = done, minus = archived. */
export function StatusIcon({ status, size = 14, reopened, withTooltip }: Props) {
  const { color, label } = SPEC_STATUS_META[status];
  const svg = (
    <span style={{ position: 'relative', display: 'inline-flex', flexShrink: 0 }}>
      <svg width={size} height={size} viewBox="0 0 14 14" fill="none" role="img" aria-label={label}>
        {status === 'active' && <circle cx="7" cy="7" r="5.5" stroke={color} strokeWidth="1.5" />}
        {status === 'in_progress' && (
          <>
            <circle cx="7" cy="7" r="5.5" stroke={color} strokeWidth="1.5" />
            <path d="M7 3.5 A3.5 3.5 0 0 1 7 10.5 Z" fill={color} />
          </>
        )}
        {status === 'done' && (
          <>
            <circle cx="7" cy="7" r="6.25" fill={color} />
            <path d="M4.4 7.2 6.2 9 9.7 5.2" stroke="#fff" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </>
        )}
        {status === 'archived' && (
          <>
            <circle cx="7" cy="7" r="6.25" fill={color} />
            <path d="M4.5 7h5" stroke="var(--app-bg)" strokeWidth="1.5" strokeLinecap="round" />
          </>
        )}
      </svg>
      {reopened && (
        <span
          aria-label="Reopened"
          style={{
            position: 'absolute',
            right: -2,
            top: -2,
            width: 6,
            height: 6,
            borderRadius: 3,
            background: 'var(--mantine-color-orange-6)',
            boxShadow: '0 0 0 1.5px var(--app-bg)',
          }}
        />
      )}
    </span>
  );
  if (!withTooltip) return svg;
  return <Tooltip label={reopened ? `${label} · reopened` : label}>{svg}</Tooltip>;
}

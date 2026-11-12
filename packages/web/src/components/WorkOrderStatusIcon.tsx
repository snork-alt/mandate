import type { WorkOrderStatus } from '@mandate/shared';

export const WORK_ORDER_STATUS_META: Record<WorkOrderStatus, { label: string; color: string }> = {
  pending: { label: 'Pending', color: 'var(--app-text-muted)' },
  in_progress: { label: 'In progress', color: 'var(--mantine-primary-color-filled)' },
  done: { label: 'Done', color: 'var(--mantine-color-teal-6)' },
  failed: { label: 'Failed', color: 'var(--mantine-color-red-6)' },
  cancelled: { label: 'Cancelled', color: 'var(--app-text-faint)' },
};

/** Display / grouping order (active work first). */
export const WORK_ORDER_STATUS_ORDER: WorkOrderStatus[] = ['in_progress', 'pending', 'failed', 'done', 'cancelled'];

/** Linear-style 14px work-order status glyph. */
export function WorkOrderStatusIcon({ status, size = 14 }: { status: WorkOrderStatus; size?: number }) {
  const color = WORK_ORDER_STATUS_META[status].color;
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" fill="none" aria-label={WORK_ORDER_STATUS_META[status].label} role="img">
      {status === 'pending' && (
        <circle cx="7" cy="7" r="5.5" stroke={color} strokeWidth="1.5" strokeDasharray="2.2 1.6" />
      )}
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
      {status === 'cancelled' && (
        <>
          <circle cx="7" cy="7" r="6.25" fill={color} />
          <path d="M4.5 7h5" stroke="var(--app-bg)" strokeWidth="1.5" strokeLinecap="round" />
        </>
      )}
      {status === 'failed' && (
        <>
          <circle cx="7" cy="7" r="6.25" fill={color} />
          <path d="M4.9 4.9 9.1 9.1 M9.1 4.9 4.9 9.1" stroke="#fff" strokeWidth="1.5" strokeLinecap="round" />
        </>
      )}
    </svg>
  );
}

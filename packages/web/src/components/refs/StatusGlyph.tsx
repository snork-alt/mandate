import { IconCircleCheck, IconCircleDashed, IconCircleOff, IconCircleX, IconProgress } from '@tabler/icons-react';

/** Generic status glyph for any document status (spec, work order, feedback, verification result). */
export function StatusGlyph({ status, size = 14 }: { status?: string; size?: number }) {
  if (!status) return null;
  const common = { size, stroke: 1.7, 'aria-label': status.replace(/_/g, ' ') };
  const s = status.toLowerCase();
  if (s === 'in_progress') return <IconProgress {...common} color="var(--mantine-primary-color-filled)" />;
  if (s === 'done' || s === 'accepted' || s === 'closed' || s === 'pass' || s === 'verified') return <IconCircleCheck {...common} color="var(--mantine-color-teal-6)" />;
  if (s === 'failed' || s === 'fail' || s === 'failing') return <IconCircleX {...common} color="var(--mantine-color-red-6)" />;
  if (s === 'cancelled' || s === 'archived' || s === 'skipped') return <IconCircleOff {...common} color="var(--app-text-faint)" />;
  return <IconCircleDashed {...common} color="var(--app-text-muted)" />;
}

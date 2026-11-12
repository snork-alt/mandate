import type { AutoPushStatus } from '@mandate/shared';
import { relativeTime } from './time';

/** One short line for the sidebar: "↑2 pending push", "Pushed 1 min ago", "Push failed", "No remote", ... */
export function pushSummary(ap: AutoPushStatus | undefined): { text: string; color: string } | null {
  if (!ap) return null;
  const muted = 'var(--app-text-muted)';
  switch (ap.state) {
    case 'no_remote':
      return { text: 'No remote', color: 'var(--app-text-faint)' };
    case 'reconnect':
      return { text: 'Reconnect GitHub', color: 'var(--mantine-color-orange-7)' };
    case 'refused':
      return { text: 'Push refused', color: 'var(--mantine-color-red-6)' };
    case 'error':
      return { text: ap.ahead ? `↑${ap.ahead} · push failed` : 'Push failed', color: 'var(--mantine-color-red-6)' };
    case 'pushing':
      return { text: 'Pushing…', color: muted };
    case 'disabled':
      return ap.ahead ? { text: `↑${ap.ahead} not pushed (auto-push off)`, color: muted } : null;
    default:
      if (ap.ahead) return { text: `↑${ap.ahead} pending push`, color: 'var(--mantine-color-yellow-7)' };
      return ap.lastPushAt ? { text: `Pushed ${relativeTime(ap.lastPushAt)}`, color: muted } : null;
  }
}

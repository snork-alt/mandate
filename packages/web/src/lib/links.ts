import { parseNodeUri, parseRef } from '@mandate/shared/refs';
import { IconAlertTriangle, IconArrowBigRightLines, IconArrowsLeftRight, IconArrowUpRight, IconCheckbox, IconComponents, IconGitFork, IconLock } from '@tabler/icons-react';

export const REL_META: Record<string, { label: string; icon: typeof IconLock; tone?: 'warn' }> = {
  depends_on: { label: 'Depends on', icon: IconLock },
  extends: { label: 'Extends', icon: IconArrowUpRight },
  relates_to: { label: 'Relates to', icon: IconArrowsLeftRight },
  conflicts_with: { label: 'Conflicts with', icon: IconAlertTriangle, tone: 'warn' },
  supersedes: { label: 'Supersedes', icon: IconArrowBigRightLines },
  follows: { label: 'Follows', icon: IconCheckbox },
  deviates_from: { label: 'Deviation from', icon: IconGitFork, tone: 'warn' },
  affects: { label: 'Affects', icon: IconComponents },
};

/** Inverse wording for backlinks ("Linked from … depends on this"). */
export const REL_BACK: Record<string, string> = {
  depends_on: 'depends on this',
  extends: 'extends this',
  relates_to: 'relates to this',
  conflicts_with: 'conflicts with this',
  supersedes: 'supersedes this',
  follows: 'follows this',
  deviates_from: 'deviates from this',
  affects: 'affects this',
};

/** UI path of a reference: `/<kind>/<id>[?version=<sha>][#section-<sid>]`. */
export function sectionHref(uri: string): string {
  const r = parseRef(uri);
  if (!r) return auditHref(uri) ?? '#';
  const q = [r.commit ? `version=${r.commit}&view=version` : '', r.lines ? `lines=${r.lines.start}-${r.lines.end}` : ''].filter(Boolean).join('&');
  return `/${r.kind === 'feedback' ? 'requests' : r.kind}/${r.id}${q ? `?${q}` : ''}${r.sectionId ? `#section-${r.sectionId}` : ''}`;
}

/** UI path of an audit finding (`/audits/<id>#finding-<fid>`); null for other refs (audits are documents: see sectionHref). */
export function auditHref(uri: string): string | null {
  const r = parseNodeUri(uri.replace(/^@mandate:/, ''));
  return r?.kind === 'findings' ? `/audits/${r.audit}#finding-${r.id}` : null;
}

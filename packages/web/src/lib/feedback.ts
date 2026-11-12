import { IconBug, IconBulb, IconGitMerge, IconHelpCircle, IconQuestionMark } from '@tabler/icons-react';
import type { Feedback, FeedbackKind, FeedbackResolution, FeedbackStatus } from '@mandate/shared';
import { buildRef, mentionOf, parseRef, refMention } from '@mandate/shared/refs';

/** The same reference pinned to a commit. */
const versioned = (uri: string, commit: string) => {
  const r = parseRef(uri);
  return r ? buildRef({ ...r, commit }) : uri;
};

export const FEEDBACK_KIND_META: Record<FeedbackKind, { label: string; icon: typeof IconBug; color: string }> = {
  ambiguity: { label: 'Ambiguity', icon: IconHelpCircle, color: 'var(--mantine-color-yellow-7)' },
  conflict: { label: 'Conflict', icon: IconGitMerge, color: 'var(--mantine-color-orange-7)' },
  bug: { label: 'Bug', icon: IconBug, color: 'var(--mantine-color-red-6)' },
  improvement: { label: 'Improvement', icon: IconBulb, color: 'var(--mantine-color-lilac-6)' },
  question: { label: 'Question', icon: IconQuestionMark, color: 'var(--mantine-color-blue-6)' },
};

export const FEEDBACK_STATUS_META: Record<FeedbackStatus, { label: string }> = {
  open: { label: 'Open' },
  accepted: { label: 'Accepted' },
  closed: { label: 'Closed' },
};
export const FEEDBACK_STATUS_ORDER: FeedbackStatus[] = ['open', 'accepted', 'closed'];

export const RESOLUTION_META: Record<FeedbackResolution, { label: string; glyph: string }> = {
  applied: { label: 'Applied', glyph: '✓' },
  rejected: { label: 'Rejected', glyph: '✕' },
  duplicate: { label: 'Duplicate', glyph: '⧉' },
};

export type FeedbackSort = 'created-desc' | 'created-asc' | 'updated' | 'closed' | 'kind';
export const FEEDBACK_SORTS: { value: FeedbackSort; label: string }[] = [
  { value: 'created-desc', label: 'Created (newest)' },
  { value: 'created-asc', label: 'Created (oldest)' },
  { value: 'updated', label: 'Updated' },
  { value: 'closed', label: 'Closed date' },
  { value: 'kind', label: 'Kind' },
];

export function sortFeedback(items: Feedback[], sort: FeedbackSort): Feedback[] {
  const by: Record<FeedbackSort, (a: Feedback, b: Feedback) => number> = {
    'created-desc': (a, b) => b.createdAt.localeCompare(a.createdAt),
    'created-asc': (a, b) => a.createdAt.localeCompare(b.createdAt),
    updated: (a, b) => b.updatedAt.localeCompare(a.updatedAt),
    // Closed items newest-closed first; open ones after, newest first.
    closed: (a, b) => (b.closedAt ?? '').localeCompare(a.closedAt ?? '') || b.createdAt.localeCompare(a.createdAt),
    kind: (a, b) => a.kind.localeCompare(b.kind) || b.createdAt.localeCompare(a.createdAt),
  };
  return [...items].sort(by[sort]);
}

export const firstLine = (body: string) => body.split('\n').find((l) => l.trim())?.replace(/[`*]/g, '').trim() ?? '';

/** "login-sso › callback" for a target reference. */
export function targetLabel(target: string, titles?: Map<string, string>): { kind: 'specs' | 'standards'; id: string; title: string; label: string; href: string } {
  const r = parseRef(target);
  if (!r) return { kind: 'specs', id: target, title: target, label: target, href: '#' };
  const title = titles?.get(`${r.kind}:${r.id}`) ?? r.id;
  return {
    kind: r.kind as 'specs' | 'standards',
    id: r.id,
    title,
    label: r.sectionId ? `${title} › ${r.sectionId}` : title,
    href: `/${r.kind}/${r.id}${r.sectionId ? `#section-${r.sectionId}` : ''}`,
  };
}

/** Agent-ready summary of a feedback item. */
export function feedbackMarkdown(f: Feedback): string {
  const lines = [
    `# Feedback ${f.id} · ${f.kind} · ${f.status}${f.resolution ? ` (${f.resolution})` : ''}`,
    refMention({ kind: 'feedback', id: f.id }),
    '',
    `Targets: ${f.targets.map(mentionOf).join(', ')}`,
  ];
  if (f.quote) lines.push('', ...f.quote.split('\n').map((l) => `> ${l}`));
  lines.push('', f.body);
  if (f.resolutionNote) lines.push('', `Resolution note: ${f.resolutionNote}`);
  if (f.duplicateOf) lines.push('', `Duplicate of ${refMention({ kind: 'feedback', id: f.duplicateOf })}`);
  if (f.changes.length) {
    lines.push('', 'Resulting changes:');
    for (const c of f.changes) lines.push(`- ${c.action} ${mentionOf(versioned(c.uri, c.commit))}${c.sections.length ? ` (sections: ${c.sections.map((s) => `${s.id} ${s.action}`).join(', ')})` : ''}`);
  }
  return `${lines.join('\n')}\n`;
}

import { useEffect, useState } from 'react';
import type { Claim, Priority, Spec, SpecStatus, WorkOrderKind } from '@mandate/shared';

export const SPEC_STATUS_META: Record<SpecStatus, { label: string; color: string }> = {
  active: { label: 'Active', color: 'var(--app-text-muted)' },
  in_progress: { label: 'In progress', color: 'var(--mantine-color-lilac-6)' },
  done: { label: 'Done', color: 'var(--mantine-color-teal-6)' },
  archived: { label: 'Archived', color: 'var(--app-text-faint)' },
};
/** Display / grouping order: active work first. */
export const SPEC_STATUS_ORDER: SpecStatus[] = ['in_progress', 'active', 'done', 'archived'];

export const PRIORITY_META: Record<Priority, { label: string; short: string }> = {
  p0: { label: 'Urgent', short: 'P0' },
  p1: { label: 'High', short: 'P1' },
  p2: { label: 'Medium', short: 'P2' },
  p3: { label: 'Low', short: 'P3' },
};
export const PRIORITY_ORDER: (Priority | 'none')[] = ['p0', 'p1', 'p2', 'p3', 'none'];
export const priorityRank = (p?: Priority) => PRIORITY_ORDER.indexOf(p ?? 'none');

/** A claim whose heartbeat is older than this is stale and may be taken over. */
export const STALE_AFTER_MS = 30 * 60_000;

export function isStale(claim: Claim, now = Date.now()): boolean {
  const t = Date.parse(claim.heartbeatAt);
  return Number.isNaN(t) || now - t > STALE_AFTER_MS;
}

/** Was marked done before (implementedCommit is kept) but is active again. */
export function isReopened(spec: Pick<Spec, 'status' | 'implementedCommit'>): boolean {
  return !!spec.implementedCommit && spec.status !== 'done' && spec.status !== 'archived';
}

/** Dependencies that are not done yet (unknown ids count as blocking). */
export function blockingDeps(spec: Spec, byId: Map<string, Spec>): string[] {
  return (spec.dependsOn ?? []).filter((id) => byId.get(id)?.status !== 'done');
}

/** "claude-code@matteo-mbp" -> "CC"; "codex@build-02" -> "CO". */
export function initials(agent: string): string {
  const name = agent.split('@')[0] ?? agent;
  const parts = name.split(/[-_.\s]+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0]![0]! + parts[1]![0]!).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

/** Current time, re-rendering every `intervalMs` (for relative times and staleness). */
export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

/** Strip the conventional `spec(<id>): ` / `spec: ` prefix from commit subjects. */
export function shortSubject(subject: string): string {
  return subject.replace(/^[a-z]+(\([^)]*\))?:\s*/, '');
}

/** "billing" -> "Billing", short acronyms like "ui" / "api" -> "UI" / "API". */
export function categoryLabel(category: string): string {
  return category.length <= 3 ? category.toUpperCase() : category.charAt(0).toUpperCase() + category.slice(1);
}

/** Frontmatter fields of each document kind (used to show a past version's properties). */
export const FRONTMATTER_FIELDS = {
  specs: ['title', 'summary', 'tldr', 'category', 'status', 'priority', 'tags', 'owner', 'repo', 'implementedCommit', 'exemptFrom'],
  standards: ['title', 'summary', 'tldr', 'status', 'effectiveFrom', 'supersededBy', 'tags', 'owner', 'appliesTo'],
  components: ['title', 'summary', 'tldr', 'kind', 'owns', 'tags', 'owner', 'status'],
  'work-orders': ['title', 'status', 'priority', 'note', 'claim', 'claims', 'dependencies', 'fastPath', 'touched', 'git', 'completedAt', 'updatedAt'],
  audits: ['title', 'summary', 'target', 'commit', 'code', 'auditor', 'status', 'startedAt', 'completedAt', 'abandonedAt', 'abandonReason', 'counts'],
} as const;

/** The entity as of a past version: its frontmatter fields replaced by that version's values. */
export function withFrontmatter<T extends object>(entity: T, kind: keyof typeof FRONTMATTER_FIELDS, frontmatter: Record<string, unknown>): T {
  const out = { ...entity } as Record<string, unknown>;
  for (const k of FRONTMATTER_FIELDS[kind]) out[k] = frontmatter[k];
  return out as T;
}

export const KIND_LABEL: Record<WorkOrderKind, string> = {
  implement: 'Implement',
  update: 'Update',
  review: 'Review',
  verify: 'Verify',
  fix: 'Fix',
};

/** A document as of a past version (used to view deleted documents in track-changes mode). */
export function deletedDoc<T>(id: string, version: { frontmatter: unknown; sections: unknown[] }, date?: string): T {
  const fm = version.frontmatter as Record<string, unknown>;
  return {
    tags: [],
    dependsOn: [],
    standards: [],
    appliesTo: [],
    status: 'archived',
    ...fm,
    id,
    sections: version.sections,
    createdAt: date ?? new Date(0).toISOString(),
    updatedAt: date ?? new Date(0).toISOString(),
    updatedBy: null,
    revisions: 0,
    versionCount: 0,
    lastCommit: null,
    deleted: true,
  } as T;
}

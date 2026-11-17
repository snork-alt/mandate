/**
 * Spec maturity: ONE derived answer to "how far is this feature really?" (the stored `status` stays as is).
 * Ladder: draft → specified → in progress (x/y sections) → implemented. The audit is a separate indicator (see auditIndicator), not a step.
 * Overlays (take precedence visually; the step is still shown): failing, outdated, blocked, archived.
 */
import type { LastAudit } from './audits.js';

export const MATURITY_STEPS = ['draft', 'specified', 'in_progress', 'implemented'] as const;
export type MaturityStep = (typeof MATURITY_STEPS)[number];
export const MATURITY_OVERLAYS = ['archived', 'failing', 'outdated', 'blocked'] as const;
export type MaturityOverlayKind = (typeof MATURITY_OVERLAYS)[number];
export const MATURITY_LABELS: Record<MaturityStep, string> = {
  draft: 'Draft',
  specified: 'Specified',
  in_progress: 'In progress',
  implemented: 'Implemented',
};

export interface MaturityOverlay {
  kind: MaturityOverlayKind;
  /** Why (one sentence). */
  reason: string;
  /** References to follow (criteria, findings, audit, dependency targets). */
  refs: string[];
}

export interface SpecMaturity {
  step: MaturityStep;
  /** 1..4. */
  stepIndex: number;
  /** "Implemented", "In progress · 3/5". */
  label: string;
  /** Badge tone: neutral (draft / specified), lilac (in progress), blue (implemented); red / orange when an overlay applies. */
  tone: 'neutral' | 'lilac' | 'blue' | 'green' | 'red' | 'orange' | 'grey';
  /** Implementable sections (non-archived, not criteria) implemented / total. */
  sections: { implemented: number; total: number; inProgress: number };
  /** Gating criteria (must, in force): verified (incl. waived) / total, with failing, stale and unverified counts. */
  criteria: { total: number; verified: number; waived: number; failing: number; stale: number; unverified: number };
  audit: LastAudit | null;
  /** Every overlay that applies, most important first (archived, failing, outdated, blocked). */
  overlays: MaturityOverlay[];
  storedStatus: string;
}

/** Overlay tone: failing red, outdated / blocked orange, archived grey. */
export const OVERLAY_TONE: Record<MaturityOverlayKind, SpecMaturity['tone']> = { archived: 'grey', failing: 'red', outdated: 'orange', blocked: 'orange' };
export const STEP_TONE: Record<MaturityStep, SpecMaturity['tone']> = { draft: 'neutral', specified: 'neutral', in_progress: 'lilac', implemented: 'blue' };

/** The audit indicator next to the maturity badge: never audited / passed / findings (red when must, else orange) / outdated (spec or touched code changed since). */
export type AuditIndicatorState = 'never' | 'passed' | 'findings' | 'outdated';
export function auditIndicator(a: Pick<LastAudit, 'stale' | 'openFindings' | 'openMust' | 'openShould' | 'result'> | null | undefined): AuditIndicatorState {
  if (!a) return 'never';
  if (a.openFindings > 0) return 'findings';
  return a.stale ? 'outdated' : 'passed';
}

/**
 * Spec maturity: ONE derived answer to "how far is this feature really?" (the stored `status` stays as is).
 * Ladder: draft → specified → in progress (x/y sections) → implemented → verified → audited.
 * Overlays (take precedence visually; the step is still shown): failing, drifted, blocked, stale, archived.
 */
import type { LastAudit } from './audits.js';

export const MATURITY_STEPS = ['draft', 'specified', 'in_progress', 'implemented', 'verified', 'audited'] as const;
export type MaturityStep = (typeof MATURITY_STEPS)[number];
export const MATURITY_OVERLAYS = ['archived', 'failing', 'drifted', 'blocked', 'stale'] as const;
export type MaturityOverlayKind = (typeof MATURITY_OVERLAYS)[number];
export const MATURITY_LABELS: Record<MaturityStep, string> = {
  draft: 'Draft',
  specified: 'Specified',
  in_progress: 'In progress',
  implemented: 'Implemented',
  verified: 'Verified',
  audited: 'Audited',
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
  /** 1..6. */
  stepIndex: number;
  /** "Verified", "In progress · 3/5". */
  label: string;
  /** Badge tone: neutral (draft / specified), lilac (in progress), blue (implemented), green (verified / audited); red / orange when an overlay applies. */
  tone: 'neutral' | 'lilac' | 'blue' | 'green' | 'red' | 'orange' | 'grey';
  /** Implementable sections (non-archived, not criteria) implemented / total. */
  sections: { implemented: number; total: number; inProgress: number };
  /** Gating criteria (must, in force): verified (incl. waived) / total, with failing, stale and unverified counts. */
  criteria: { total: number; verified: number; waived: number; failing: number; stale: number; unverified: number };
  audit: LastAudit | null;
  /** Every overlay that applies, most important first (archived, failing, drifted, blocked, stale). */
  overlays: MaturityOverlay[];
  storedStatus: string;
}

/** Overlay tone: failing / drifted red, blocked / stale orange, archived grey. */
export const OVERLAY_TONE: Record<MaturityOverlayKind, SpecMaturity['tone']> = { archived: 'grey', failing: 'red', drifted: 'red', blocked: 'orange', stale: 'orange' };
export const STEP_TONE: Record<MaturityStep, SpecMaturity['tone']> = { draft: 'neutral', specified: 'neutral', in_progress: 'lilac', implemented: 'blue', verified: 'green', audited: 'green' };

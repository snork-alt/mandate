/**
 * Live activity feed: events derived from commits (trailers + structured diffs), pushed to MCP clients as
 * `notifications/mandate/activity` and listed (git-backed) by the `activity_list` tool.
 */
import { z } from 'zod';
import { parseNodeUri } from './refs.js';

export const ACTIVITY_NOTIFICATION = 'notifications/mandate/activity';

export const ACTIVITY_TYPES = [
  'spec.created',
  'spec.updated',
  'spec.status_changed',
  'spec.deleted',
  'spec.section.inserted',
  'spec.section.updated',
  'spec.section.moved',
  'spec.section.deleted',
  'standard.created',
  'standard.updated',
  'standard.deleted',
  'standard.section.inserted',
  'standard.section.updated',
  'standard.section.moved',
  'standard.section.deleted',
  'work_order.created',
  'work_order.updated',
  'work_order.claimed',
  'work_order.heartbeat',
  'work_order.released',
  'work_order.section_done',
  'work_order.completed',
  'work_order.status_changed',
  'work_order.deleted',
  'feedback.created',
  'feedback.updated',
  'feedback.closed',
  'feedback.deleted',
  'verification.recorded',
  'git.pulled',
  'git.pushed',
  'git.push_failed',
  'commit',
] as const;
export type ActivityType = (typeof ACTIVITY_TYPES)[number];

/** One word-diff op for the mini preview (`=` kept, `+` inserted, `-` deleted). */
export interface PreviewOp {
  op: 'equal' | 'insert' | 'delete';
  text: string;
}

export interface ActivityEvent {
  /** `<commit sha>:<n>` (a commit can produce several events). */
  id: string;
  /** Full sha of the commit (`mandate://commits/<sha>`; for `git.pulled`, the new HEAD). */
  commit: string;
  type: ActivityType;
  /** Commit time (ISO). */
  at: string;
  agent?: string;
  branch?: string;
  /** Name of the agent key that made the write (`Agent-Key:` trailer); never the key itself. */
  source?: string;
  /** The main subject first (doc, section, work order, ...), then related references. */
  refs: string[];
  summary: string;
  /** Repeated liveness signal: clients group these. */
  heartbeat?: boolean;
  details?: {
    /** Section edits: a short word diff of the body. */
    preview?: PreviewOp[];
    status?: { from: string | null; to: string | null };
    /** Work orders: sections done / total. */
    progress?: { done: number; total: number };
    kind?: string;
    resolution?: string;
    result?: 'pass' | 'fail' | 'skipped';
    title?: string;
    sectionTitle?: string;
    fields?: string[];
    /** git.pulled: commits brought in; git.pushed: commits sent. */
    commits?: string[];
    /** git.pushed: remote branch before / after. */
    range?: { from: string | null; to: string };
    /** git.push_failed: reason (never secrets). */
    error?: string;
    subject?: string;
    [k: string]: unknown;
  };
}

const refFilter = z
  .string()
  .trim()
  .min(1)
  .max(400)
  .refine((v) => parseNodeUri(v) !== null, 'expected a mandate:// reference');
/** `spec.*`, `work_order.section_done`, `*.created` ... */
const typePattern = z
  .string()
  .trim()
  .max(60)
  .regex(/^(\*|[a-z_]+)(\.(\*|[a-z_]+)){0,2}$/, 'expected an event type or pattern such as spec.* or work_order.section_done');
const when = z.union([z.string().regex(/^[0-9a-f]{4,40}$/, 'commit sha'), z.string().regex(/^\d{4}-\d{2}-\d{2}([T ][\d:.]+(Z|[+-]\d{2}:?\d{2})?)?$/, 'ISO date')]);

export const activityListInputSchema = z
  .object({
    /** Events after this commit (exclusive) or ISO date: reconnect backfill. */
    since: when.optional(),
    /** Events up to this commit (inclusive) or ISO date. */
    until: when.optional(),
    types: z.array(typePattern).min(1).max(20).optional(),
    agent: z.string().trim().min(1).max(200).optional(),
    /** Events touching this reference; a document matches its sections, work orders and feedback on it. */
    ref: refFilter.optional(),
    includeHeartbeats: z.boolean().default(true),
    limit: z.number().int().min(1).max(500).default(50),
    cursor: z.string().max(20).regex(/^\d+$/, 'invalid cursor').optional(),
  })
  .strict();
export type ActivityListInput = z.input<typeof activityListInputSchema>;

export const activitySubscribeInputSchema = z
  .object({
    /** Only these types / patterns (default: all). */
    types: z.array(typePattern).min(1).max(20).optional(),
    ref: refFilter.optional(),
    agent: z.string().trim().min(1).max(200).optional(),
    /** false: stop notifications for this session. */
    enabled: z.boolean().default(true),
  })
  .strict();
export type ActivitySubscribeInput = z.input<typeof activitySubscribeInputSchema>;

export interface ActivityListResponse {
  events: ActivityEvent[];
  total: number;
  nextCursor: string | null;
  /** HEAD when listed (pass as `since` on reconnect). */
  head: string | null;
}

/** Does an event type match a pattern (`spec.*`, `*.created`, exact)? */
export function activityTypeMatches(type: string, pattern: string): boolean {
  if (pattern === '*' || pattern === type) return true;
  const t = type.split('.');
  const p = pattern.split('.');
  if (p[p.length - 1] === '*' && p.length - 1 <= t.length) return p.slice(0, -1).every((x, i) => x === '*' || x === t[i]);
  return p.length === t.length && p.every((x, i) => x === '*' || x === t[i]);
}

/** Does an event touch `ref`? A document matches its sections (and excerpts); refs compare without version / lines. */
export function activityTouches(event: Pick<ActivityEvent, 'refs'>, ref: string): boolean {
  const norm = (u: string) => u.trim().replace(/^@mandate:/, '').replace(/@[0-9a-f]{4,40}/, '').replace(/#L.*$/, '');
  const want = norm(ref);
  return event.refs.some((r) => {
    const n = norm(r);
    return n === want || n.startsWith(`${want}/sections/`);
  });
}

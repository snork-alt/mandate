/** Structured tool errors: every failure becomes `{ code, message, path, hint }` (an MCP tool error, `isError: true`). */
import { ZodError } from 'zod';
import { CypherError } from '../index/cypher/index.js';
import { GraphError } from '../index/resolve.js';
import { ReadError } from '../storage/read.js';

export interface ToolErrorBody {
  code: string;
  message: string;
  /** Dotted path of the offending input field ('' = the whole input). */
  path: string;
  hint?: string;
  /** All schema issues (validation errors only). */
  issues?: { path: string; message: string; code?: string }[];
  /** For `not_found`: what was missing (`node`, `document`, `section`, `commit`); other codes may add fields. */
  detail?: { kind: string; [k: string]: unknown };
}

/** Service codes for missing things; every tool reports them as `not_found` with `detail.kind`. */
const MISSING: Record<string, string> = { not_found: 'document', unknown_node: 'node', unknown_section: 'section', unknown_commit: 'commit' };

/** One code for "missing" across all tools (index and storage services use their own codes). */
export function normalizeMissing<T extends { code: string; detail?: { kind: string } }>(e: T): T {
  const kind = MISSING[e.code];
  return kind ? { ...e, code: 'not_found', detail: e.detail ?? { kind } } : e;
}

/** Throw from a tool handler for a domain error with a code and a hint. */
export class ToolError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly hint?: string,
    readonly path = '',
    readonly detail?: { kind: string; [k: string]: unknown },
  ) {
    super(message);
    this.name = 'ToolError';
  }
}

const pathOf = (p: readonly PropertyKey[]) => p.map(String).join('.');

function zodError(e: ZodError, allowed?: string[]): ToolErrorBody {
  const issues = e.issues.map((i) => {
    let path = pathOf(i.path);
    let message = i.message;
    if (i.code === 'unrecognized_keys') {
      const keys = (i as { keys?: string[] }).keys ?? [];
      path = pathOf([...i.path, ...(keys.length === 1 ? [keys[0]!] : [])]);
      message = `unknown key${keys.length > 1 ? 's' : ''}: ${keys.join(', ')}`;
    }
    return { path, message, code: i.code };
  });
  const first = issues[0] ?? { path: '', message: 'invalid input' };
  const unknown = e.issues.find((i) => i.code === 'unrecognized_keys');
  const hint = unknown && allowed?.length
    ? `allowed keys: ${allowed.join(', ')}`
    : issues.length > 1
      ? `${issues.length} problems; see issues`
      : 'fix the input and retry; the tool input schema lists every field';
  return {
    code: 'invalid_input',
    message: first.path ? `${first.path}: ${first.message}` : first.message,
    path: first.path,
    hint,
    issues,
  };
}

/** Map anything a service function throws to a structured error (never rethrows). */
export function toToolError(e: unknown, allowedKeys?: string[]): ToolErrorBody {
  return normalizeMissing(rawToolError(e, allowedKeys));
}

function rawToolError(e: unknown, allowedKeys?: string[]): ToolErrorBody {
  if (e instanceof ZodError) return zodError(e, allowedKeys);
  if (e instanceof ToolError) return { code: e.code, message: e.message, path: e.path, ...(e.hint ? { hint: e.hint } : {}), ...(e.detail ? { detail: e.detail } : {}) };
  if (e instanceof ReadError) return { code: e.code, message: e.message, path: e.path ?? '', ...(e.hint ? { hint: e.hint } : {}) };
  if (e instanceof GraphError) return { code: e.code, message: e.message, path: '', ...(e.hint ? { hint: e.hint } : {}) };
  if (e instanceof CypherError) {
    return {
      code: e.code,
      message: e.message,
      path: 'query',
      hint: e.hint ?? 'see graph_schema for labels, relationship types, functions and examples',
    };
  }
  const err = e as { name?: string; message?: string; statusCode?: number; code?: unknown; issues?: unknown };
  const message = typeof err?.message === 'string' ? err.message : String(e);
  if (err?.name === 'DocError') return { code: 'invalid_document', message, path: '' };
  const status = typeof err?.statusCode === 'number' ? err.statusCode : 500;
  if (status === 404) return { code: 'not_found', message, path: '', hint: 'list or search to find valid ids and references' };
  if (status === 409) return { code: typeof err.code === 'string' ? err.code : 'conflict', message, path: '' };
  if (status >= 400 && status < 500) return { code: typeof err.code === 'string' ? err.code : 'invalid_request', message, path: '' };
  return { code: 'internal', message, path: '', hint: 'unexpected server error; retry, or report it with the input' };
}

/* ---------------------------------------------------------------- write tools */

const WRITE_HINTS: Record<string, string> = {
  transition_not_allowed: 'see the transition table in the tool description; reopen or go through the intermediate status',
  done_gate: 'verify (verification_record) or waive the listed criteria, unblock sections and finish open implement/update work orders, then retry',
  claim_conflict: 'another agent holds a fresh claim; pick another work order (work_order_next) or wait',
  stale_claim: 'the holder stopped heartbeating; work_order_claim takes the stale claim over',
  cycle: 'the link would close a dependency cycle; link in the other direction or drop a link',
  superseded_target: 'link to the successor section instead (the message names it)',
  feedback_closed: 'closed feedback is immutable; file a new item (relatedTo the closed one)',
  append_only: 'verification results are append-only; record a new result instead',
  archive_only: 'documents are never deleted; archive them (spec_archive / section archive)',
  section_referenced: 'the section is referenced; archive it instead of removing it',
  id_reused: 'ids are never reused; pick a new id',
  criteria_shrink: 'pass addresses: [an accepted feedback item] to remove criteria from a done or claimed spec',
  stale_version: 're-read the document and retry with its current reference',
  validation: 'fix the input (see message) and retry',
};

/**
 * Map storage-service errors of a write to the codes agents act on: transition_not_allowed, done_gate,
 * claim_conflict, stale_claim, cycle, superseded_target, feedback_closed, append_only, not_found, validation, ...
 */
export function toWriteError(e: unknown, allowedKeys?: string[]): ToolErrorBody {
  const base = toToolError(e, allowedKeys);
  // Schema-level problems found while running (service schemas, cross-field rules): domain validation.
  if (base.code === 'invalid_input') return { ...base, code: 'validation' };
  if (base.code === 'not_found' || base.code === 'agent_required') return base;
  const err = e as { code?: unknown; details?: unknown; message?: string };
  const msg = base.message;
  let code = base.code;
  let detail: ToolErrorBody['detail'] = base.detail;
  if (code === 'invalid_transition' || / -> \S+ is not allowed/.test(msg) || /is (done|cancelled); done and cancelled are final/.test(msg) || /^work order \S+ is (done|cancelled|failed)$/.test(msg)) code = 'transition_not_allowed';
  else if (code === 'claimed') code = 'claim_conflict';
  else if (code === 'invalid_links') {
    const details = Array.isArray(err.details) ? (err.details as string[]) : [msg];
    code = details.some((d) => /cycle/i.test(d)) ? 'cycle' : details.some((d) => /supersed/i.test(d)) ? 'superseded_target' : 'validation';
    detail = { kind: 'links', problems: details };
  } else if (code === 'done_gate') detail = { kind: 'gate', failures: (err.details as unknown[]) ?? [] };
  else if (code === 'section_referenced' || code === 'criteria_shrink') detail = { kind: code, problems: err.details ?? [] };
  else if (code === 'invalid_request' || code === 'invalid_document' || code === 'conflict' || code === 'unknown_section') code = code === 'unknown_section' ? 'not_found' : 'validation';
  const message = msg.replace(/^(invalid_transition|claimed|stale_claim|invalid_links|done_gate|feedback_closed|append_only|archive_only|section_referenced|id_reused|criteria_shrink): /, '');
  return { ...base, code, message, ...(detail ? { detail } : {}), hint: base.hint && base.code === code ? base.hint : (WRITE_HINTS[code] ?? base.hint) };
}

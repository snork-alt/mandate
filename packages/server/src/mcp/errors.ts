/** Structured tool errors: every failure becomes `{ code, message, path, hint }` (an MCP tool error, `isError: true`). */
import { ZodError } from 'zod';
import { ERROR_ACTIONS } from '@mandate/shared';
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
  // Ids are assigned by Mandate: a create given an id gets a clear message, not just "unknown key".
  const idIssue = issues.find((i) => i.code === 'unrecognized_keys' && /(^|\.)id$/.test(i.path) && i.message === 'unknown key: id');
  if (idIssue && idIssue === issues[0]) {
    const message = `${idIssue.path}: ids are assigned by Mandate; omit id`;
    return { code: 'invalid_input', message, path: idIssue.path, hint: 'ids are assigned by Mandate; omit id and use the id / ref the create result returns', issues: issues.map((i) => (i === idIssue ? { ...i, message: 'ids are assigned by Mandate; omit id' } : i)) };
  }
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
  return withHint(normalizeMissing(rawToolError(e, allowedKeys)));
}

/** Every structured error carries a hint: its own, else the recommended action from the lifecycle registry. */
export const withHint = (b: ToolErrorBody): ToolErrorBody => (b.hint || !ERROR_ACTIONS[b.code] ? b : { ...b, hint: ERROR_ACTIONS[b.code] });

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
  // Domain errors with a structured detail (e.g. audit_incomplete lists the missing items).
  const d = (e as { detail?: unknown })?.detail;
  if (status >= 400 && status < 500 && status !== 404 && typeof err.code === 'string' && d && typeof d === 'object' && typeof (d as { kind?: unknown }).kind === 'string') {
    const h = (e as { hint?: unknown }).hint;
    return { code: err.code, message, path: '', detail: d as ToolErrorBody['detail'], ...(typeof h === 'string' && h ? { hint: h } : {}) };
  }
  if (status === 404) return { code: 'not_found', message, path: '', hint: 'list or search to find valid ids and references' };
  if (status === 409) return { code: typeof err.code === 'string' ? err.code : 'conflict', message, path: '' };
  if (status >= 400 && status < 500) return { code: typeof err.code === 'string' ? err.code : 'invalid_request', message, path: '' };
  return { code: 'internal', message, path: '', hint: 'unexpected server error; retry, or report it with the input' };
}

/* ---------------------------------------------------------------- write tools */

/** Raw service codes -> the codes agents act on (cycle / superseded_target are refined from invalid_links). */
export const WRITE_CODE_MAP: Record<string, string> = {
  invalid_transition: 'transition_not_allowed',
  claimed: 'claim_conflict',
  invalid_links: 'validation',
  invalid_request: 'validation',
  invalid_document: 'validation',
  conflict: 'validation',
  unknown_section: 'not_found',
  invalid_input: 'validation',
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
    code = details.some((d) => /cycle/i.test(d)) ? 'cycle' : details.some((d) => /supersed|is archived; link to what replaced it/i.test(d)) ? 'superseded_target' : 'validation';
    detail = { kind: 'links', problems: details };
  } else if (code === 'done_gate') detail = { kind: 'gate', failures: (err.details as unknown[]) ?? [] };
  else if (code === 'section_referenced' || code === 'criteria_shrink') detail = { kind: code, problems: err.details ?? [] };
  else if (code === 'invalid_request' || code === 'invalid_document' || code === 'conflict' || code === 'unknown_section') code = WRITE_CODE_MAP[code]!;
  const message = msg.replace(/^(invalid_transition|claimed|stale_claim|invalid_links|done_gate|feedback_closed|request_closed|append_only|archive_only|section_referenced|id_reused|criteria_shrink|integrity_violation): /, '');
  return { ...base, code, message, ...(detail ? { detail } : {}), hint: base.hint && base.code === code ? base.hint : (ERROR_ACTIONS[code] ?? base.hint) };
}

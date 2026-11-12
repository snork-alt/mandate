/**
 * Provider failures during an Ask step: which ones are transient (retry the step) and what to log / report about them
 * (error class, HTTP status, request id: never headers wholesale, never keys).
 */
import { APICallError, RetryError } from 'ai';
import type { AskProviderError } from '@mandate/shared';

/** Retries of one failed step (the counter resets when a step completes). */
export const MAX_STEP_RETRIES = 2;

const TRANSIENT_STATUS = new Set([408, 409, 425, 429]);
const TRANSIENT_TEXT =
  /stream ended|before completion|premature|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|socket hang up|other side closed|terminated|fetch failed|network|no compatible route|no route|overloaded|temporarily unavailable|upstream|bad gateway|gateway timeout|service unavailable|try again/i;

/** A dropped stream, a connection error, 429 / 5xx or a routing error of an inference gateway. */
export function isTransientProviderError(e: unknown, depth = 0): boolean {
  if (!e || depth > 3) return false;
  if (RetryError.isInstance(e)) return isTransientProviderError(e.lastError, depth + 1);
  if (APICallError.isInstance(e)) {
    const s = e.statusCode;
    if (e.isRetryable || (s !== undefined && (TRANSIENT_STATUS.has(s) || s >= 500))) return true;
    if (s !== undefined && s >= 400) return TRANSIENT_TEXT.test(`${e.message} ${typeof e.responseBody === 'string' ? e.responseBody.slice(0, 500) : ''}`);
  }
  const err = e as { name?: string; message?: string; cause?: unknown };
  if (TRANSIENT_TEXT.test(`${err.name ?? ''} ${err.message ?? String(e)}`)) return true;
  return err.cause !== undefined && isTransientProviderError(err.cause, depth + 1);
}

/** Anything that looks like a credential is masked (messages may echo request fragments). */
const scrub = (s: string) => s.replace(/Bearer\s+\S+/gi, 'Bearer ***').replace(/\b(sk|pk|rk|key|api[-_]?key|token)[-_][A-Za-z0-9._-]{8,}/gi, '***');

/** Class, status, request id and a short message of a provider error (for logs and AskResult.diagnostics). */
export function describeProviderError(e: unknown): AskProviderError {
  const inner = RetryError.isInstance(e) && e.lastError ? e.lastError : e;
  const err = inner as { name?: string; message?: string };
  const out: AskProviderError = { class: err?.name || (inner as object)?.constructor?.name || 'Error', message: scrub(String(err?.message ?? inner)).slice(0, 300) };
  if (APICallError.isInstance(inner)) {
    if (inner.statusCode !== undefined) out.status = inner.statusCode;
    const h = inner.responseHeaders ?? {};
    const id = h['x-request-id'] ?? h['request-id'] ?? h['x-amzn-requestid'] ?? h['cf-ray'] ?? h['x-correlation-id'];
    if (id) out.requestId = String(id).slice(0, 120);
  }
  return out;
}

/** Exponential backoff with jitter: ~0.5 s, ~1 s, ~2 s (+ up to 50%). */
export function retryDelayMs(attempt: number, base = 500): number {
  const d = base * 2 ** Math.max(0, attempt - 1);
  return Math.round(d + Math.random() * d * 0.5);
}

/** Sleep that ends early (resolves) when the signal aborts. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
}

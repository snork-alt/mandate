/**
 * The UI's few non-MCP calls (`/ui/*`: sign-in session cookie, setup / settings, folder browser, project creation).
 * Every call is same-origin with `X-Mandate-UI: 1`; errors are `{ error: { code, message, path?, hint? } }`.
 */
import { redirectToLogin } from '../auth';

export class UiApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly path?: string,
    readonly hint?: string,
    readonly status = 0,
  ) {
    super(message);
    this.name = 'UiApiError';
  }
}

type ErrorBody = { error?: { code?: string; message?: string; path?: string; hint?: string } };

const toError = (json: ErrorBody | null, status: number) =>
  new UiApiError(json?.error?.code ?? 'http_error', json?.error?.message ?? `request failed (HTTP ${status})`, json?.error?.path, json?.error?.hint, status);

export interface UiRequestOptions {
  signal?: AbortSignal;
  /** Do not redirect to /login on 401 (setup-mode calls authorized by the setup cookie). */
  noLoginRedirect?: boolean;
}

export async function uiRequest<T>(method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, body?: unknown, opts: UiRequestOptions = {}): Promise<T> {
  const res = await fetch(url, {
    method,
    credentials: 'same-origin',
    signal: opts.signal,
    headers: { 'X-Mandate-UI': '1', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  if (res.status === 401 && !opts.noLoginRedirect) {
    redirectToLogin();
    throw new UiApiError('unauthorized', 'not signed in', undefined, 'sign in again', 401);
  }
  const json = (await res.json().catch(() => null)) as (ErrorBody & T) | null;
  if (!res.ok) throw toError(json, res.status);
  return json as T;
}

/** Parse NDJSON chunks: returns complete lines' objects and the unfinished tail. */
export function splitNdjson(buffer: string): { items: unknown[]; rest: string } {
  const lines = buffer.split('\n');
  const rest = lines.pop() ?? '';
  const items: unknown[] = [];
  for (const l of lines) {
    const t = l.trim();
    if (!t) continue;
    try {
      items.push(JSON.parse(t));
    } catch {
      /* ignore a malformed line */
    }
  }
  return { items, rest };
}

/**
 * POST with live progress: `Accept: application/x-ndjson` streams `{ step, status }` lines, then `{ <resultKey>: … }`
 * or `{ error }`. A plain JSON response (older server) is accepted too.
 */
export async function uiStream<T, E extends { step: string; status: string }>(url: string, body: unknown, resultKey: string, onEvent: (e: E) => void): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'X-Mandate-UI': '1', 'Content-Type': 'application/json', Accept: 'application/x-ndjson' },
    body: JSON.stringify(body),
  });
  if (res.status === 401) {
    redirectToLogin();
    throw new UiApiError('unauthorized', 'not signed in', undefined, 'sign in again', 401);
  }
  const type = res.headers.get('content-type') ?? '';
  if (!res.ok || !type.includes('ndjson') || !res.body) {
    const json = (await res.json().catch(() => null)) as (ErrorBody & Record<string, unknown>) | null;
    if (res.ok && json && resultKey in json) return json as T;
    throw toError(json, res.status);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
    const { items, rest } = splitNdjson(done ? `${buffer}\n` : buffer);
    buffer = rest;
    for (const it of items as Array<Record<string, unknown> & ErrorBody>) {
      if (it.error) throw toError(it, res.status);
      if (resultKey in it) return it as T;
      if (typeof it.step === 'string' && typeof it.status === 'string') onEvent(it as unknown as E);
    }
    if (done) break;
  }
  throw new UiApiError('stream_ended', 'the server ended the stream without a result', undefined, 'check the project list; retry if it is missing');
}

/** `smooth` unless the user prefers reduced motion (X5). */
export const scrollBehavior = (): ScrollBehavior => {
  try {
    return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
  } catch {
    return 'smooth';
  }
};

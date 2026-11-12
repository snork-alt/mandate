/** Turns texts into vectors. Prefixes (`search_document: ` / `search_query: `) are applied by the caller. */
export interface EmbeddingProvider {
  /** Stable id of model + settings; vectors from different ids are never mixed. */
  readonly modelId: string;
  readonly dimensions: number;
  embed(texts: string[]): Promise<Float32Array[]>;
}

export class EmbeddingError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    /**
     * The provider as a whole is unusable (unreachable, rate limited, misconfigured), not this input: the queue pauses
     * without charging an attempt to the jobs. False: the input itself may be at fault (per-job attempts and backoff).
     */
    readonly providerWide = false,
  ) {
    super(message);
    this.name = 'EmbeddingError';
  }
}

const CONNECTION_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET', 'UND_ERR_HEADERS_TIMEOUT']);

/** A transport-level failure (connection refused, DNS, timeout) anywhere in the error's cause chain. */
export function isConnectionError(e: unknown): boolean {
  for (let cur = e, depth = 0; cur && typeof cur === 'object' && depth < 5; cur = (cur as { cause?: unknown }).cause, depth++) {
    const { code, name, message } = cur as { code?: unknown; name?: unknown; message?: unknown };
    if (typeof code === 'string' && CONNECTION_CODES.has(code)) return true;
    if (name === 'TimeoutError' || name === 'AbortError') return true;
    if (typeof message === 'string' && /^fetch failed$|ECONNREFUSED/.test(message)) return true;
  }
  return false;
}

/** Should the queue pause (no attempt charged) rather than count a failure against the jobs of the batch? */
export function isProviderWide(e: unknown): boolean {
  return e instanceof EmbeddingError ? e.providerWide : isConnectionError(e);
}

export function checkDims(vectors: number[][] | Float32Array[], dims: number, model: string): Float32Array[] {
  return vectors.map((v) => {
    if (v.length !== dims) throw new EmbeddingError(`model '${model}' returned ${v.length}-dimensional vectors but embedding.dimensions is ${dims}`, false, true);
    return v instanceof Float32Array ? v : Float32Array.from(v);
  });
}

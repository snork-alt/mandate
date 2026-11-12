import { checkDims, EmbeddingError, isConnectionError, type EmbeddingProvider } from './types.js';

export interface OpenAICompatibleOptions {
  baseUrl: string;
  model: string;
  dimensions: number;
  apiKey?: string;
  /** Shortened vector size (`dimensions` request parameter, e.g. OpenAI text-embedding-3-*); omitted when unset. */
  requestDimensions?: number | null;
  modelId: string;
  retries?: number;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** JSON body of `POST /embeddings`: `dimensions` only when a shortened size is requested. */
export function embeddingRequestBody(model: string, input: string[], requestDimensions?: number | null): string {
  return JSON.stringify({ model, input, ...(requestDimensions ? { dimensions: requestDimensions } : {}) });
}

/** `POST {baseUrl}/embeddings` (OpenAI, Ollama, LM Studio, vLLM, ...), with retries and exponential backoff. */
export class OpenAICompatibleProvider implements EmbeddingProvider {
  readonly modelId: string;
  readonly dimensions: number;
  constructor(private readonly opts: OpenAICompatibleOptions) {
    this.modelId = opts.modelId;
    this.dimensions = opts.dimensions;
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    if (!texts.length) return [];
    const { baseUrl, model, apiKey, retries = 4, timeoutMs = 120_000 } = this.opts;
    const doFetch = this.opts.fetch ?? fetch;
    let lastError: Error | undefined;
    // Exhausted retries on a transport error, 429 or a gateway error mean the provider is down, not the input.
    let providerDown = false;
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (attempt) await sleep(Math.min(30_000, 500 * 2 ** (attempt - 1)));
      try {
        const res = await doFetch(`${baseUrl.replace(/\/+$/, '')}/embeddings`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
          body: embeddingRequestBody(model, texts, this.opts.requestDimensions),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!res.ok) {
          const text = (await res.text().catch(() => '')).slice(0, 300);
          // 401/403/404: wrong key, base URL or model for every input (provider-wide); other 4xx: this input.
          const err = new EmbeddingError(`embeddings request failed: HTTP ${res.status} ${text}`, res.status === 429 || res.status >= 500, [401, 403, 404].includes(res.status));
          if (!err.retryable) throw err;
          lastError = err;
          providerDown = [429, 502, 503, 504].includes(res.status);
          continue;
        }
        const body = (await res.json()) as { data?: { embedding: number[]; index?: number }[] };
        if (!Array.isArray(body.data) || body.data.length !== texts.length) {
          throw new EmbeddingError(`embeddings response has ${body.data?.length ?? 'no'} vectors for ${texts.length} inputs`, false);
        }
        const sorted = [...body.data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
        return checkDims(sorted.map((d) => d.embedding), this.dimensions, model);
      } catch (e) {
        if (e instanceof EmbeddingError && !e.retryable) throw e;
        lastError = e instanceof Error ? e : new Error(String(e));
        providerDown = isConnectionError(e);
      }
    }
    throw new EmbeddingError(`embeddings unavailable at ${baseUrl}: ${lastError?.message ?? 'unknown error'}`, true, providerDown);
  }
}

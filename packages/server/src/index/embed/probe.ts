/**
 * Probes for the setup wizard / Settings: list an endpoint's embedding models and test one model (one short input),
 * measuring the vector size and latency. Errors are classified (auth, model, rate limit, network) and never echo a key.
 */
import { embeddingModelsOf, endpointOf, modelPreset, type EmbeddingModelOption, type EndpointPreset, type ListedModel } from './presets.js';
import { embeddingRequestBody } from './openai.js';

type Fetch = typeof fetch;

export type EmbedErrorKind = 'auth' | 'model' | 'rate_limit' | 'network' | 'bad_request' | 'server' | 'response';

/** Remove secrets (and anything shaped like a bearer token) from text shown to the user. */
export function scrubSecrets(text: string, secrets: (string | undefined)[] = []): string {
  let out = text;
  for (const s of secrets) if (s && s.length >= 4) out = out.split(s).join('***');
  return out.replace(/\b(sk|pk|ci|key)[-_][A-Za-z0-9_-]{12,}/g, '***').replace(/Bearer\s+\S+/gi, 'Bearer ***');
}

const headers = (apiKey?: string) => ({ 'content-type': 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) });
const base = (u: string) => u.replace(/\/+$/, '');

export interface EmbedModelsResult {
  ok: boolean;
  models: EmbeddingModelOption[];
  suggested: string | null;
  /** All model ids the endpoint listed (when it lists no embedding model, the UI still lets the user type one). */
  total: number;
  message: string;
  errorKind?: EmbedErrorKind;
}

/** `GET {baseUrl}/models`, filtered to embedding models (id contains `embed`, or the API marks it). */
export async function listEmbeddingModels(p: { baseUrl: string; apiKey?: string; preset?: EndpointPreset }, f: Fetch = fetch): Promise<EmbedModelsResult> {
  const endpoint = p.preset ?? endpointOf(p.baseUrl);
  try {
    const r = await f(`${base(p.baseUrl)}/models`, { headers: headers(p.apiKey), signal: AbortSignal.timeout(15_000) });
    if (r.status === 401 || r.status === 403) return { ok: false, models: [], suggested: null, total: 0, message: p.apiKey ? 'The endpoint rejected the API key.' : 'The endpoint needs an API key.', errorKind: 'auth' };
    if (r.status === 429) return { ok: false, models: [], suggested: null, total: 0, message: 'Rate limited by the endpoint; try again in a minute.', errorKind: 'rate_limit' };
    if (!r.ok) return { ok: false, models: [], suggested: null, total: 0, message: `The endpoint answered ${r.status} for /models.`, errorKind: r.status >= 500 ? 'server' : 'bad_request' };
    const j = (await r.json()) as { data?: ListedModel[]; models?: { name?: string; model?: string }[] };
    // OpenAI shape `{ data: [{ id }] }`; Ollama's native `{ models: [{ name }] }` too.
    const data: ListedModel[] = Array.isArray(j.data) ? j.data.filter((m) => typeof m?.id === 'string') : (j.models ?? []).map((m) => ({ id: String(m.name ?? m.model ?? '') })).filter((m) => m.id);
    const { models, suggested } = embeddingModelsOf(data, endpoint);
    return {
      ok: true,
      models,
      suggested,
      total: data.length,
      message: models.length ? `${models.length} embedding model${models.length === 1 ? '' : 's'} available.` : `No embedding models among the ${data.length} listed; type the model name.`,
    };
  } catch (e) {
    return { ok: false, models: [], suggested: null, total: 0, message: `Could not reach ${base(p.baseUrl)}: ${scrubSecrets((e as Error).message, [p.apiKey])}`, errorKind: 'network' };
  }
}

export interface EmbedTestResult {
  ok: boolean;
  /** Vector length returned by the model (becomes `embedding.dimensions`). */
  dimensions: number | null;
  ms: number;
  message: string;
  errorKind?: EmbedErrorKind;
  /** Settings for the model (prefixes, limits, sizes it can be shortened to). */
  preset: ReturnType<typeof modelPreset>;
}

/** Embed one short string: proves key, model and endpoint, and measures the vector size and latency. */
export async function testEmbeddingModel(
  p: { baseUrl: string; model: string; apiKey?: string; requestDimensions?: number | null; documentPrefix?: string },
  f: Fetch = fetch,
): Promise<EmbedTestResult> {
  const preset = modelPreset(p.model);
  const t0 = Date.now();
  const done = (r: Omit<EmbedTestResult, 'ms' | 'preset'>): EmbedTestResult => ({ ...r, ms: Date.now() - t0, preset });
  const input = `${p.documentPrefix ?? preset.documentPrefix}Mandate embedding test`;
  try {
    const r = await f(`${base(p.baseUrl)}/embeddings`, { method: 'POST', headers: headers(p.apiKey), body: embeddingRequestBody(p.model, [input], p.requestDimensions), signal: AbortSignal.timeout(30_000) });
    if (!r.ok) {
      const text = scrubSecrets((await r.text().catch(() => '')).slice(0, 400), [p.apiKey]);
      const detail = (() => {
        try {
          const j = JSON.parse(text) as { error?: { message?: string } | string; message?: string };
          return (typeof j.error === 'string' ? j.error : j.error?.message) ?? j.message ?? text;
        } catch {
          return text;
        }
      })().slice(0, 200);
      if (r.status === 401 || r.status === 403) return done({ ok: false, dimensions: null, message: p.apiKey ? `The endpoint rejected the API key (${r.status}).` : `The endpoint needs an API key (${r.status}).`, errorKind: 'auth' });
      if (r.status === 429) return done({ ok: false, dimensions: null, message: `Rate limited (429)${detail ? `: ${detail}` : ''}. Try again later or lower the batch size.`, errorKind: 'rate_limit' });
      if (r.status === 404 || /model.*(not found|does not exist|unknown|not supported)|no such model/i.test(detail))
        return done({
          ok: false,
          dimensions: null,
          message: /:11434(\/|$)/.test(p.baseUrl) ? `Model ${p.model} is not installed: ollama pull ${p.model}` : `Model ${p.model} was not found at this endpoint${detail ? `: ${detail}` : '.'}`,
          errorKind: 'model',
        });
      if (p.requestDimensions && /dimension/i.test(detail)) return done({ ok: false, dimensions: null, message: `${p.model} does not accept a ${p.requestDimensions}-dimension size: ${detail}`, errorKind: 'bad_request' });
      return done({ ok: false, dimensions: null, message: `The endpoint answered ${r.status}${detail ? `: ${detail}` : '.'}`, errorKind: r.status >= 500 ? 'server' : 'bad_request' });
    }
    const j = (await r.json()) as { data?: { embedding?: unknown }[] };
    const v = j.data?.[0]?.embedding;
    if (!Array.isArray(v) || !v.length) return done({ ok: false, dimensions: null, message: 'The endpoint answered without an embedding vector (is this an embedding model?).', errorKind: 'response' });
    const ms = Date.now() - t0;
    const shortened = p.requestDimensions && v.length === p.requestDimensions ? ' (shortened)' : '';
    if (p.requestDimensions && v.length !== p.requestDimensions)
      return done({ ok: false, dimensions: v.length, message: `Asked for ${p.requestDimensions} dimensions but got ${v.length}: this endpoint ignores the size parameter. Use the full size.`, errorKind: 'bad_request' });
    return done({ ok: true, dimensions: v.length, message: `${p.model} works: ${v.length} dimensions${shortened}, ${ms} ms.` });
  } catch (e) {
    return done({ ok: false, dimensions: null, message: `Could not reach ${base(p.baseUrl)}: ${scrubSecrets((e as Error).message, [p.apiKey])}`, errorKind: 'network' });
  }
}

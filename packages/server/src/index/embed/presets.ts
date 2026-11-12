/**
 * Embedding presets: remote endpoints (OpenAI, Cheaper Inference, any OpenAI-compatible server) and per-model settings
 * (document / query prefixes, input limit, batch size, shortened sizes, price). The setup wizard and Settings apply them
 * when a model is picked; users can override every value under Advanced (they are plain `embedding.*` config fields).
 */

export const ENDPOINT_PRESETS = ['ollama', 'openai', 'cheaperinference', 'custom'] as const;
export type EndpointPreset = (typeof ENDPOINT_PRESETS)[number];

export interface EndpointInfo {
  id: EndpointPreset;
  label: string;
  /** Null: the user types it (custom). */
  baseUrl: string | null;
  /** Default env var name for the key (null: no key needed). */
  apiKeyEnv: string | null;
  /** Model picked by default after "Load models". */
  recommendedModel: string | null;
  remote: boolean;
  keyUrl?: string;
}

export const ENDPOINTS: Record<EndpointPreset, EndpointInfo> = {
  ollama: { id: 'ollama', label: 'Ollama (local)', baseUrl: 'http://localhost:11434/v1', apiKeyEnv: null, recommendedModel: 'nomic-embed-text', remote: false },
  openai: { id: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', apiKeyEnv: 'OPENAI_API_KEY', recommendedModel: 'text-embedding-3-small', remote: true, keyUrl: 'https://platform.openai.com/api-keys' },
  cheaperinference: {
    id: 'cheaperinference',
    label: 'Cheaper Inference',
    baseUrl: 'https://api.cheaperinference.com/v1',
    apiKeyEnv: 'CHEAPERINFERENCE_API_KEY',
    recommendedModel: 'text-embedding-3-small',
    remote: true,
    keyUrl: 'https://cheaperinference.com',
  },
  custom: { id: 'custom', label: 'Custom', baseUrl: null, apiKeyEnv: 'EMBEDDING_API_KEY', recommendedModel: null, remote: true },
};

/** Normalized base URL for comparisons: lower-case host, no trailing slash. */
export function normalizeBaseUrl(u: string): string {
  try {
    const url = new URL(u);
    return `${url.protocol}//${url.host.toLowerCase()}${url.pathname.replace(/\/+$/, '')}`;
  } catch {
    return u.trim().replace(/\/+$/, '');
  }
}

/** A loopback / private-network endpoint: spec text stays on this machine or network. */
export function isLocalEndpoint(baseUrl: string): boolean {
  try {
    const h = new URL(baseUrl).hostname.toLowerCase();
    return h === 'localhost' || h === '::1' || h === '[::1]' || /^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h) || h.endsWith('.local');
  } catch {
    return false;
  }
}

/** The endpoint preset of a base URL (custom when it matches none). */
export function endpointOf(baseUrl: string): EndpointPreset {
  const n = normalizeBaseUrl(baseUrl);
  for (const e of Object.values(ENDPOINTS)) if (e.baseUrl && normalizeBaseUrl(e.baseUrl) === n) return e.id;
  return 'custom';
}

export interface ModelPreset {
  /** Human name of the family (UI). */
  family: string;
  documentPrefix: string;
  queryPrefix: string;
  maxInputTokens: number;
  batchSize: number;
  /** Full vector size, when known (the Test still measures it). */
  dimensions?: number;
  /** Sizes the API can shorten to with the `dimensions` request parameter (OpenAI text-embedding-3-*). */
  shortenTo?: number[];
  /** USD per million input tokens, when known. */
  pricePerMTok?: number;
}

const NOMIC: Omit<ModelPreset, 'family'> = { documentPrefix: 'search_document: ', queryPrefix: 'search_query: ', maxInputTokens: 2048, batchSize: 32, dimensions: 768 };
/** BGE / mxbai / arctic: an instruction on queries only. */
const BGE_QUERY = 'Represent this sentence for searching relevant passages: ';
/** Qwen3-Embedding: `Instruct: {task}\nQuery:{query}` on queries, documents as-is (model card convention). */
export const QWEN3_QUERY_PREFIX = 'Instruct: Given a search query, retrieve relevant passages from software specifications that answer the query\nQuery:';
/** Gemini Embedding 2 / EmbeddingGemma: task prefix on queries, `title: none | text:` on documents (Google's docs). */
const GEMMA = { documentPrefix: 'title: none | text: ', queryPrefix: 'task: search result | query: ' };

/** Keyed by model-id pattern (matched against the id without a vendor path, case-insensitive); first match wins. */
export const MODEL_PRESETS: [RegExp, ModelPreset][] = [
  [/^nomic-embed-text/, { family: 'Nomic Embed', ...NOMIC }],
  [/^text-embedding-3-small/, { family: 'OpenAI', documentPrefix: '', queryPrefix: '', maxInputTokens: 8000, batchSize: 128, dimensions: 1536, shortenTo: [256, 512, 1024, 1536], pricePerMTok: 0.02 }],
  [/^text-embedding-3-large/, { family: 'OpenAI', documentPrefix: '', queryPrefix: '', maxInputTokens: 8000, batchSize: 128, dimensions: 3072, shortenTo: [256, 512, 1024, 1536, 3072], pricePerMTok: 0.13 }],
  [/^text-embedding-ada-002/, { family: 'OpenAI', documentPrefix: '', queryPrefix: '', maxInputTokens: 8000, batchSize: 128, dimensions: 1536, pricePerMTok: 0.1 }],
  [/^qwen3-embedding/, { family: 'Qwen3 Embedding', documentPrefix: '', queryPrefix: QWEN3_QUERY_PREFIX, maxInputTokens: 8192, batchSize: 32 }],
  [/^(gemini-embedding-2|embeddinggemma)/, { family: 'Gemini Embedding 2 / EmbeddingGemma', ...GEMMA, maxInputTokens: 2048, batchSize: 64 }],
  // gemini-embedding-001 takes a task_type parameter on Google's API; the OpenAI-compatible route has none, so no prefix.
  [/^(gemini-embedding-001|text-embedding-00\d|text-multilingual-embedding)/, { family: 'Gemini / Vertex', documentPrefix: '', queryPrefix: '', maxInputTokens: 2048, batchSize: 64 }],
  [/^(mxbai-embed-large|bge-.*-en|snowflake-arctic-embed)/, { family: 'BGE-style', documentPrefix: '', queryPrefix: BGE_QUERY, maxInputTokens: 512, batchSize: 32 }],
  [/(^|-)e5-/, { family: 'E5', documentPrefix: 'passage: ', queryPrefix: 'query: ', maxInputTokens: 512, batchSize: 32 }],
  [/^(mistral-embed|codestral-embed)/, { family: 'Mistral', documentPrefix: '', queryPrefix: '', maxInputTokens: 8000, batchSize: 64 }],
  [/^embed-(v\d|english|multilingual)/, { family: 'Cohere', documentPrefix: '', queryPrefix: '', maxInputTokens: 8000, batchSize: 96 }],
];

/** Unknown models: no prefixes, a conservative input limit. */
export const GENERIC_PRESET: ModelPreset = { family: 'Generic', documentPrefix: '', queryPrefix: '', maxInputTokens: 2048, batchSize: 32 };

/** Settings for a model id (`openai/text-embedding-3-small` and `nomic-embed-text:latest` match too). */
export function modelPreset(model: string): ModelPreset & { known: boolean } {
  const id = model.toLowerCase().replace(/^.*\//, '');
  for (const [re, p] of MODEL_PRESETS) if (re.test(id)) return { ...p, known: true };
  return { ...GENERIC_PRESET, known: false };
}

/** A `/models` entry: OpenAI's `{ id }`, plus the type / endpoint / pricing fields some gateways add. */
export interface ListedModel {
  id: string;
  type?: string;
  supported_endpoints?: string[];
  endpoint?: string;
  pricing?: { input_per_million?: string | number };
}

/** Is this `/models` entry an embedding model? The id says `embed`, or the API marks it. */
export function isEmbeddingEntry(m: ListedModel): boolean {
  if (/embed/i.test(m.id)) return true;
  if (typeof m.type === 'string' && /embed/i.test(m.type)) return true;
  if (m.supported_endpoints?.some((e) => /\/embeddings$/.test(e)) || (m.endpoint && /\/embeddings$/.test(m.endpoint))) return true;
  return false;
}

export interface EmbeddingModelOption {
  id: string;
  /** USD per million input tokens (from the listing or the preset). */
  pricePerMTok: number | null;
  known: boolean;
}

/** Embedding models of a `/models` response, sorted, with prices; plus the recommended default for the endpoint. */
export function embeddingModelsOf(data: ListedModel[], endpoint: EndpointPreset): { models: EmbeddingModelOption[]; suggested: string | null } {
  const models = data
    .filter(isEmbeddingEntry)
    .map((m) => {
      const listed = m.pricing?.input_per_million !== undefined ? Number(m.pricing.input_per_million) : NaN;
      const p = modelPreset(m.id);
      return { id: m.id, pricePerMTok: Number.isFinite(listed) ? listed : (p.pricePerMTok ?? null), known: p.known };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
  const rec = ENDPOINTS[endpoint].recommendedModel;
  const suggested =
    (rec && models.find((m) => m.id === rec || m.id.replace(/:latest$/, '') === rec)?.id) ??
    models.find((m) => m.id.endsWith('text-embedding-3-small'))?.id ??
    models.find((m) => m.known)?.id ??
    models[0]?.id ??
    null;
  return { models, suggested };
}

/** Rough re-embedding estimate: chunks × average tokens, and the cost when the price is known. */
export function switchEstimate(chunks: number, avgTokens: number, pricePerMTok: number | null): { chunks: number; tokens: number; costUsd: number | null } {
  const tokens = Math.round(chunks * avgTokens);
  return { chunks, tokens, costUsd: pricePerMTok === null ? null : Math.round(((tokens / 1e6) * pricePerMTok) * 10_000) / 10_000 };
}

/** Base URL of an Ask model's provider when its config has none (OpenAI-shaped APIs only). */
const ASK_DEFAULT_BASE: Record<string, string> = { openai: 'https://api.openai.com/v1' };

export interface AskKeyCandidate {
  /** Ask model id (config) and display name. */
  askModelId: string;
  label: string;
  apiKeyEnv: string;
  apiKeySet: boolean;
}

/**
 * Ask models that call the same endpoint as `baseUrl` with a key: the embedding settings can reuse that key's env var
 * ("use the same key as Ask model X"). Only env var names and whether they are set; never the key.
 */
export function askKeyCandidates(
  baseUrl: string,
  askModels: { id: string; label?: string; provider: string; model: string | null; baseUrl?: string | null; apiKeyEnv?: string | null }[],
  isSet: (env: string) => boolean,
): AskKeyCandidate[] {
  const want = normalizeBaseUrl(baseUrl);
  const seen = new Set<string>();
  const out: AskKeyCandidate[] = [];
  for (const m of askModels) {
    if (!m.apiKeyEnv) continue;
    const b = m.baseUrl || ASK_DEFAULT_BASE[m.provider];
    if (!b || normalizeBaseUrl(b) !== want) continue;
    if (seen.has(m.apiKeyEnv)) continue;
    seen.add(m.apiKeyEnv);
    out.push({ askModelId: m.id, label: m.label ?? m.model ?? m.id, apiKeyEnv: m.apiKeyEnv, apiKeySet: isSet(m.apiKeyEnv) });
  }
  return out;
}

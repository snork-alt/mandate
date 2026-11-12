/**
 * The Ask model as an AI SDK LanguageModel (`ai` + `@ai-sdk/*` providers).
 * The API key comes ONLY from the env var named by the model's `apiKeyEnv` (environment or ~/.mandate/secrets.env):
 * every provider gets it explicitly, together with an explicit base URL, so the SDK's own env fallbacks
 * (ANTHROPIC_API_KEY, OPENAI_BASE_URL, ...) are never consulted. Providers are cached per model id and rebuilt when
 * the model's config or its key changes (hot reload).
 */
import { createHash } from 'node:crypto';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogle } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { LanguageModel } from 'ai';
import type { AskModelConfig } from '../config.js';
import { askModelKey } from './status.js';

export const DEFAULT_ANTHROPIC_MODEL = 'claude-opus-5-5';
const DEFAULT_BASE_URL = {
  anthropic: 'https://api.anthropic.com/v1',
  openai: 'https://api.openai.com/v1',
  google: 'https://generativelanguage.googleapis.com/v1beta',
} as const;
/** Models that accept the server-side refusal fallback (`fallbacks: "default"`; the SDK adds the beta header). */
const FALLBACK_MODELS = new Set(['claude-fable-5-2', 'claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5']);

/** Provider options passed to every model call (AI SDK `providerOptions`). */
export type AskProviderOptions = Record<string, Record<string, any>>;

export interface AskModel {
  /** Provider name reported in AskResult (config `provider`). */
  readonly name: string;
  /** Model id reported in AskResult. */
  readonly model: string;
  readonly languageModel: LanguageModel;
  readonly providerOptions?: AskProviderOptions;
}

/**
 * Test override of the Ask model: one model for every choice (configuration checks skipped), or a factory per
 * configured entry (configuration checks still apply).
 */
export type AskModelOverride = AskModel | ((cfg: AskModelConfig) => AskModel);

/** The AI SDK model for one configured entry (callers check askModelStatus first). */
export function createAskModel(cfg: AskModelConfig & { apiKey?: string }, env: NodeJS.ProcessEnv = process.env): AskModel {
  const apiKey = askModelKey(cfg, env);
  const need = (): string => {
    if (!apiKey) throw new Error(`no API key for ask model '${cfg.id}': set the environment variable named by apiKeyEnv${cfg.apiKeyEnv ? ` (${cfg.apiKeyEnv})` : ''}`);
    return apiKey;
  };
  switch (cfg.provider) {
    case 'anthropic': {
      const model = cfg.model ?? DEFAULT_ANTHROPIC_MODEL;
      const provider = createAnthropic({ apiKey: need(), baseURL: cfg.baseUrl ?? DEFAULT_BASE_URL.anthropic });
      // A safety decline re-runs on a fallback model chosen by the API (inputs are still validated by our tool layer).
      // Thinking blocks round-trip through the AI SDK's reasoning parts (signatures kept in providerOptions).
      return { name: 'anthropic', model, languageModel: provider(model), ...(FALLBACK_MODELS.has(model) ? { providerOptions: { anthropic: { fallbacks: 'default' } } } : {}) };
    }
    case 'openai': {
      const model = cfg.model!;
      return { name: 'openai', model, languageModel: createOpenAI({ apiKey: need(), baseURL: cfg.baseUrl ?? DEFAULT_BASE_URL.openai })(model) };
    }
    case 'google': {
      const model = cfg.model!;
      return { name: 'google', model, languageModel: createGoogle({ apiKey: need(), baseURL: cfg.baseUrl ?? DEFAULT_BASE_URL.google })(model) };
    }
    case 'openai-compatible': {
      const model = cfg.model!;
      // The key is optional here (local servers such as Ollama need none).
      const provider = createOpenAICompatible({ name: 'openai-compatible', baseURL: cfg.baseUrl!, ...(apiKey ? { apiKey } : {}), includeUsage: true });
      return { name: 'openai-compatible', model, languageModel: provider.chatModel(model) };
    }
    default:
      throw new Error(`unknown ask provider '${(cfg as { provider?: string }).provider}'`);
  }
}

/** Providers by model id, with a fingerprint of what they were built from (config fields + a hash of the key). */
const cache = new Map<string, { fingerprint: string; model: AskModel }>();

/** The cached model for an entry, rebuilt when its config or key changed. */
export function cachedAskModel(cfg: AskModelConfig & { apiKey?: string }, env: NodeJS.ProcessEnv = process.env): AskModel {
  const key = askModelKey(cfg, env) ?? '';
  const fingerprint = JSON.stringify([cfg.provider, cfg.model, cfg.baseUrl, cfg.apiKeyEnv, createHash('sha256').update(key).digest('hex')]);
  const hit = cache.get(cfg.id);
  if (hit?.fingerprint === fingerprint) return hit.model;
  const model = createAskModel(cfg, env);
  cache.set(cfg.id, { fingerprint, model });
  return model;
}

/** Forget cached providers (tests). */
export function clearAskModelCache(): void {
  cache.clear();
}

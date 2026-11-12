/** Which Ask models are configured (`ask` block of ~/.mandate/config.json). Never exposes a key. */
import { refreshSecrets } from '../secrets.js';
import type { AskModelConfig, ResolvedAskConfig } from '../config.js';
import { DEFAULT_ANTHROPIC_MODEL } from './model.js';
import { askLimits } from './limits.js';
import type { AskLimits } from './agent.js';

export type AskMissing = 'provider' | 'model' | 'apiKey' | 'baseUrl';

export interface AskModelStatus {
  id: string;
  label: string;
  provider: string;
  model?: string;
  baseUrl?: string;
  /** Name of the env var holding the key, and whether it is set in the server's environment. */
  apiKeyEnv?: string;
  apiKeySet: boolean;
  configured: boolean;
  missing: AskMissing[];
  /** Why it is not configured, for the UI (e.g. "set ANTHROPIC_API_KEY"). */
  reason?: string;
}

export interface AskStatus {
  /** At least one model is configured. */
  configured: boolean;
  /** The model used when a question names none (null without models). */
  default: string | null;
  models: AskModelStatus[];
  /** Without any model: what to configure. */
  missing: AskMissing[];
  /** Limits per question (the `ask` block's; models may override some): tool calls, timeout, token budget, output tokens and the tool-result caps. */
  limits: AskLimits;
}

type ModelEntry = AskModelConfig & { apiKey?: string };

/** The key for a model: the env var it names (fresh from the env, secrets.env included), else the value resolved at startup. */
export function askModelKey(m: ModelEntry, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env === process.env) refreshSecrets();
  return (m.apiKeyEnv ? env[m.apiKeyEnv] : undefined) || m.apiKey || undefined;
}

/**
 * - model is required, except for anthropic (default claude-opus-5-5);
 * - anthropic, openai and google need an API key (env var named by apiKeyEnv, set and non-empty);
 * - openai-compatible needs baseUrl; its key is optional (local servers such as Ollama need none),
 *   but when apiKeyEnv is named the variable must be set.
 */
export function askModelStatus(m: ModelEntry, env: NodeJS.ProcessEnv = process.env): AskModelStatus {
  const apiKeySet = !!askModelKey(m, env);
  const missing: AskMissing[] = [];
  if (!m.model && m.provider !== 'anthropic') missing.push('model');
  const keyNeeded = m.provider === 'openai-compatible' ? !!m.apiKeyEnv : true;
  if (keyNeeded && !apiKeySet) missing.push('apiKey');
  if (m.provider === 'openai-compatible' && !m.baseUrl) missing.push('baseUrl');
  const reasons = missing.map((x) =>
    x === 'apiKey' ? (m.apiKeyEnv ? `set ${m.apiKeyEnv} (environment or ~/.mandate/secrets.env)` : 'name the key variable in apiKeyEnv') : x === 'model' ? 'set model' : 'set baseUrl',
  );
  return {
    id: m.id,
    label: m.label ?? m.id,
    provider: m.provider,
    ...(m.model ? { model: m.model } : m.provider === 'anthropic' ? { model: DEFAULT_ANTHROPIC_MODEL } : {}),
    ...(m.baseUrl ? { baseUrl: m.baseUrl } : {}),
    ...(m.apiKeyEnv ? { apiKeyEnv: m.apiKeyEnv } : {}),
    apiKeySet,
    configured: missing.length === 0,
    missing,
    ...(reasons.length ? { reason: reasons.join('; ') } : {}),
  };
}

export function askStatus(cfg: Pick<ResolvedAskConfig, 'default' | 'models'> & Partial<ResolvedAskConfig>, env: NodeJS.ProcessEnv = process.env): AskStatus {
  const models = cfg.models.map((m) => askModelStatus(m, env));
  return {
    configured: models.some((m) => m.configured),
    default: cfg.default ?? models[0]?.id ?? null,
    models,
    missing: models.length ? [] : ['provider', 'model'],
    limits: askLimits(cfg),
  };
}

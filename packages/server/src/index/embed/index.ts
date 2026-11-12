import { createHash } from 'node:crypto';
import type { EmbeddingConfig } from '../../config.js';
import { LocalProvider } from './local.js';
import { OpenAICompatibleProvider } from './openai.js';
import type { EmbeddingProvider } from './types.js';

export { EmbeddingError, type EmbeddingProvider } from './types.js';
export { FakeProvider } from './fake.js';
export { OpenAICompatibleProvider } from './openai.js';
export { LocalProvider } from './local.js';

/** Model id: provider, model, dimensions and a hash of the document prefix (all change the vectors). */
export function modelIdFor(cfg: Pick<EmbeddingConfig, 'provider' | 'model' | 'dimensions' | 'documentPrefix'>): string {
  const p = createHash('sha256').update(cfg.documentPrefix).digest('hex').slice(0, 6);
  return `${cfg.provider}:${cfg.model}:${cfg.dimensions}:${p}`;
}

/** Provider for the config, or null for `none` (semantic search disabled). */
export function createProvider(cfg: EmbeddingConfig & { apiKey?: string }): EmbeddingProvider | null {
  const modelId = modelIdFor(cfg);
  switch (cfg.provider) {
    case 'none':
      return null;
    case 'local':
      return new LocalProvider(cfg.model, cfg.dimensions, modelId);
    case 'openai-compatible':
      return new OpenAICompatibleProvider({ baseUrl: cfg.baseUrl, model: cfg.model, dimensions: cfg.dimensions, apiKey: cfg.apiKey, modelId });
  }
}

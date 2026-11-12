/**
 * Embedding models this index has used (`embed_models`): the config needed to embed queries for a model (never the
 * key, only its env var name) and when its backfill completed. After a model switch, search keeps answering from the
 * newest completed previous model until the new model's backfill finishes, also across restarts.
 */
import type { DB } from '../db.js';
import type { EmbeddingConfig } from '../../config.js';

/** What it takes to embed queries with a model again (no secrets). */
export type StoredModelConfig = Pick<EmbeddingConfig, 'provider' | 'baseUrl' | 'model' | 'dimensions' | 'apiKeyEnv' | 'documentPrefix' | 'queryPrefix'> & {
  requestDimensions?: number | null;
};

export interface StoredModel {
  modelId: string;
  config: StoredModelConfig;
  completedAt: number | null;
}

function ensure(db: DB): void {
  db.exec('CREATE TABLE IF NOT EXISTS embed_models (model_id TEXT PRIMARY KEY, config TEXT NOT NULL, created_at INTEGER NOT NULL, completed_at INTEGER)');
}

export function storedConfig(cfg: EmbeddingConfig): StoredModelConfig {
  const { provider, baseUrl, model, dimensions, apiKeyEnv, documentPrefix, queryPrefix } = cfg;
  return { provider, baseUrl, model, dimensions, apiKeyEnv, documentPrefix, queryPrefix, requestDimensions: cfg.requestDimensions ?? null };
}

/** Record (or refresh the config of) the current model. */
export function rememberModel(db: DB, modelId: string, cfg: StoredModelConfig, now = Date.now()): void {
  ensure(db);
  db.prepare('INSERT INTO embed_models (model_id, config, created_at) VALUES (?, ?, ?) ON CONFLICT (model_id) DO UPDATE SET config = excluded.config').run(modelId, JSON.stringify(cfg), now);
}

/** The model's backfill finished (no outstanding jobs). */
export function markCompleted(db: DB, modelId: string, now = Date.now()): void {
  ensure(db);
  db.prepare('UPDATE embed_models SET completed_at = ? WHERE model_id = ?').run(now, modelId);
}

export function isCompleted(db: DB, modelId: string): boolean {
  ensure(db);
  return !!(db.prepare('SELECT completed_at FROM embed_models WHERE model_id = ?').get(modelId) as { completed_at: number | null } | undefined)?.completed_at;
}

/** Completed models other than `exceptId`, most recently completed first. */
export function previousModels(db: DB, exceptId: string): StoredModel[] {
  ensure(db);
  const rows = db.prepare('SELECT model_id, config, completed_at FROM embed_models WHERE model_id != ? AND completed_at IS NOT NULL ORDER BY completed_at DESC').all(exceptId) as {
    model_id: string;
    config: string;
    completed_at: number;
  }[];
  return rows.flatMap((r) => {
    try {
      return [{ modelId: r.model_id, config: JSON.parse(r.config) as StoredModelConfig, completedAt: r.completed_at }];
    } catch {
      return [];
    }
  });
}

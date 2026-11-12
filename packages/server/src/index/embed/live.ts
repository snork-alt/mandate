/**
 * Hot reload of the `embedding` block (same scheme as ask/live.ts): when the config was loaded from a file in the live
 * process (`source`), the block is re-read whenever the file changes (cheap stat), env overrides re-applied and the key
 * re-read from secrets.env, so a model / endpoint / key change applies without a restart. An invalid edit keeps the
 * last good block (one warning).
 */
import { readFileSync, statSync } from 'node:fs';
import { embeddingConfigSchema, resolveEmbeddingConfig, type ResolvedEmbeddingConfig } from '../../config.js';
import { refreshSecrets } from '../../secrets.js';

const live = new Map<string, { stamp: string; cfg: ResolvedEmbeddingConfig }>();

export function liveEmbeddingConfig(cfg: ResolvedEmbeddingConfig, log: { warn(msg: string): void } = { warn: (m) => console.warn(m) }): ResolvedEmbeddingConfig {
  const file = cfg.source;
  if (!file) return cfg;
  refreshSecrets();
  let stamp: string;
  try {
    const st = statSync(file);
    stamp = `${st.ino}:${st.size}:${st.mtimeMs}`;
  } catch {
    return live.get(file)?.cfg ?? cfg;
  }
  const hit = live.get(file);
  // The key lives in the env (secrets.env): re-resolve when it changed even if the file did not.
  if (hit?.stamp === stamp && (!hit.cfg.apiKeyEnv || process.env[hit.cfg.apiKeyEnv] === hit.cfg.apiKey || process.env.MANDATE_EMBEDDING_API_KEY)) return hit.cfg;
  let next = hit?.cfg ?? cfg;
  try {
    const json = JSON.parse(readFileSync(file, 'utf8')) as { embedding?: unknown };
    const r = embeddingConfigSchema.safeParse(json.embedding ?? {});
    if (r.success) next = resolveEmbeddingConfig(r.data, process.env, file, file);
    else log.warn(`mandate: ignoring the changed embedding block in ${file} (keeping the previous one): ${r.error.issues.map((i) => `embedding.${i.path.join('.')}: ${i.message}`).join('; ')}`);
  } catch (e) {
    log.warn(`mandate: could not re-read ${file}: ${(e as Error).message}`);
  }
  live.set(file, { stamp, cfg: next });
  return next;
}

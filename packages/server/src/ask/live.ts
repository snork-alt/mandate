/**
 * Hot reload of the `ask` block: when the config was loaded from a file in the live process (`source`), the block is
 * re-read whenever the file changes (cheap stat per call), so models added or changed apply without a restart.
 * An invalid edit keeps the last good block (with one warning). Keys are always read fresh from the env (secrets.env
 * is re-read on change), so the model cache rebuilds a provider when its key changes.
 */
import { readFileSync, statSync } from 'node:fs';
import { askConfigSchema, resolveAskConfig, type ResolvedAskConfig } from '../config.js';

const live = new Map<string, { stamp: string; cfg: ResolvedAskConfig }>();

export function liveAskConfig(cfg: ResolvedAskConfig, log: { warn(msg: string): void } = { warn: (m) => console.warn(m) }): ResolvedAskConfig {
  const file = cfg.source;
  if (!file) return cfg;
  let stamp: string;
  try {
    const st = statSync(file);
    stamp = `${st.ino}:${st.size}:${st.mtimeMs}`;
  } catch {
    return live.get(file)?.cfg ?? cfg;
  }
  const hit = live.get(file);
  if (hit?.stamp === stamp) return hit.cfg;
  let next = hit?.cfg ?? cfg;
  try {
    const json = JSON.parse(readFileSync(file, 'utf8')) as { ask?: unknown };
    const r = askConfigSchema.safeParse(json.ask ?? {});
    if (r.success) next = resolveAskConfig(r.data, process.env, file);
    else log.warn(`mandate: ignoring the changed ask block in ${file} (keeping the previous one): ${r.error.issues.map((i) => `ask.${i.path.join('.')}: ${i.message}`).join('; ')}`);
  } catch (e) {
    log.warn(`mandate: could not re-read ${file}: ${(e as Error).message}`);
  }
  live.set(file, { stamp, cfg: next });
  return next;
}

import { createHash, randomBytes } from 'node:crypto';
import type { Section } from '@mandate/shared';

const CROCKFORD = '0123456789abcdefghjkmnpqrstvwxyz';

/** Lowercase ULID (48-bit ms time + 80 random bits, Crockford base32): time-sortable, safe across writers and clones. */
export function ulid(now = Date.now()): string {
  let time = '';
  for (let i = 0, t = now; i < 10; i++, t = Math.floor(t / 32)) time = CROCKFORD[t % 32] + time;
  const bytes = randomBytes(16);
  let rand = '';
  for (let i = 0; i < 16; i++) rand += CROCKFORD[bytes[i]! % 32];
  return time + rand;
}

/** `<prefix>-<ulid>`, e.g. `wo-01jx…`, `vr-…`, `fb-…`. */
export const newId = (prefix: string, now?: number) => `${prefix}-${ulid(now)}`;

/** Content hash of a criterion (statement and verification metadata; not its id or links). */
export function criterionHash(s: Pick<Section, 'title' | 'body' | 'method' | 'threshold'>): string {
  return createHash('sha1').update(JSON.stringify([s.title, s.body, s.method ?? null, s.threshold ?? null])).digest('hex').slice(0, 16);
}

/** Hash of a set of criteria (a waiver pin): changes when any of them changes. */
export function criteriaHash(sections: Pick<Section, 'id' | 'title' | 'body' | 'method' | 'threshold'>[]): string {
  const parts = [...sections].sort((a, b) => a.id.localeCompare(b.id)).map((s) => `${s.id}:${criterionHash(s)}`);
  return createHash('sha1').update(parts.join('|')).digest('hex').slice(0, 16);
}

export const isFullSha = (s: string | undefined) => !!s && /^[0-9a-f]{40}$/.test(s);

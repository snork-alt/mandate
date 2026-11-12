/** Work-order page layout helpers: title without its machine suffix, and which empty sections to hide. */
import type { Section } from '@mandate/shared';

/** Narrative sections an agent fills in over time (hidden while empty). */
const SCAFFOLD: Record<string, string> = { plan: 'Plan', reconciliation: 'Reconciliation', outcome: 'Outcome', history: 'History' };

/** "Fix X (audit 2026-11-12-login-sso f1, f3)" → main "Fix X", origin "audit 2026-11-12-login-sso f1, f3". */
export function splitTitle(title: string): { main: string; origin?: string } {
  const m = /^(.{12,}?)\s*\(((?:audit|feedback|fb-|from )[^()]*)\)\s*$/i.exec(title);
  return m ? { main: m[1]!, origin: m[2]!.replace(/^from\s+/i, '') } : { main: title };
}

/** Empty narrative sections: hidden from the page and the outline; `missing` lists their labels (Plan first). */
export function emptyScaffolding(sections: Section[]): { hidden: Set<string>; missing: string[] } {
  const hidden = new Set<string>();
  const missing: string[] = [];
  for (const s of sections) {
    const label = SCAFFOLD[s.id];
    if (!label || s.type === 'wo-section' || s.body.trim()) continue;
    hidden.add(s.id);
    if (s.id !== 'history') missing.push(label);
  }
  return { hidden, missing };
}

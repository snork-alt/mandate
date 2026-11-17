/**
 * Component ownership of the code a work order touches: every touched file must be owned by a component (owns globs).
 * Used by flow_next (a step before completion), work_order_complete (`components_missing`) and work_order_create (plan
 * files warning). The project setting `components: optional` switches the refusal off (flow_next still asks).
 */
import { ownerOf, type StoredComponent } from '@mandate/shared';
import type { ToolContext } from './define.js';
import { DEFAULT_COMPONENTS } from '../projects/settings.js';

/** Required unless the project says optional; contexts without project settings (in-process tests) do not enforce it. */
export const componentsRequired = (ctx: Pick<ToolContext, 'settings'>): boolean => !!ctx.settings && (ctx.settings.policy().components ?? DEFAULT_COMPONENTS) === 'required';

/** Live (not archived) components. */
export async function liveComponents(ctx: Pick<ToolContext, 'storage'>): Promise<StoredComponent[]> {
  const all = (await ctx.storage.components.list().catch(() => [])) as StoredComponent[];
  return all.filter((c) => (c as { status?: string }).status !== 'archived');
}

/** `repo:path` of the touched files (not deleted) that no live component owns. */
export function unownedOf(comps: StoredComponent[], touched: { repo: string; path: string; change?: string }[]): string[] {
  return [...new Set(touched.filter((t) => t.change !== 'deleted' && !ownerOf(t.repo, t.path, comps)).map((t) => `${t.repo}:${t.path}`))];
}

/** Plan `files` entries (`repo:path`, `repo:path#L1-L9` or a bare path) no component owns; a bare path is owned when any repo of a component owns it. */
export function unownedPlanFiles(comps: StoredComponent[], files: unknown[]): string[] {
  const repos = [...new Set(comps.flatMap((c) => (c.owns ?? []).map((o) => o.repo)))];
  const out: string[] = [];
  for (const f of files) {
    const s = typeof f === 'string' ? f : (f as { repo?: string; path?: string } | null)?.path ? `${(f as { repo?: string }).repo ? `${(f as { repo?: string }).repo}:` : ''}${(f as { path: string }).path}` : '';
    if (!s) continue;
    const m = /^([A-Za-z0-9_.-]+):([^#\s]+)/.exec(s);
    const repo = m?.[1];
    const p = (m?.[2] ?? s.split('#')[0]!).replace(/^\.\//, '');
    const owned = repo ? !!ownerOf(repo, p, comps) : repos.some((r) => !!ownerOf(r, p, comps));
    if (!owned) out.push(s.split('#')[0]!);
  }
  return [...new Set(out)];
}

/**
 * Code repo names already used in a project's data (before code repos were registered): spec `repo` and section code
 * refs, mandate://code / code-commits / prs references in section text, components' `owns`, work orders' touched /
 * git, verifications and audits. Settings → Code repositories lists the unregistered ones so an admin can link each.
 */
import type { Storage } from './index.js';

const REF_RE = /mandate:\/\/(?:code|code-commits|prs)\/([A-Za-z0-9_.-]+)\//g;

/** name → number of uses. */
export async function codeRepoUsage(storage: Storage): Promise<Map<string, number>> {
  const uses = new Map<string, number>();
  const add = (name: string | undefined | null) => {
    if (name) uses.set(name, (uses.get(name) ?? 0) + 1);
  };
  const scanText = (t: unknown) => {
    if (typeof t !== 'string') return;
    for (const m of t.matchAll(REF_RE)) add(m[1]);
  };
  const scanSections = (sections: { body?: unknown; refs?: { repo?: string }[]; codeRefs?: unknown[] }[]) => {
    for (const s of sections) {
      scanText(s.body);
      for (const r of s.refs ?? []) add(r.repo);
      for (const c of s.codeRefs ?? []) add(typeof c === 'string' ? /^([A-Za-z0-9_.-]+):/.exec(c)?.[1] : (c as { repo?: string })?.repo);
    }
  };
  const safe = async <T>(p: Promise<T[]>) => p.catch(() => [] as T[]);
  for (const s of await safe(storage.specs.list())) {
    add(s.repo);
    scanSections(s.sections as never);
  }
  for (const s of await safe(storage.standards.list())) scanSections(s.sections as never);
  for (const c of await safe(storage.components.list())) {
    for (const o of c.owns ?? []) add(o.repo);
    scanSections(c.sections as never);
  }
  for (const w of await safe(storage.workOrderDocs.list())) {
    for (const t of w.touched ?? []) add(t.repo);
    for (const g of w.git ?? []) add(g.repo);
    scanSections(w.sections as never);
  }
  for (const v of await safe(storage.verifications.list())) {
    add(v.code?.repo);
    for (const c of v.codeRefs ?? []) add(/^([A-Za-z0-9_.-]+):/.exec(c)?.[1]);
  }
  for (const a of await safe(storage.audits.list())) {
    add((a as { code?: { repo?: string } }).code?.repo);
    scanSections(a.sections as never);
  }
  return uses;
}

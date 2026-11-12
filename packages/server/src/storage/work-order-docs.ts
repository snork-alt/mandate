/**
 * Work orders as markdown documents (`work-orders/<id>.md`): the projection to the flat `WorkOrder` every service and
 * list uses, the conversion of legacy `work-orders.jsonl` / `queue.jsonl` lines, reads at old commits, and the
 * one-time migration (one commit, idempotent).
 */
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import {
  buildRef,
  parseRef,
  WO_HISTORY,
  WO_OUTCOME,
  WO_PLAN,
  WO_RECONCILIATION,
  WO_RESERVED_SECTIONS,
  workOrderSchema,
  type PastClaim,
  type Section,
  type StoredWorkOrderDoc,
  type WorkOrder,
} from '@mandate/shared';
import type { GitStore } from '../git/GitStore.js';
import { specCodec, workOrderCodec } from './codecs.js';
import type { HeartbeatStore } from './heartbeats.js';
import type { Mutex } from './Mutex.js';

export const WORK_ORDER_DIR = 'work-orders';
export const LEGACY_FILES = ['work-orders.jsonl', 'queue.jsonl'] as const;
/** Trailer of the migration commit (activity derivation skips its per-item diff). */
export const MIGRATION_TRAILER = 'Mandate-Migration';
export const MIGRATION_VALUE = 'work-orders-md';

const KIND_VERB: Record<string, string> = { implement: 'Implement', update: 'Update', review: 'Review', verify: 'Verify', fix: 'Fix' };

/** The wo-section id for a targeted spec section (`s-<id>` when it would clash with plan / outcome / ...). */
export const woSectionId = (specSection: string) => ((WO_RESERVED_SECTIONS as readonly string[]).includes(specSection) ? `s-${specSection}` : specSection);
export const isWoSection = (s: Section) => s.type === 'wo-section';
/** The targeted spec section id of a wo-section. */
export const targetSection = (s: Section) => (s.target ? (parseRef(s.target)?.sectionId ?? s.id) : s.id);
export const sectionBody = (d: Pick<StoredWorkOrderDoc, 'sections'>, id: string) => d.sections.find((s) => s.id === id)?.body ?? '';

const md = (id: string, title: string, body = ''): Section => ({ id, title, type: 'markdown', refs: [], symbols: [], links: [], verifiedBy: [], body });

/** A wo-section for a spec section. */
export function woSection(spec: string, sid: string, title: string, status: 'pending' | 'done' | 'obsolete' = 'pending'): Section {
  return { id: woSectionId(sid), title, type: 'wo-section', target: buildRef({ kind: 'specs', id: spec, sectionId: sid }), status, refs: [], symbols: [], links: [], verifiedBy: [], body: '' } as Section;
}

/** Plan, the wo-sections, reconciliation, outcome (+ history): the canonical section order. */
export function orderSections(sections: Section[]): Section[] {
  const by = (id: string) => sections.filter((s) => s.id === id);
  return [...by(WO_PLAN), ...sections.filter(isWoSection), ...by(WO_RECONCILIATION), ...by(WO_OUTCOME), ...by(WO_HISTORY), ...sections.filter((s) => !isWoSection(s) && !(WO_RESERVED_SECTIONS as readonly string[]).includes(s.id))];
}

/** A new work order document (sections: empty plan, pending wo-sections, empty reconciliation / outcome). */
export function newWorkOrderSections(spec: string, targets: { id: string; title: string; status?: 'pending' | 'done' | 'obsolete' }[], plan = ''): Section[] {
  return [md(WO_PLAN, 'Plan', plan.trim()), ...targets.map((t) => woSection(spec, t.id, t.title, t.status)), md(WO_RECONCILIATION, 'Reconciliation'), md(WO_OUTCOME, 'Outcome')];
}

export function defaultTitle(kind: string, specTitle: string, sectionTitles: string[]): string {
  const t = `${KIND_VERB[kind] ?? kind} ${specTitle}: ${sectionTitles.join(', ')}`;
  return t.length > 200 ? `${t.slice(0, 197)}...` : t;
}

/** The flat projection of a work order document (claim heartbeat from the runtime state). */
export function projectWorkOrder(d: StoredWorkOrderDoc, heartbeat: (claim: NonNullable<StoredWorkOrderDoc['claim']>) => string = (c) => c.startedAt): WorkOrder {
  const sections = d.sections.filter(isWoSection).map((s) => ({ id: targetSection(s), status: s.status ?? 'pending' }));
  const out: WorkOrder = {
    id: d.id,
    spec: d.spec,
    specCommit: d.specCommit,
    kind: d.kind,
    ...(d.priority ? { priority: d.priority } : {}),
    status: d.status,
    ...(d.note ? { note: d.note } : {}),
    sections,
    ...(d.createdBy ? { createdBy: d.createdBy } : {}),
    reason: d.reason ?? [],
    ...(d.findings?.length ? { findings: d.findings } : {}),
    ...(d.claim ? { claim: { ...d.claim, heartbeatAt: heartbeat(d.claim) } } : {}),
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
    title: d.title,
    ...(d.fastPath ? { fastPath: true } : {}),
    ...(d.dependencies?.length ? { dependencies: d.dependencies } : {}),
    ...(d.claims?.length ? { claims: d.claims } : {}),
    ...(d.completedAt ? { completedAt: d.completedAt } : {}),
    ...(d.touched?.length ? { touched: d.touched } : {}),
    ...(d.git?.length ? { git: d.git } : {}),
    hasPlan: sectionBody(d, WO_PLAN).trim().length > 0,
  } as WorkOrder;
  return out;
}

/* ---------------------------------------------------------------- legacy jsonl */

/** Parse legacy jsonl text loosely (lines that do not validate are still converted when they have the essentials). */
export function parseLegacyLines(text: string | null): { items: WorkOrder[]; bad: string[] } {
  const items: WorkOrder[] = [];
  const bad: string[] = [];
  for (const raw of (text ?? '').split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    try {
      const o = JSON.parse(line) as Record<string, unknown>;
      const r = workOrderSchema.safeParse(o);
      if (r.success) items.push(r.data);
      else if (typeof o.id === 'string' && typeof o.spec === 'string' && Array.isArray(o.sections) && o.sections.length) items.push(o as unknown as WorkOrder);
      else bad.push(line);
    } catch {
      bad.push(line);
    }
  }
  return { items, bad };
}

/** Legacy line -> document (titles from the spec at specCommit when available). */
export function docFromLegacy(
  w: WorkOrder,
  opts: { specTitle?: string; sectionTitles?: Record<string, string>; claims?: PastClaim[]; history?: string; specCommit?: string } = {},
): StoredWorkOrderDoc {
  const titles = opts.sectionTitles ?? {};
  const secs = w.sections.map((s) => ({ id: s.id, title: titles[s.id] ?? s.id, status: s.status ?? 'pending' }));
  // Audit fix work orders carried their findings list in the note: it becomes the plan stub (claimable as before).
  const plan = w.kind === 'fix' && w.findings?.length && w.note ? `Plan stub (migrated from the work order note):\n\n${w.note}` : '';
  const sections = newWorkOrderSections(w.spec, secs, plan);
  const outcome = sections.find((s) => s.id === WO_OUTCOME)!;
  if (w.status === 'done') outcome.body = 'Completed before work orders became documents (migrated from work-orders.jsonl): no outcome was recorded. See the history section.';
  if (opts.history) sections.push(md(WO_HISTORY, 'History', opts.history));
  const isOpen = w.status === 'pending' || w.status === 'in_progress';
  const claim = isOpen && w.claim ? { agent: w.claim.agent, ...(w.claim.branch ? { branch: w.claim.branch } : {}), ...(w.claim.worktree ? { worktree: w.claim.worktree } : {}), startedAt: w.claim.startedAt } : undefined;
  return {
    id: w.id,
    title: defaultTitle(w.kind, opts.specTitle ?? w.spec, secs.map((s) => s.title)),
    spec: w.spec,
    specCommit: opts.specCommit ?? w.specCommit,
    kind: w.kind,
    status: w.status,
    ...(w.priority ? { priority: w.priority } : {}),
    ...(w.note ? { note: w.note } : {}),
    ...(claim ? { claim } : {}),
    ...(opts.claims?.length ? { claims: opts.claims } : {}),
    reason: w.reason ?? [],
    ...(w.findings?.length ? { findings: w.findings } : {}),
    ...(w.createdBy ? { createdBy: w.createdBy } : {}),
    createdAt: w.createdAt || w.updatedAt || new Date(0).toISOString(),
    updatedAt: w.updatedAt || w.createdAt || new Date(0).toISOString(),
    ...(w.status === 'done' ? { completedAt: w.updatedAt } : {}),
    sections,
  } as StoredWorkOrderDoc;
}

/** Work orders at a commit: markdown documents, plus legacy jsonl lines (pre-migration commits). */
export async function workOrdersAt(git: GitStore, commit: string): Promise<WorkOrder[]> {
  const out = new Map<string, WorkOrder>();
  const blobs = await git.blobsAt(commit, [WORK_ORDER_DIR], [...LEGACY_FILES]).catch(() => new Map<string, string>());
  for (const p of blobs.keys()) {
    const m = /^work-orders\/([a-z0-9-]+)\.md$/.exec(p);
    if (!m) continue;
    const raw = await git.readFileAt(commit, p).catch(() => null);
    if (!raw) continue;
    try {
      out.set(m[1]!, projectWorkOrder(workOrderCodec.decode(raw, m[1]!)));
    } catch {
      /* unparsable at that commit */
    }
  }
  for (const f of LEGACY_FILES) {
    if (!blobs.has(f)) continue;
    for (const w of parseLegacyLines(await git.readFileAt(commit, f).catch(() => null)).items) if (!out.has(w.id)) out.set(w.id, w);
  }
  return [...out.values()];
}

/* ---------------------------------------------------------------- migration */

export interface MigrationResult {
  migrated: string[];
  skipped: string[];
  commit: string | null;
  unmigrated: number;
}

type HistoryLike = { mentioning(id: string): Promise<{ commit: string; date: string; subject: string; agent?: string | null; author?: string; authorName?: string }[]> };

/** Past claims of a legacy item, reconstructed from the jsonl at each commit of its history (oldest first). */
async function legacyClaims(git: GitStore, id: string, entries: { commit: string; date: string }[], cache: Map<string, Map<string, WorkOrder>>): Promise<PastClaim[]> {
  const at = async (sha: string) => {
    if (!cache.has(sha)) {
      const map = new Map<string, WorkOrder>();
      for (const f of LEGACY_FILES) {
        const t = await git.readFileAt(sha, f).catch(() => null);
        for (const w of parseLegacyLines(t).items) if (!map.has(w.id)) map.set(w.id, w);
      }
      cache.set(sha, map);
    }
    return cache.get(sha)!.get(id);
  };
  const out: PastClaim[] = [];
  let prev: WorkOrder | undefined;
  for (const e of [...entries].reverse()) {
    const cur = await at(e.commit);
    if (!cur) continue;
    const pc = prev?.claim;
    const cc = cur.claim;
    if (pc && (!cc || cc.agent !== pc.agent || cc.startedAt !== pc.startedAt)) {
      const ended: PastClaim['ended'] = cc ? (cc.agent !== pc.agent ? 'taken_over' : 'reclaimed') : cur.status === 'done' ? 'completed' : cur.status === 'failed' ? 'failed' : cur.status === 'cancelled' ? 'cancelled' : 'released';
      out.push({ agent: pc.agent, ...(pc.branch ? { branch: pc.branch } : {}), ...(pc.worktree ? { worktree: pc.worktree } : {}), startedAt: pc.startedAt, endedAt: e.date, ended });
    }
    prev = cur;
  }
  return out;
}

/**
 * One-time migration: every `work-orders.jsonl` (and legacy `queue.jsonl`) line becomes `work-orders/<id>.md`
 * (ids, status, claims, timestamps kept; claim history reconstructed from git; a history section summarises the
 * jsonl-era commits), the jsonl files are removed, all in ONE commit. Idempotent: nothing to do once the jsonl files
 * are gone; documents that already exist are kept. Open claims seed the runtime heartbeat store. Lines that cannot be
 * converted are kept verbatim in `work-orders/unmigrated.jsonl` (never dropped).
 */
export async function migrateWorkOrders(deps: { git: GitStore; lock: Mutex; history: HistoryLike; heartbeats?: HeartbeatStore; log?: (msg: string) => void }): Promise<MigrationResult> {
  const { git, lock } = deps;
  const present = LEGACY_FILES.filter((f) => existsSync(path.join(git.dir, f)));
  if (!present.length) return { migrated: [], skipped: [], commit: null, unmigrated: 0 };
  return lock.run(async () => {
    const items = new Map<string, WorkOrder>();
    const bad: string[] = [];
    for (const f of present) {
      const r = parseLegacyLines(readFileSync(path.join(git.dir, f), 'utf8'));
      for (const w of r.items) if (!items.has(w.id)) items.set(w.id, w);
      bad.push(...r.bad);
    }
    const migrated: string[] = [];
    const skipped: string[] = [];
    const paths: string[] = [...present];
    const cache = new Map<string, Map<string, WorkOrder>>();
    const specAt = new Map<string, ReturnType<typeof specCodec.decode> | null>();
    await mkdir(path.join(git.dir, WORK_ORDER_DIR), { recursive: true });
    for (const w of items.values()) {
      const file = `${WORK_ORDER_DIR}/${w.id}.md`;
      if (existsSync(path.join(git.dir, file))) {
        // Already a document (e.g. an interrupted migration): kept as is (and committed with the rest).
        skipped.push(w.id);
        paths.push(file);
        continue;
      }
      const full = (await git.resolveCommit(w.specCommit).catch(() => null)) ?? w.specCommit;
      const key = `${w.spec}@${full}`;
      if (!specAt.has(key)) {
        const raw = await git.readFileAt(full, `specs/${w.spec}.md`).catch(() => null);
        let spec = null;
        try {
          spec = raw ? specCodec.decode(raw, w.spec) : null;
        } catch {
          spec = null;
        }
        specAt.set(key, spec);
      }
      const spec = specAt.get(key);
      const entries = (await deps.history.mentioning(w.id)).filter((e) => !e.subject.startsWith('work-orders: migrate'));
      const claims = await legacyClaims(git, w.id, entries, cache);
      const history = entries.length
        ? [
            `Migrated from \`work-orders.jsonl\` (${entries.length} commit${entries.length === 1 ? '' : 's'} before the migration, newest first):`,
            '',
            ...entries.slice(0, 50).map((e) => `- ${e.date.slice(0, 16).replace('T', ' ')} · ${e.agent ?? e.authorName ?? e.author ?? 'unknown'} · ${e.subject} (\`${e.commit.slice(0, 7)}\`)`),
            ...(entries.length > 50 ? [`- … ${entries.length - 50} older commits`] : []),
          ].join('\n')
        : 'Migrated from `work-orders.jsonl`.';
      const doc = docFromLegacy(w, {
        specTitle: spec?.title,
        sectionTitles: Object.fromEntries((spec?.sections ?? []).map((s) => [s.id, s.title])),
        claims,
        history,
        ...(/^[0-9a-f]{40}$/.test(full) ? { specCommit: full } : {}),
      });
      let text: string;
      try {
        text = workOrderCodec.encode(doc);
      } catch (e) {
        deps.log?.(`work order ${w.id} cannot be converted (${(e as Error).message}); kept in work-orders/unmigrated.jsonl`);
        bad.push(JSON.stringify(w));
        continue;
      }
      await writeFile(path.join(git.dir, file), text, 'utf8');
      paths.push(file);
      migrated.push(w.id);
      if (doc.claim && deps.heartbeats && w.claim?.heartbeatAt) deps.heartbeats.set(w.id, doc.claim.agent, w.claim.heartbeatAt);
    }
    if (bad.length) {
      const f = `${WORK_ORDER_DIR}/unmigrated.jsonl`;
      await writeFile(path.join(git.dir, f), bad.map((l) => `${l}\n`).join(''), 'utf8');
      paths.push(f);
    }
    for (const f of present) await rm(path.join(git.dir, f));
    const message = [
      `work-orders: migrate ${present.join(' + ')} to markdown documents (${migrated.length} work orders)`,
      '',
      `Each work order is now work-orders/<id>.md: frontmatter (status, claim, claim history, links, timestamps) plus plan,`,
      `one wo-section per targeted spec section, reconciliation and outcome; a history section summarises the jsonl-era commits.`,
      `Claim heartbeats are runtime state (not committed) from now on.${skipped.length ? ` Already migrated: ${skipped.join(', ')}.` : ''}${bad.length ? ` ${bad.length} line(s) kept in work-orders/unmigrated.jsonl.` : ''}`,
      '',
      `Work orders: ${migrated.join(', ') || '(none)'}`,
      '',
      `${MIGRATION_TRAILER}: ${MIGRATION_VALUE}`,
      '',
    ].join('\n');
    const commit = await git.commit(paths, message);
    deps.log?.(`migrated ${migrated.length} work order(s) to work-orders/<id>.md${commit ? ` in ${commit.slice(0, 7)}` : ''}`);
    return { migrated, skipped, commit, unmigrated: bad.length };
  });
}

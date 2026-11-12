import {
  claimWorkOrderSchema,
  isClaimStale,
  OPEN_WORK_ORDER_STATUSES,
  WORK_ORDER_TRANSITIONS,
  workOrderClaimRefSchema,
  workOrderDependenciesInputSchema,
  workOrderSchema,
  workOrderSectionDoneSchema,
  type ClaimWorkOrderInput,
  type CreateWorkOrderInput,
  type DependencyTree,
  type ResolvedWorkOrder,
  type Section,
  type SectionImplementation,
  type StoredFeedback,
  type StoredSpec,
  type UpdateWorkOrderInput,
  type WorkOrder,
  type WorkOrderClaimRefInput,
  type WorkOrderDependenciesInput,
  type WorkOrderSectionDoneInput,
} from '@mandate/shared';
import type { GitStore } from '../git/GitStore.js';
import { specCodec } from './codecs.js';
import { ConflictError, NotFoundError, type CommitMeta } from './GitBackedRepository.js';
import type { HistoryService } from './history.js';
import { newId } from './ids.js';
import type { JsonlFileRepository } from './JsonlFileRepository.js';
import type { MarkdownDirRepository } from './MarkdownDirRepository.js';
import { openChangingOrders } from './model.js';

class ValidationError extends Error {
  readonly statusCode = 400;
}
/** A work order claimed by another agent whose heartbeat is fresh (409 `claimed`). */
export class ClaimedError extends Error {
  readonly statusCode = 409;
  readonly code = 'claimed';
}

/** A claim held by another agent that went stale: claim the work order first (claims take over stale ones). */
export class StaleClaimError extends Error {
  readonly statusCode = 409;
  readonly code = 'stale_claim';
}

/** `wo-` + a lowercase ULID. */
export const newWorkOrderId = (now?: number) => newId('wo', now);

const sameSection = (a: Section | undefined, b: Section | undefined) => !!a && !!b && a.title === b.title && a.type === b.type && a.body === b.body;
const isOpen = (w: Pick<WorkOrder, 'status'>) => OPEN_WORK_ORDER_STATUSES.includes(w.status);
const finished = (s: WorkOrder['sections'][number]) => s.status === 'done' || s.status === 'obsolete';

/**
 * Work-order rules: spec/section validation at the pinned (full) `specCommit`, at most one open
 * implement/update work order per spec section, claims (agent, branch, worktree, heartbeat) on the
 * work order, status transitions, derived `done`, `section_done` recording implementedCommit =
 * specCommit, and `reason` links to feedback. Validation runs inside the write lock (`check`).
 */
export class WorkOrderService {
  constructor(
    private readonly repo: JsonlFileRepository<WorkOrder>,
    private readonly specs: MarkdownDirRepository<StoredSpec>,
    private readonly git: GitStore,
    private readonly history: HistoryService,
  ) {}

  /** Set by storage: sections of a spec blocked / broken by a section-level depends_on. */
  blockedSections?: (spec: StoredSpec) => Promise<string[]>;
  brokenSections?: (spec: StoredSpec) => Promise<string[]>;
  /** Dependency graph hook (set by createStorage; see DependencyService). */
  dependencies?: (item: WorkOrder, opts: { at?: string; depth?: number }) => Promise<DependencyTree>;
  /** Feedback items (for `reason` validation and resolution). */
  feedback?: () => Promise<StoredFeedback[]>;

  list() {
    return this.repo.list();
  }

  get(id: string) {
    return this.repo.get(id);
  }

  /** The spec as stored at `commit` (null when it did not exist / does not parse there; undefined when the commit is unreadable). */
  async specAt(specId: string, commit: string): Promise<StoredSpec | null | undefined> {
    const full = await this.git.resolveCommit(commit).catch(() => null);
    if (!full) return undefined;
    const raw = await this.git.readFileAt(full, this.specs.pathOf(specId)).catch(() => null);
    if (raw === null) return null;
    try {
      return specCodec.decode(raw, specId);
    } catch {
      return null;
    }
  }

  /**
   * Storage hook (inside the write lock). Closing transitions (cancel, fail, done) never validate pins;
   * open work orders need their spec and sections at `specCommit` and must not overlap another open
   * implement/update work order on the same section.
   */
  async check(next: WorkOrder, current: WorkOrder | undefined): Promise<void> {
    if (current && current.status !== next.status && !WORK_ORDER_TRANSITIONS[current.status].includes(next.status)) {
      throw new ConflictError(`work order ${next.id}: ${current.status} -> ${next.status} is not allowed`);
    }
    if (next.claim && !isOpen(next)) throw new ValidationError('only open work orders can be claimed');
    // Inside the write lock: a fresh claim by another agent cannot be overwritten (claim races have one winner).
    if (current?.claim && next.claim && next.claim.agent !== current.claim.agent && !isClaimStale(current.claim)) {
      throw new ClaimedError(`claimed: ${next.id} is claimed by ${current.claim.agent}`);
    }
    const dup = next.sections.map((s) => s.id).find((id, i, all) => all.indexOf(id) !== i);
    if (dup) throw new ValidationError(`section '${dup}' listed twice`);
    if (!isOpen(next)) return;
    const pinChanged = !current || current.specCommit !== next.specCommit || current.sections.map((s) => s.id).join() !== next.sections.map((s) => s.id).join();
    if (pinChanged) {
      const spec = await this.specs.get(next.spec).catch(() => null);
      if (!spec) throw new ValidationError(`spec '${next.spec}' does not exist`);
      if (spec.status === 'archived') throw new ValidationError(`spec '${next.spec}' is archived`);
      const at = await this.specAt(next.spec, next.specCommit);
      if (at === undefined) throw new ValidationError(`commit ${next.specCommit} cannot be read`);
      if (!at) throw new ValidationError(`spec '${next.spec}' does not exist at commit ${next.specCommit}`);
      const ids = new Set(at.sections.map((s) => s.id));
      const missing = next.sections.filter((s) => !ids.has(s.id)).map((s) => s.id);
      if (missing.length) throw new ValidationError(`sections not in ${next.spec}@${next.specCommit.slice(0, 7)}: ${missing.join(', ')}`);
    }
    if (next.kind === 'implement' || next.kind === 'update') {
      const open = openChangingOrders((await this.repo.list()).filter((w) => w.id !== next.id));
      const clash = next.sections.filter((s) => s.status === 'pending').map((s) => ({ s, other: open.get(`${next.spec}/${s.id}`)?.[0] })).find((x) => x.other);
      if (clash) throw new ConflictError(`section ${next.spec}/${clash.s.id} already has an open ${clash.other!.kind} work order: ${clash.other!.id}`);
    }
    if (next.reason.length && this.feedback) {
      const known = new Set((await this.feedback()).map((f) => f.id));
      const unknown = next.reason.filter((r) => !known.has(r));
      if (unknown.length) throw new ValidationError(`reason: feedback ${unknown.join(', ')} does not exist`);
    }
  }

  /** Done once every targeted section is done or obsolete; closing drops the claim. */
  private derive(item: WorkOrder): WorkOrder {
    const allDone = item.sections.every(finished);
    const status = allDone && isOpen(item) ? 'done' : item.status;
    const { claim, ...rest } = item;
    return isOpen({ status }) && claim ? { ...rest, status, claim } : { ...rest, status };
  }

  async create(input: CreateWorkOrderInput & { status: WorkOrder['status'] }, meta: CommitMeta = {}): Promise<WorkOrder> {
    const head = (await this.history.meta(this.specs.pathOf(input.spec)).catch(() => null))?.lastCommit;
    const specCommit = input.specCommit ? await this.git.resolveCommit(String(input.specCommit)) : head ? await this.git.resolveCommit(head) : null;
    if (!specCommit) throw new ValidationError(input.specCommit ? `unknown commit '${input.specCommit}'` : `spec '${input.spec}' has no committed version`);
    const item = this.derive(
      workOrderSchema.parse({
        ...input,
        id: input.id ?? newWorkOrderId(),
        specCommit,
        sections: input.sections.map((s) => ({ id: s.id, status: s.status ?? 'pending' })),
        createdAt: '',
        updatedAt: '',
      }),
    );
    const { createdAt: _c, updatedAt: _u, ...stored } = item;
    return this.repo.create(stored as never, meta);
  }

  async update(id: string, patch: UpdateWorkOrderInput, meta: CommitMeta = {}): Promise<WorkOrder> {
    const current = await this.repo.get(id);
    const merged = { ...current, ...patch } as Record<string, unknown>;
    if (patch.specCommit) {
      const full = await this.git.resolveCommit(String(patch.specCommit));
      if (!full) throw new ValidationError(`unknown commit '${patch.specCommit}'`);
      merged.specCommit = full;
    }
    for (const [k, v] of Object.entries(merged)) if (v === null) delete merged[k];
    const next = this.derive(workOrderSchema.parse(merged));
    const { id: _id, createdAt: _c, updatedAt: _u, ...rest } = next;
    return this.repo.update(id, { ...rest, priority: next.priority ?? null, note: next.note ?? null, claim: next.claim ?? null } as never, meta);
  }

  /** Claim a work order for an agent (sets it in progress). A fresh claim by another agent is a 409. */
  async claim(input: ClaimWorkOrderInput, meta: CommitMeta = {}): Promise<WorkOrder> {
    const { id, agent, branch, worktree } = claimWorkOrderSchema.parse(input);
    const current = await this.repo.get(id);
    // Claiming reopens a failed work order (failed -> in_progress); done and cancelled are final.
    if (!isOpen(current) && current.status !== 'failed') throw new ConflictError(`work order ${id} is ${current.status}`);
    if (current.claim && current.claim.agent !== agent && !isClaimStale(current.claim)) throw new ClaimedError(`claimed: ${id} is claimed by ${current.claim.agent}`);
    const now = (meta.date ?? new Date()).toISOString();
    const claim = { agent, ...(branch ? { branch } : {}), ...(worktree ? { worktree } : {}), startedAt: now, heartbeatAt: now };
    return this.repo.update(id, { status: 'in_progress', claim } as never, { ...meta, agent: meta.agent ?? agent, message: meta.message ?? `work order: claim ${id}` });
  }

  /** Refresh the claim's heartbeat (only the claiming agent). */
  async heartbeat(input: WorkOrderClaimRefInput, meta: CommitMeta = {}): Promise<WorkOrder> {
    const { id, agent } = workOrderClaimRefSchema.parse(input);
    const current = await this.repo.get(id);
    if (current.claim?.agent !== agent) throw new ClaimedError(`claimed: ${id} is not claimed by ${agent}`);
    const claim = { ...current.claim, heartbeatAt: (meta.date ?? new Date()).toISOString() };
    return this.repo.update(id, { claim } as never, { ...meta, agent: meta.agent ?? agent, message: meta.message ?? `work order: heartbeat ${id}` });
  }

  /** Release the claim (back to pending). */
  async release(input: WorkOrderClaimRefInput, meta: CommitMeta = {}): Promise<WorkOrder> {
    const { id, agent } = workOrderClaimRefSchema.parse(input);
    const current = await this.repo.get(id);
    if (current.claim?.agent !== agent) throw new ClaimedError(`claimed: ${id} is not claimed by ${agent}`);
    return this.repo.update(id, { claim: null, ...(current.status === 'in_progress' ? { status: 'pending' } : {}) } as never, { ...meta, agent: meta.agent ?? agent, message: meta.message ?? `work order: release ${id}` });
  }

  /**
   * Mark covered sections done or obsolete. For implement / update work orders, `done` records
   * implementedCommit = the work order's specCommit (the version actually implemented) on the spec
   * sections, in a spec commit carrying the `Work-Order:` trailer.
   */
  async sectionDone(input: WorkOrderSectionDoneInput, meta: CommitMeta = {}): Promise<WorkOrder> {
    const { id, sections, status } = workOrderSectionDoneSchema.parse(input);
    const current = await this.repo.get(id);
    if (!isOpen(current)) throw new ConflictError(`work order ${id} is ${current.status}`);
    const unknown = sections.filter((s) => !current.sections.some((x) => x.id === s));
    if (unknown.length) throw new ValidationError(`not covered by ${id}: ${unknown.join(', ')}`);
    if (status === 'done' && (current.kind === 'implement' || current.kind === 'update')) {
      const spec = await this.specs.get(current.spec);
      const updated = spec.sections.map((s) => (sections.includes(s.id) ? { ...s, implementedCommit: current.specCommit } : s));
      await this.specs.update(current.spec, { sections: updated } as never, {
        ...meta,
        message: `spec(${current.spec}): implemented ${sections.join(', ')} @${current.specCommit.slice(0, 7)}`,
        trailers: { ...meta.trailers, 'Work-Order': id },
      });
    }
    return this.update(id, { sections: current.sections.map((s) => (sections.includes(s.id) ? { ...s, status } : s)) }, meta);
  }

  delete(id: string, meta: CommitMeta = {}) {
    return this.repo.delete(id, meta);
  }

  /**
   * Who may act on a work order: anyone while unclaimed, the claiming agent (also with a stale claim of its own),
   * nobody else while the claim is fresh (`claimed`); another agent's stale claim must be taken over first (`stale_claim`).
   */
  async requireHolder(id: string, agent: string): Promise<WorkOrder> {
    const current = await this.repo.get(id);
    const c = current.claim;
    if (!c || c.agent === agent) return current;
    if (isClaimStale(c)) throw new StaleClaimError(`stale_claim: ${id} has a stale claim by ${c.agent} (heartbeat ${c.heartbeatAt}); claim it first to take it over`);
    throw new ClaimedError(`claimed: ${id} is claimed by ${c.agent}`);
  }

  /** Finish a work order: every still-pending section is marked done (recording implementedCommit), so it becomes done. */
  async complete(id: string, agent: string, meta: CommitMeta = {}): Promise<WorkOrder> {
    const current = await this.requireHolder(id, agent);
    if (!isOpen(current)) throw new ConflictError(`work order ${id} is ${current.status}; done and cancelled are final`);
    const pending = current.sections.filter((s) => s.status === 'pending').map((s) => s.id);
    if (pending.length) return this.sectionDone({ id, sections: pending, status: 'done' }, meta);
    return this.update(id, { status: 'done' }, meta);
  }

  /** Fail or cancel a work order (closing transitions never validate the pin; the claim is dropped). */
  async close(id: string, status: 'failed' | 'cancelled', agent: string, note: string | undefined, meta: CommitMeta = {}): Promise<WorkOrder> {
    const current = await this.requireHolder(id, agent);
    const notes = note ? [current.note, `${status}: ${note}`].filter(Boolean).join('\n') : current.note;
    return this.update(id, { status, ...(notes ? { note: notes } : {}) }, { ...meta, message: meta.message ?? `work order: ${status === 'failed' ? 'fail' : 'cancel'} ${id}` });
  }

  /**
   * Atomically pick and claim the next eligible work order: open, unclaimed (or stale, or already the caller's),
   * none of its pending sections blocked or broken, matching the filters; by priority (p0 first), then age.
   * Concurrent callers never get the same item (the claim check runs inside the write lock); a lost race tries the next one.
   */
  async next(
    filters: { kinds?: WorkOrder['kind'][]; spec?: string; priority?: string[]; specs?: (s: StoredSpec) => boolean },
    claim: { agent: string; branch?: string; worktree?: string },
    meta: CommitMeta = {},
  ): Promise<{ workOrder: WorkOrder | null; skipped: { id: string; reason: string }[] }> {
    const skipped: { id: string; reason: string }[] = [];
    const rank = (w: WorkOrder) => (w.priority ? Number(w.priority.slice(1)) : 9);
    const candidates = (await this.repo.list())
      .filter((w) => isOpen(w))
      .filter((w) => !filters.kinds?.length || filters.kinds.includes(w.kind))
      .filter((w) => !filters.spec || w.spec === filters.spec)
      .filter((w) => !filters.priority?.length || (w.priority && filters.priority.includes(w.priority)))
      .filter((w) => !w.claim || w.claim.agent === claim.agent || isClaimStale(w.claim))
      .sort((a, b) => rank(a) - rank(b) || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    const specCache = new Map<string, StoredSpec | null>();
    for (const w of candidates) {
      if (!specCache.has(w.spec)) specCache.set(w.spec, await this.specs.get(w.spec).catch(() => null));
      const spec = specCache.get(w.spec);
      if (!spec) {
        skipped.push({ id: w.id, reason: `spec '${w.spec}' does not exist` });
        continue;
      }
      if (filters.specs && !filters.specs(spec)) continue;
      const pending = new Set(w.sections.filter((s) => s.status === 'pending').map((s) => s.id));
      const blocked = [...((await this.blockedSections?.(spec)) ?? []), ...((await this.brokenSections?.(spec)) ?? [])].filter((s) => pending.has(s));
      if (blocked.length) {
        skipped.push({ id: w.id, reason: `blocked sections: ${[...new Set(blocked)].join(', ')}` });
        continue;
      }
      try {
        return { workOrder: await this.claim({ id: w.id, ...claim }, meta), skipped };
      } catch (e) {
        if (e instanceof ClaimedError) {
          skipped.push({ id: w.id, reason: 'claimed concurrently by another agent' });
          continue;
        }
        throw e;
      }
    }
    return { workOrder: null, skipped };
  }

  /** Cancel the open work orders of an archived spec; mark pending sections that were archived obsolete. */
  async afterSpecWrite(spec: StoredSpec, meta: CommitMeta = {}): Promise<void> {
    for (const w of await this.repo.list()) {
      if (w.spec !== spec.id || !isOpen(w)) continue;
      if (spec.status === 'archived') {
        await this.update(w.id, { status: 'cancelled' }, { ...meta, message: `work order: cancel ${w.id} (spec archived)` });
        continue;
      }
      const archived = new Set(spec.sections.filter((s) => s.archived).map((s) => s.id));
      if (w.sections.some((s) => s.status === 'pending' && archived.has(s.id))) {
        await this.update(w.id, { sections: w.sections.map((s) => (s.status === 'pending' && archived.has(s.id) ? { ...s, status: 'obsolete' as const } : s)) }, { ...meta, message: `work order: ${w.id} sections archived` });
      }
    }
  }

  /** The resolved work order, with its dependency graph (at `at` when viewing an old version). */
  async resolve(id: string, opts: Omit<WorkOrderDependenciesInput, 'id'> = {}): Promise<ResolvedWorkOrder> {
    const { at: depAt, depth } = workOrderDependenciesInputSchema.parse({ ...opts, id });
    const item = await this.repo.get(id);
    const current = await this.specs.get(item.spec).catch(() => null);
    const at = await this.specAt(item.spec, item.specCommit);
    const head = (await this.history.meta(this.specs.pathOf(item.spec))).lastCommit;
    const blockedIds = new Set(current && this.blockedSections ? await this.blockedSections(current) : []);
    const brokenIds = new Set(current && this.brokenSections ? await this.brokenSections(current) : []);
    const sections = item.sections.map((t) => {
      const section = at?.sections.find((s) => s.id === t.id) ?? null;
      const latest = current?.sections.find((s) => s.id === t.id);
      // Done work orders are immutable records: they resolve at their own commit only.
      const headChanged = isOpen(item) && !!section && !sameSection(section, latest);
      return {
        id: t.id,
        status: t.status,
        section,
        ...(headChanged ? { latest: latest ?? null } : {}),
        headChanged,
        blocked: blockedIds.has(t.id),
        ...(brokenIds.has(t.id) ? { broken: true } : {}),
        ...(latest?.archived ? { archived: true } : {}),
      };
    });
    const pick = current ?? at;
    const fb = item.reason.length && this.feedback ? await this.feedback() : [];
    return {
      item,
      spec: pick ? { id: pick.id, title: pick.title, summary: pick.summary, category: pick.category, status: pick.status, priority: pick.priority, repo: pick.repo, owner: pick.owner } : null,
      ...(at === undefined ? { pinLost: true } : {}),
      ...(item.reason.length
        ? { reasons: item.reason.map((r) => fb.find((f) => f.id === r)).filter((f): f is StoredFeedback => !!f).map((f) => ({ id: f.id, status: f.status, kind: f.kind, body: f.body })) }
        : {}),
      sections,
      specMovedTo: head && !head.startsWith(item.specCommit.slice(0, 7)) && !item.specCommit.startsWith(head) && sections.some((s) => s.headChanged) ? head : null,
      ...(this.dependencies ? { dependencies: await this.dependencies(item, { at: depAt, depth }) } : {}),
    };
  }

  historyOf(id: string) {
    return this.history.mentioning(id);
  }

  /** Per-section implementation state of a spec: outdated when the section changed since its implementedCommit. */
  async implementation(specId: string): Promise<SectionImplementation> {
    const spec = await this.specs.get(specId);
    const out: SectionImplementation = {};
    const cache = new Map<string, StoredSpec | null | undefined>();
    for (const s of spec.sections) {
      if (!s.implementedCommit) continue;
      if (!cache.has(s.implementedCommit)) cache.set(s.implementedCommit, await this.specAt(specId, s.implementedCommit));
      const then = cache.get(s.implementedCommit);
      if (then === undefined) {
        out[s.id] = { implementedCommit: s.implementedCommit, outdated: false, pinLost: true };
        continue;
      }
      out[s.id] = { implementedCommit: s.implementedCommit, outdated: !sameSection(then?.sections.find((x) => x.id === s.id), s) };
    }
    return out;
  }
}

export { NotFoundError };

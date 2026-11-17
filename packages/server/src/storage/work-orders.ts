import {
  buildRef,
  parseNodeUri,
  claimWorkOrderSchema,
  FROZEN_WORK_ORDER_STATUSES,
  isClaimStale,
  isFastPath,
  mergeGit,
  mergeTouched,
  nextStepSeq,
  OPEN_WORK_ORDER_STATUSES,
  parseStepLines,
  reconcileSteps,
  renderStepLine,
  replaceStepLines,
  stepsOf,
  syncStepLines,
  toDesired,
  unfinishedSteps,
  touchedFromInput,
  WO_HISTORY,
  WO_OUTCOME,
  WO_PLAN,
  WO_RECONCILIATION,
  WO_RESERVED_SECTIONS,
  woSectionKey,
  WORK_ORDER_TRANSITIONS,
  workOrderDependenciesInputSchema,
  type ClaimEndReason,
  type ClaimWorkOrderInput,
  type CommentThread,
  type CreateWorkOrderInput,
  type DependencyTree,
  type GitContextPatch,
  type DesiredStep,
  type GitFieldsInput,
  type PlanStep,
  type PlanStepInput,
  type PlanStepStatus,
  type ResolvedWorkOrder,
  type Section,
  type SectionImplementation,
  type StoredFeedback,
  type StoredSpec,
  type StoredWorkOrderDoc,
  type TouchedFile,
  type TouchedInput,
  type UpdateWorkOrderInput,
  type VerificationRecord,
  type WorkOrderPlanInput,
  type WorkOrder,
  type WorkOrderDependenciesInput,
  type CodeLink,
} from '@mandate/shared';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { GitStore } from '../git/GitStore.js';
import { codeChanges, type CodeRepoResolver } from './code-repos.js';
import { specCodec, workOrderCodec } from './codecs.js';
import { ConflictError, NotFoundError, type CommitMeta, type WriteContext } from './GitBackedRepository.js';
import { effectiveHeartbeat, MemoryHeartbeats, type HeartbeatStore } from './heartbeats.js';
import type { HistoryService } from './history.js';
import { newId } from './ids.js';
import type { MarkdownDirRepository } from './MarkdownDirRepository.js';
import { openChangingOrders } from './model.js';
import { applyCodeToSection, checkPlanTests, checkStepLinks, coveredCriteria, renderPlan } from './work-order-plan.js';
import type { Mutex } from './Mutex.js';
import {
  defaultTitle,
  isWoSection,
  LEGACY_FILES,
  newWorkOrderSections,
  orderSections,
  parseLegacyLines,
  projectWorkOrder,
  sectionBody,
  targetSection,
  docFromLegacy,
} from './work-order-docs.js';
import { readFileSync } from 'node:fs';

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

/** Structured work-order errors (`plan_required`, `work_order_frozen`, `outcome_required`, `open_comments`, ...). */
export class WorkOrderError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly detail?: { kind: string; [k: string]: unknown },
    readonly statusCode = 409,
  ) {
    super(message);
  }
}

/** `wo-` + a lowercase ULID. */
export const newWorkOrderId = (now?: number) => newId('wo', now);

const sameSection = (a: Section | undefined, b: Section | undefined) => !!a && !!b && a.title === b.title && a.type === b.type && a.body === b.body;
const isOpen = (w: Pick<WorkOrder, 'status'>) => OPEN_WORK_ORDER_STATUSES.includes(w.status);
const isFrozen = (w: Pick<WorkOrder, 'status'>) => (FROZEN_WORK_ORDER_STATUSES as readonly string[]).includes(w.status);
const RESERVED = WO_RESERVED_SECTIONS as readonly string[];

/** Drop empty arrays / undefined (canonical YAML; the doc format prunes them). */
function clean<T extends Record<string, unknown>>(o: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined && !(Array.isArray(v) && v.length === 0)) out[k] = v;
  return out as T;
}
const cleanSection = (s: Section): Section => clean({ ...s, ...(s.codeRefs ? { codeRefs: s.codeRefs.map((c) => clean(c)) } : {}) }) as Section;

/** What may still change once a work order is closed: PR status / merge commit and mergedInto (and updatedAt). */
function frozenView(d: StoredWorkOrderDoc): string {
  return JSON.stringify({
    ...d,
    updatedAt: 0,
    git: d.git?.map((g) => ({ ...g, mergedInto: undefined, pr: g.pr ? { ...g.pr, status: undefined, mergedCommit: undefined } : undefined })),
  });
}
/** The stored text without `updatedAt` (to skip writes that change nothing). */
const sansUpdated = (d: StoredWorkOrderDoc) => {
  try {
    return workOrderCodec.encode({ ...d, updatedAt: '-' });
  } catch {
    return JSON.stringify({ ...d, updatedAt: 0 });
  }
};

/** Move the current claim into `claims` (how it ended). */
function endClaim(d: StoredWorkOrderDoc, ended: ClaimEndReason, at: string): StoredWorkOrderDoc {
  if (!d.claim) return d;
  const { claim, ...rest } = d;
  return { ...rest, claims: [...(d.claims ?? []), { ...claim, endedAt: at, ended }] } as StoredWorkOrderDoc;
}
/** True when the work order has sections and every one is done or obsolete. */
export const allSectionsDone = (d: Pick<StoredWorkOrderDoc, 'sections'>): boolean => {
  const wos = d.sections.filter(isWoSection);
  return wos.length > 0 && wos.every((s) => s.status === 'done' || s.status === 'obsolete');
};

const endReason = (status: WorkOrder['status']): ClaimEndReason => (status === 'done' ? 'completed' : status === 'failed' ? 'failed' : status === 'cancelled' ? 'cancelled' : 'released');

/** Delivery extras accepted by claim / heartbeat / section_done / complete. */
export interface DeliveryExtras {
  git?: GitFieldsInput[];
  touched?: TouchedInput[];
}

/**
 * Work-order rules over the markdown documents `work-orders/<id>.md`: spec/section validation at the pinned (full)
 * `specCommit`, at most one open implement/update work order per spec section, claims (agent, branch, worktree; the
 * heartbeat is runtime state, not git), the plan gate on claims (fast-path fixes excepted), status transitions, the
 * freeze of closed work orders (PR status / merge fields excepted), section notes / code / deviations, touched code,
 * git context, `section_done` recording implementedCommit = specCommit, and `reason` links to feedback.
 * Validation runs inside the write lock (`beforeWrite`).
 */
export class WorkOrderService {
  constructor(
    readonly docs: MarkdownDirRepository<StoredWorkOrderDoc>,
    private readonly specs: MarkdownDirRepository<StoredSpec>,
    private readonly git: GitStore,
    private readonly history: HistoryService,
    readonly heartbeats: HeartbeatStore = new MemoryHeartbeats(),
  ) {}

  /** Set by storage: sections of a spec blocked / broken by a section-level depends_on. */
  blockedSections?: (spec: StoredSpec) => Promise<string[]>;
  brokenSections?: (spec: StoredSpec) => Promise<string[]>;
  /** Dependency graph hook (set by createStorage; see DependencyService). */
  dependencies?: (item: WorkOrder, opts: { at?: string; depth?: number }) => Promise<DependencyTree>;
  /** Feedback items (for `reason` validation and resolution). */
  feedback?: () => Promise<StoredFeedback[]>;
  /** Comment threads on a work order (doc uri; set by createStorage). */
  comments?: (workOrderUri: string) => Promise<CommentThread[]>;
  /** The project's write lock (set by createStorage; re-entrant): multi-document writes hold it throughout. */
  lock?: Mutex;
  /** Ids of the recorded verification results (wo-section `verifications` validation; set by createStorage). */
  verificationIds?: () => Promise<string[]>;
  /** The recorded verification results (criteria proof at completion; set by createStorage). */
  verificationRecords?: () => Promise<VerificationRecord[]>;
  /** Called after a work order completed (the requests it acted on may close; set by createStorage). */
  onCompleted?: (wo: WorkOrder, meta: CommitMeta) => Promise<void>;

  private locked<T>(fn: () => Promise<T>): Promise<T> {
    return this.lock ? this.lock.run(fn) : fn();
  }

  /* ---------------------------------------------------------------- reads */

  private project = (d: StoredWorkOrderDoc) => projectWorkOrder(d, (c) => effectiveHeartbeat(this.heartbeats, d.id, c));

  /** Legacy jsonl items not migrated yet (read-only until the startup migration ran). */
  private legacy(): WorkOrder[] {
    const out: WorkOrder[] = [];
    for (const f of LEGACY_FILES) {
      const p = path.join(this.git.dir, f);
      if (!existsSync(p)) continue;
      for (const w of parseLegacyLines(readFileSync(p, 'utf8')).items) if (!out.some((x) => x.id === w.id)) out.push(w);
    }
    return out;
  }

  async list(): Promise<WorkOrder[]> {
    const docs = (await this.docs.list()).map(this.project);
    const legacy = this.legacy().filter((w) => !docs.some((d) => d.id === w.id));
    // Creation order (ids are time-sortable ULIDs / counters; createdAt breaks ties across schemes).
    return [...docs, ...legacy].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  }

  async get(id: string): Promise<WorkOrder> {
    const d = await this.docs.get(id).catch((e) => {
      const l = this.legacy().find((w) => w.id === id);
      if (l) return null;
      throw e;
    });
    return d ? this.project(d) : this.legacy().find((w) => w.id === id)!;
  }

  /** The stored document (frontmatter + sections). */
  async doc(id: string): Promise<StoredWorkOrderDoc> {
    try {
      return await this.docs.get(id);
    } catch (e) {
      if (this.legacy().some((w) => w.id === id)) throw new WorkOrderError('migration_pending', `work order ${id} is still in work-orders.jsonl: restart the server to migrate work orders to documents`, undefined, 409);
      throw e;
    }
  }

  /** Work orders being completed right now: marking their last pending sections done keeps the claim for `completed`. */
  private readonly keepClaimOnDone = new Set<string>();

  /** The claim's effective heartbeat (runtime state; see heartbeats.ts). */
  heartbeatOf(id: string, claim: NonNullable<StoredWorkOrderDoc['claim']>): string {
    return effectiveHeartbeat(this.heartbeats, id, claim);
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

  /* ---------------------------------------------------------------- write rules (storage hook) */

  /**
   * Inside the write lock: structure, identity, transitions, the freeze of closed work orders, claim races, the pin
   * (spec + sections at `specCommit`, open work orders only), one open implement/update per section, links. Closing
   * moves the claim to `claims`; `completedAt` is stamped; `updatedAt` only when something else changed.
   */
  async beforeWrite(next: StoredWorkOrderDoc, current: StoredWorkOrderDoc | undefined, ctx: WriteContext): Promise<StoredWorkOrderDoc> {
    const now = (ctx.meta.date ?? new Date()).toISOString();
    const bad = next.sections.find((s) => !(s.type === 'wo-section' || (s.type === 'markdown' && RESERVED.includes(s.id))));
    if (bad) throw new ValidationError(`work-order sections are plan / reconciliation / outcome / history (markdown) and wo-section; "${bad.id}" is ${bad.type}`);
    if (!next.sections.some((s) => s.id === WO_PLAN)) throw new ValidationError('a work order needs a "plan" section');
    const wos = next.sections.filter(isWoSection);
    if (!wos.length) throw new ValidationError('a work order targets at least one section');
    const targets = wos.map((s) => s.target ?? '');
    const dupT = targets.find((t, i) => targets.indexOf(t) !== i);
    if (dupT) throw new ValidationError(`section '${dupT}' listed twice`);
    const foreign = wos.find((s) => !s.target?.startsWith(`mandate://specs/${next.spec}/sections/`));
    if (foreign) throw new ValidationError(`wo-section ${foreign.id} targets ${foreign.target}, not a section of ${next.spec}`);
    if (next.fastPath && !isFastPath(next, wos.length)) throw new ValidationError('fastPath is for fix work orders with exactly one section');
    if (current) {
      if (current.spec !== next.spec || current.createdAt !== next.createdAt || current.kind !== next.kind) throw new WorkOrderError('work_order_frozen', `spec, kind and createdAt of work order ${next.id} never change`);
      if (current.status !== next.status && !WORK_ORDER_TRANSITIONS[current.status].includes(next.status)) {
        throw new ConflictError(`work order ${next.id}: ${current.status} -> ${next.status} is not allowed`);
      }
      if (isFrozen(current) && current.status === next.status && frozenView(next) !== frozenView(current)) {
        throw new WorkOrderError('work_order_frozen', `work order ${next.id} is ${current.status}: it is frozen (only git pr status / pr.mergedCommit / mergedInto can change)`, { kind: 'work_order', status: current.status });
      }
    }
    let out: StoredWorkOrderDoc = { ...next };
    // Closing drops the claim into the history.
    if (out.claim && !isOpen(out)) out = endClaim(out, endReason(out.status), now);
    // The last section done / obsolete releases the claim (status stays in_progress): work_order_complete needs no claim then.
    if (out.claim && isOpen(out) && current && !allSectionsDone(current) && allSectionsDone(out) && !this.keepClaimOnDone.has(out.id)) out = endClaim(out, 'all_done', now);
    // Inside the write lock: a fresh claim by another agent cannot be overwritten (claim races have one winner).
    if (current?.claim && out.claim && out.claim.agent !== current.claim.agent && !isClaimStale({ heartbeatAt: this.heartbeatOf(current.id, current.claim) })) {
      throw new ClaimedError(`claimed: ${next.id} is claimed by ${current.claim.agent}`);
    }
    if (out.status === 'done' && (!current || current.status !== 'done')) out.completedAt = out.completedAt ?? now;
    if (isOpen(out)) {
      const pinChanged = !current || current.specCommit !== out.specCommit || JSON.stringify(current.sections.filter(isWoSection).map((s) => s.target)) !== JSON.stringify(targets);
      if (pinChanged) await this.checkPin(out.spec, out.specCommit, wos.map(targetSection));
      if (out.kind === 'implement' || out.kind === 'update') {
        const open = openChangingOrders((await this.list()).filter((w) => w.id !== out.id));
        const clash = wos.filter((s) => (s.status ?? 'pending') === 'pending').map((s) => ({ s: targetSection(s), other: open.get(`${out.spec}/${targetSection(s)}`)?.[0] })).find((x) => x.other);
        if (clash) throw new ConflictError(`section ${out.spec}/${clash.s} already has an open ${clash.other!.kind} work order: ${clash.other!.id}`);
      }
      if (out.reason.length && this.feedback && (!current || JSON.stringify(current.reason) !== JSON.stringify(out.reason))) {
        const known = new Set((await this.feedback()).map((f) => f.id));
        const unknown = out.reason.filter((r) => !known.has(r));
        if (unknown.length) throw new ValidationError(`reason: feedback ${unknown.join(', ')} does not exist`);
      }
      if (out.dependencies?.length && (!current || JSON.stringify(current.dependencies ?? []) !== JSON.stringify(out.dependencies))) {
        if (out.dependencies.includes(out.id)) throw new ValidationError('a work order cannot depend on itself');
        const ids = new Set((await this.list()).map((w) => w.id));
        const unknown = out.dependencies.filter((d) => !ids.has(d));
        if (unknown.length) throw new ValidationError(`dependencies: work order ${unknown.join(', ')} does not exist`);
      }
    }
    out = { ...out, sections: orderSections(out.sections.map(cleanSection)), ...(out.touched ? { touched: out.touched.map((t) => clean(t)) } : {}) };
    out = clean(out as unknown as Record<string, unknown>) as unknown as StoredWorkOrderDoc;
    out.reason = out.reason ?? [];
    if (current && sansUpdated(out) === sansUpdated({ ...current, reason: current.reason ?? [] })) return current;
    return { ...out, updatedAt: current ? now : out.updatedAt };
  }

  private async checkPin(spec: string, specCommit: string, sections: string[]): Promise<void> {
    const cur = await this.specs.get(spec).catch(() => null);
    if (!cur) throw new ValidationError(`spec '${spec}' does not exist`);
    if (cur.status === 'archived') throw new ValidationError(`spec '${spec}' is archived`);
    const at = await this.specAt(spec, specCommit);
    if (at === undefined) throw new ValidationError(`commit ${specCommit} cannot be read`);
    if (!at) throw new ValidationError(`spec '${spec}' does not exist at commit ${specCommit}`);
    const ids = new Set(at.sections.map((s) => s.id));
    const missing = sections.filter((s) => !ids.has(s));
    if (missing.length) throw new ValidationError(`sections not in ${spec}@${specCommit.slice(0, 7)}: ${missing.join(', ')}`);
    // MW-7: no new work on archived sections.
    const archived = sections.filter((s) => cur.sections.find((x) => x.id === s)?.archived);
    if (archived.length) throw new ValidationError(`sections of ${spec} are archived: ${archived.join(', ')}`);
  }

  /* ---------------------------------------------------------------- writes */

  private modify(id: string, fn: (d: StoredWorkOrderDoc) => StoredWorkOrderDoc | Promise<StoredWorkOrderDoc>, meta: CommitMeta): Promise<StoredWorkOrderDoc> {
    return this.doc(id).then(() => this.docs.modify(id, fn, meta));
  }

  async create(
    input: CreateWorkOrderInput & { status: WorkOrder['status']; title?: string; plan?: string | WorkOrderPlanInput; fastPath?: boolean; dependencies?: string[] },
    meta: CommitMeta = {},
  ): Promise<WorkOrder> {
    const head = (await this.history.meta(this.specs.pathOf(input.spec)).catch(() => null))?.lastCommit;
    const specCommit = input.specCommit ? await this.git.resolveCommit(String(input.specCommit)) : head ? await this.git.resolveCommit(head) : null;
    if (!specCommit) throw new ValidationError(input.specCommit ? `unknown commit '${input.specCommit}'` : `spec '${input.spec}' has no committed version`);
    const at = await this.specAt(input.spec, specCommit);
    const titleOf = (sid: string) => at?.sections.find((s) => s.id === sid)?.title ?? sid;
    const dup = input.sections.map((s) => s.id).find((id, i, all) => all.indexOf(id) !== i);
    if (dup) throw new ValidationError(`section '${dup}' listed twice`);
    // A structured plan: rendered to the plan section; its tests must prove every acceptance criterion the work order covers.
    let planText = typeof input.plan === 'string' ? input.plan : '';
    let planTests: WorkOrderPlanInput['tests'] | undefined;
    let planSteps: PlanStep[] | undefined;
    if (input.plan && typeof input.plan === 'object') {
      const criteria = coveredCriteria(at, input.sections.map((s) => s.id));
      const desired = input.plan.steps.map(toDesired);
      const problems = [...checkPlanTests(input.plan.tests ?? [], criteria), ...checkStepLinks(desired, input.sections.map((s) => s.id), criteria)];
      const made = reconcileSteps([], desired.map(({ id: _id, ...d }) => d), 0, { now: (meta.date ?? new Date()).toISOString(), by: input.createdBy ?? meta.agent ?? 'agent' });
      problems.push(...made.problems);
      if (problems.length) throw new WorkOrderError('plan_invalid', `plan_invalid: ${problems.join('; ')}`, { kind: 'plan', problems, criteria: criteria.map((c) => c.id) }, 400);
      planSteps = made.steps;
      planText = renderPlan({ ...input.plan, steps: made.steps });
      planTests = input.plan.tests;
    }
    const now = (meta.date ?? new Date()).toISOString();
    // Sequenced ids (`q-0001`, ...) are allocated by the repository inside the write lock.
    const id = input.id;
    const secs = input.sections.map((s) => ({ id: s.id, title: titleOf(s.id), status: s.status ?? 'pending' }));
    const doc: StoredWorkOrderDoc = clean({
      id,
      title: input.title?.trim() || defaultTitle(input.kind, at?.title ?? input.spec, secs.map((s) => s.title)),
      spec: input.spec,
      specCommit,
      kind: input.kind,
      status: input.status,
      priority: input.priority,
      fastPath: input.fastPath || undefined,
      note: input.note,
      dependencies: input.dependencies,
      planTests: planTests?.length ? planTests : undefined,
      planSteps: planSteps?.length ? planSteps : undefined,
      planStepSeq: planSteps?.length ? planSteps.length : undefined,
      reason: input.reason ?? [],
      findings: input.findings,
      createdBy: input.createdBy,
      createdAt: now,
      updatedAt: now,
      sections: newWorkOrderSections(input.spec, secs, planText),
    } as unknown as Record<string, unknown>) as unknown as StoredWorkOrderDoc;
    doc.reason = doc.reason ?? [];
    const created = await this.docs.create(doc as never, { ...meta, message: meta.message ?? `work order: create ${id ?? '{id}'}` });
    return this.project(created);
  }

  /** Generic update (status, priority, note, sections, reason, re-pin). Closing transitions never validate the pin. */
  async update(id: string, patch: UpdateWorkOrderInput, meta: CommitMeta = {}): Promise<WorkOrder> {
    const full = patch.specCommit ? await this.git.resolveCommit(String(patch.specCommit)) : undefined;
    if (patch.specCommit && !full) throw new ValidationError(`unknown commit '${patch.specCommit}'`);
    const d = await this.modify(
      id,
      (cur) => {
        let next: StoredWorkOrderDoc = { ...cur };
        if (patch.status) next.status = patch.status;
        if (patch.priority !== undefined) next.priority = patch.priority ?? undefined;
        if (patch.note !== undefined) next.note = patch.note ?? undefined;
        if (patch.reason) next.reason = patch.reason;
        if (full) next.specCommit = full;
        if (patch.sections) {
          const wanted = patch.sections.map((s) => ({ id: s.id, status: s.status ?? 'pending' }));
          const kept = cur.sections.filter(isWoSection);
          const woSecs = wanted.map((w) => {
            const ex = kept.find((s) => targetSection(s) === w.id);
            return ex ? { ...ex, status: w.status } : newWorkOrderSections(cur.spec, [{ id: w.id, title: w.id, status: w.status }]).find(isWoSection)!;
          });
          next.sections = [...cur.sections.filter((s) => !isWoSection(s)), ...woSecs];
        }
        if (next.status !== cur.status && !isOpen(next)) next = endClaim(next, endReason(next.status), (meta.date ?? new Date()).toISOString());
        return next;
      },
      meta,
    );
    return this.project(d);
  }

  /** Who may act: anyone while unclaimed, the claiming agent (also with a stale claim of its own), nobody else while fresh. */
  async requireHolder(id: string, agent: string): Promise<WorkOrder> {
    const current = await this.get(id);
    const c = current.claim;
    if (!c || c.agent === agent) return current;
    throw this.otherClaim(id, c);
  }

  /** The error for a claim held by another agent: stale (take it over by claiming) or fresh. */
  private otherClaim(id: string, c: { agent: string; heartbeatAt: string }): Error {
    if (isClaimStale(c)) return new StaleClaimError(`stale_claim: ${id} has a stale claim by ${c.agent} (heartbeat ${c.heartbeatAt}); claim it first to take it over`);
    return new ClaimedError(`claimed: ${id} is claimed by ${c.agent} (heartbeat ${c.heartbeatAt})`);
  }

  /** MW-12: finishing work needs the claim: the caller holds it (fresh or its own stale one). Checked inside the lock. */
  private requireClaim(d: StoredWorkOrderDoc, agent: string): void {
    const c = d.claim;
    if (!c) throw new WorkOrderError('not_claimed', `work order ${d.id} is not claimed: claim it first (work_order_claim)`, { kind: 'work_order', id: d.id });
    if (c.agent !== agent) throw this.otherClaim(d.id, { agent: c.agent, heartbeatAt: this.heartbeatOf(d.id, c) });
  }

  private frozenError(w: Pick<WorkOrder, 'id' | 'status'>) {
    return new WorkOrderError('work_order_frozen', `work order ${w.id} is ${w.status}: closed work orders are frozen (only PR status / merge fields can change: work_order_git_update)`, { kind: 'work_order', status: w.status });
  }

  /** Apply delivery extras (git fields, touched files) to a document. */
  private applyExtras(d: StoredWorkOrderDoc, x: DeliveryExtras): StoredWorkOrderDoc {
    let out = d;
    for (const g of x.git ?? []) out = { ...out, git: mergeGit(out.git ?? [], g as GitContextPatch) };
    if (x.touched?.length) out = { ...out, touched: mergeTouched(out.touched ?? [], x.touched.map(touchedFromInput)) };
    return out;
  }

  /**
   * Claim a work order for an agent (sets it in progress). A fresh claim by another agent is a 409; the plan must be
   * written first (`plan_required`) unless it is a fast-path fix. Re-claiming keeps the claim (branch / worktree
   * updated); taking over pushes the previous claim to `claims`.
   */
  async claim(input: ClaimWorkOrderInput & DeliveryExtras, meta: CommitMeta = {}): Promise<WorkOrder> {
    const { id, agent, branch, worktree } = claimWorkOrderSchema.parse({ id: input.id, agent: input.agent, branch: input.branch, worktree: input.worktree });
    const current = await this.get(id);
    // Claiming reopens a failed work order (failed -> in_progress); done and cancelled are final.
    if (!isOpen(current) && current.status !== 'failed') throw new ConflictError(`work order ${id} is ${current.status}`);
    if (current.claim && current.claim.agent !== agent && !isClaimStale(current.claim)) throw new ClaimedError(`claimed: ${id} is claimed by ${current.claim.agent}`);
    const now = (meta.date ?? new Date()).toISOString();
    const d = await this.modify(
      id,
      (cur) => {
        // MW-13: a failed work order is reopened by claiming it even without a plan (its plan is written afterwards).
        if (!sectionBody(cur, WO_PLAN).trim() && !isFastPath(cur, cur.sections.filter(isWoSection).length) && cur.status !== 'failed') {
          throw new WorkOrderError('plan_required', `work order ${id} has no plan: write the implementation plan first (work_order_plan_set), then claim it. Only fast-path fixes (kind fix, one section, fastPath: true) can be claimed without a plan.`, { kind: 'work_order', id });
        }
        let next: StoredWorkOrderDoc = cur;
        if (cur.claim && cur.claim.agent !== agent) next = endClaim(cur, 'taken_over', now);
        const keep = next.claim && next.claim.agent === agent;
        const claim = { agent, ...(branch ?? next.claim?.branch ? { branch: branch ?? next.claim?.branch } : {}), ...(worktree ?? next.claim?.worktree ? { worktree: worktree ?? next.claim?.worktree } : {}), startedAt: keep ? next.claim!.startedAt : now };
        return this.applyExtras({ ...next, status: 'in_progress', claim } as StoredWorkOrderDoc, input);
      },
      { ...meta, agent: meta.agent ?? agent, message: meta.message ?? `work order: claim ${id}` },
    );
    this.heartbeats.set(id, agent, now);
    return this.project(d);
  }

  /**
   * Refresh the claim's heartbeat (only the claiming agent). Runtime state only: NO commit, unless git fields are
   * given and change the document (then one commit with those fields).
   */
  async heartbeat(input: { id: string; agent: string; git?: GitFieldsInput[] }, meta: CommitMeta = {}): Promise<WorkOrder> {
    const { id, agent } = input;
    const current = await this.get(id);
    if (current.claim?.agent !== agent) throw current.claim ? this.otherClaim(id, current.claim) : new ClaimedError(`claimed: ${id} is not claimed by ${agent}`);
    this.heartbeats.set(id, agent, (meta.date ?? new Date()).toISOString());
    if (input.git?.length) {
      const d = await this.modify(id, (cur) => this.applyExtras(cur, { git: input.git }), { ...meta, agent: meta.agent ?? agent, message: meta.message ?? `work order: git context of ${id}` });
      return this.project(d);
    }
    return this.get(id);
  }

  /** Release the claim (back to pending). */
  async release(input: { id: string; agent: string }, meta: CommitMeta = {}): Promise<WorkOrder> {
    const { id, agent } = input;
    const current = await this.get(id);
    // DF-3: another agent's stale claim is reported as stale (take it over with work_order_claim), never as fresh.
    if (current.claim?.agent !== agent) throw current.claim ? this.otherClaim(id, current.claim) : new WorkOrderError('not_claimed', `work order ${id} is not claimed`, { kind: 'work_order', id });
    const now = (meta.date ?? new Date()).toISOString();
    const d = await this.modify(id, (cur) => ({ ...endClaim(cur, 'released', now), ...(cur.status === 'in_progress' && !allSectionsDone(cur) ? { status: 'pending' as const } : {}) }), {
      ...meta,
      agent: meta.agent ?? agent,
      message: meta.message ?? `work order: release ${id}`,
    });
    this.heartbeats.clear(id);
    return this.project(d);
  }

  /**
   * Write / replace the implementation plan (open work orders; holder or unclaimed). Versioned by git. Steps are data: the
   * checkbox lines of the text (or `steps`) are matched to the existing steps by id (else by identical text), keeping id,
   * status, note and code refs; new steps get new ids (never reused). A done step cannot be removed (`plan_invalid`).
   */
  async planSet(id: string, agent: string, plan: string | undefined, meta: CommitMeta = {}, stepsInput?: PlanStepInput[]): Promise<WorkOrder> {
    const w = await this.requireHolder(id, agent);
    if (!isOpen(w)) throw this.frozenError(w);
    const probe = await this.doc(id);
    const desiredInput = stepsInput?.map(toDesired);
    let links: { targets: string[]; criteria: { id: string }[] } | null = null;
    if (desiredInput?.some((d) => d.sections?.length || d.proves?.length)) {
      const at = await this.specAt(probe.spec, probe.specCommit);
      const targets = probe.sections.filter(isWoSection).map(targetSection);
      links = { targets, criteria: coveredCriteria(at, targets) };
    }
    const now = (meta.date ?? new Date()).toISOString();
    const d = await this.modify(
      id,
      (cur) => {
        const body = sectionBody(cur, WO_PLAN);
        // MW-13: a claimed (in progress) work order keeps a plan: it cannot be emptied after claiming.
        if (cur.claim && plan !== undefined && !plan.trim() && !desiredInput && body.trim()) throw new ValidationError(`work order ${id} is claimed: its plan cannot be emptied`);
        let text = plan !== undefined ? plan.trim() : body;
        const existing = stepsOf(cur, body);
        const parsed = parseStepLines(text);
        const desired: DesiredStep[] = desiredInput ?? parsed.map((p) => ({ ...(p.id ? { id: p.id } : {}), text: p.text, ...(p.status === 'skipped' ? {} : { status: p.status }) }));
        const r = reconcileSteps(existing, desired, cur.planStepSeq ?? 0, { now, by: meta.agent ?? agent });
        const problems = [...r.problems, ...(links ? checkStepLinks(desired, links.targets, links.criteria) : [])];
        if (problems.length) throw new WorkOrderError('plan_invalid', `plan_invalid: ${problems.join('; ')}`, { kind: 'plan', problems }, 400);
        // New steps never start in progress twice.
        let seen = existing.some((s) => s.status === 'in_progress');
        const steps = r.steps.map((s) => (s.status === 'in_progress' && !existing.some((e) => e.id === s.id) ? (seen ? { ...s, status: 'pending' as const } : ((seen = true), s)) : s));
        if (desiredInput) text = replaceStepLines(text, steps);
        else if (parsed.length) {
          const lines = text.split(/\r?\n/);
          parsed.forEach((p, k) => (lines[p.line] = renderStepLine(steps[k]!)));
          text = lines.join('\n');
        }
        const persist = steps.length || cur.planSteps ? { planSteps: steps, planStepSeq: r.seq } : {};
        return { ...cur, ...persist, sections: cur.sections.map((s) => (s.id === WO_PLAN ? { ...s, body: text } : s)) };
      },
      { ...meta, message: meta.message ?? `work order: plan of ${id}` },
    );
    return this.project(d);
  }

  /**
   * Set the status of plan steps (holder of the claim, or any agent when nobody holds it and every section is done).
   * skipped needs a note; one in_progress at a time (a new one moves the previous back to pending); codeRefs are kept on
   * the step and merged into the work order's touched. Older work orders get their steps persisted by the first call.
   */
  async stepSet(
    id: string,
    agent: string,
    changes: { step: string; status: PlanStepStatus; note?: string; codeRefs?: TouchedInput[] }[],
    meta: CommitMeta = {},
  ): Promise<{ workOrder: WorkOrder; warnings: string[] }> {
    const code = changes.map((c) => (c.codeRefs ?? []).map(touchedFromInput));
    return this.locked(async () => {
      const doc = await this.doc(id);
      if (!isOpen(doc)) throw this.frozenError(doc);
      if (!(!doc.claim && allSectionsDone(doc))) this.requireClaim(doc, agent);
      const now = (meta.date ?? new Date()).toISOString();
      const by = meta.agent ?? agent;
      const steps = stepsOf(doc, sectionBody(doc, WO_PLAN)).map((s) => ({ ...s }));
      if (!steps.length) throw new WorkOrderError('no_steps', `work order ${id} has no plan steps: write them with work_order_plan_set (steps) first`, { kind: 'work_order', id }, 400);
      const ids = steps.map((s) => s.id).join(', ');
      if (new Set(changes.filter((c) => c.status === 'in_progress').map((c) => c.step)).size > 1) throw new ValidationError('only one step can be in_progress at a time');
      let touched = doc.touched ?? [];
      const log: string[] = [];
      changes.forEach((c, k) => {
        const s = steps.find((x) => x.id === c.step);
        if (!s) throw new ValidationError(`unknown step ${c.step} (steps: ${ids})`);
        const note = c.note?.trim();
        if (c.status === 'skipped' && !note) throw new WorkOrderError('note_required', `step ${c.step}: skipped needs a note (why it is not needed)`, { kind: 'step', step: c.step }, 400);
        if (c.status === 'in_progress') for (const o of steps) if (o !== s && o.status === 'in_progress' && !changes.some((x) => x.step === o.id)) Object.assign(o, { status: 'pending', updatedAt: now, by });
        Object.assign(s, { status: c.status, updatedAt: now, by, ...(note ? { note } : {}) });
        if (code[k]!.length) {
          s.codeRefs = mergeTouched(s.codeRefs ?? [], code[k]!);
          touched = mergeTouched(touched, code[k]!);
        }
        log.push(`${c.step} ${c.status.replace('_', ' ')}`);
      });
      const d = await this.modify(
        id,
        (cur) => ({
          ...cur,
          planSteps: steps,
          planStepSeq: nextStepSeq(steps, cur.planStepSeq),
          ...(touched.length ? { touched } : {}),
          sections: cur.sections.map((x) => (x.id === WO_PLAN ? { ...x, body: syncStepLines(x.body, steps) } : x)),
        }),
        { ...meta, message: meta.message ?? `work order: step ${log.join(', ')} in ${id}${changes.length === 1 ? ` (${steps.find((x) => x.id === changes[0]!.step)!.text.slice(0, 60)})` : ''}` },
      );
      const warnings: string[] = [];
      if (!unfinishedSteps(steps).length && !allSectionsDone(d)) warnings.push('every plan step is finished: mark the sections done (work_order_section_done with codeRefs)');
      return { workOrder: this.project(d), warnings };
    });
  }

  /** The wo-section for a key: spec section id, wo-section id or a section reference. */
  woSection(d: StoredWorkOrderDoc, key: string): Section {
    const k = woSectionKey(key);
    const hit = d.sections.filter(isWoSection).find((s) => s.id === k || targetSection(s) === k);
    if (!hit) throw new WorkOrderError('unknown_section', `not covered by ${d.id}: ${key}`, { kind: 'section', sections: d.sections.filter(isWoSection).map((s) => targetSection(s)) }, 400);
    return hit;
  }

  /**
   * Mark covered sections done or obsolete, with notes (appended to each section body), code refs (section codeRefs +
   * the work order's touched), deviations and verifications. For implement / update work orders, `done` records
   * implementedCommit = specCommit on the spec sections, in a spec commit carrying the `Work-Order:` trailer.
   * The work order is NOT completed automatically: work_order_complete (outcome) closes it.
   */
  async sectionDone(
    input: { id: string; sections: string[]; status?: 'done' | 'obsolete'; notes?: string; codeRefs?: TouchedInput[]; deviations?: string[]; verifications?: string[]; agent?: string } & DeliveryExtras,
    meta: CommitMeta = {},
  ): Promise<WorkOrder> {
    const { id } = input;
    const status = input.status ?? 'done';
    // MW-11: validate and normalise every input BEFORE the first commit (a bad code ref / git field / verification
    // must not leave the spec commit behind).
    const code = (input.codeRefs ?? []).map(touchedFromInput);
    {
      const probe = await this.doc(id);
      this.applyExtras(probe, input);
      mergeTouched([], code);
      input.sections.forEach((k) => this.woSection(probe, k));
      await this.checkVerifications(probe, input.verifications ?? []);
    }
    // MW-1 / MW-11 / MW-15: the checks, the spec write and the work-order write run under one hold of the write lock,
    // each a read-modify-write of the current document.
    return this.locked(async () => {
      const current = await this.doc(id);
      if (!isOpen(current)) throw this.frozenError(current);
      if (input.agent !== undefined && !(!current.claim && allSectionsDone(current))) this.requireClaim(current, input.agent);
      const picked = input.sections.map((k) => this.woSection(current, k));
      const specIds = picked.map(targetSection);
      // Implementation <-> work order: the code each wo-section touched goes into its spec section's refs / symbols and the
      // section records the work order (implementedBy), in the same spec commit as implementedCommit.
      const codeFor = new Map(picked.map((p) => [targetSection(p), mergeTouched(p.codeRefs ?? [], code)] as const));
      const recordsCommit = current.kind === 'implement' || current.kind === 'update';
      if (status === 'done' && (recordsCommit || (current.kind === 'fix' && [...codeFor.values()].some((c) => c.length)))) {
        await this.specs.modify(
          current.spec,
          (spec) => ({
            ...spec,
            sections: spec.sections.map((s) => {
              if (!specIds.includes(s.id) || s.archived) return s;
              const applied = applyCodeToSection(s, codeFor.get(s.id) ?? []);
              return { ...s, ...(recordsCommit ? { implementedCommit: current.specCommit } : {}), implementedBy: id, refs: applied.refs, symbols: applied.symbols } as typeof s;
            }),
          }),
          {
            ...meta,
            message: `spec(${current.spec}): ${recordsCommit ? 'implemented' : 'fixed'} ${specIds.join(', ')} @${current.specCommit.slice(0, 7)}`,
            trailers: { ...meta.trailers, 'Work-Order': id },
          },
        );
      }
      const finishes = allSectionsDone({ sections: current.sections.map((s) => (picked.some((p) => p.id === s.id) ? ({ ...s, status } as Section) : s)) });
      const d = await this.modify(
        id,
        (cur) => {
          const ids = new Set(picked.map((s) => s.id));
          const sections = cur.sections.map((s) => {
            if (!ids.has(s.id)) return s;
            const notes = input.notes?.trim();
            return {
              ...s,
              status,
              body: notes ? (s.body.trim() ? `${s.body.trim()}\n\n${notes}` : notes) : s.body,
              ...(code.length ? { codeRefs: mergeTouched(s.codeRefs ?? [], code) } : {}),
              ...(input.deviations?.length ? { deviations: [...new Set([...(s.deviations ?? []), ...input.deviations.map((x) => x.trim())])] } : {}),
              ...(input.verifications?.length ? { verifications: [...new Set([...(s.verifications ?? []), ...input.verifications])] } : {}),
            } as Section;
          });
          const next = { ...cur, sections, ...(code.length ? { touched: mergeTouched(cur.touched ?? [], code) } : {}) };
          return this.applyExtras(next, input);
        },
        { ...meta, message: meta.message ?? `work order: ${status} ${specIds.join(', ')} in ${id}${finishes && current.claim && !this.keepClaimOnDone.has(id) ? `; all sections done, claim by ${current.claim.agent} released` : ''}` },
      );
      return this.project(d);
    });
  }

  /**
   * MW-14: wo-section `verifications` are verification results (`mandate://verifications/<id>`, recorded) or criterion
   * references (an existing section of the work order's spec, or of a standard).
   */
  private async checkVerifications(d: StoredWorkOrderDoc, refs: string[]): Promise<void> {
    if (!refs.length) return;
    let ids: Set<string> | null = null;
    for (const ref of refs) {
      const n = parseNodeUri(ref.trim());
      if (n?.kind === 'verifications') {
        ids ??= new Set((await this.verificationIds?.()) ?? []);
        if (this.verificationIds && !ids.has(n.id)) throw new ValidationError(`verifications: ${ref} does not exist`);
        continue;
      }
      if (n?.kind === 'specs' && n.sectionId) {
        if (n.id !== d.spec) throw new ValidationError(`verifications: ${ref} is not a criterion of ${d.spec}`);
        const spec = await this.specs.get(d.spec).catch(() => null);
        if (!spec?.sections.some((s) => s.id === n.sectionId)) throw new ValidationError(`verifications: ${ref} does not exist`);
        continue;
      }
      if (n?.kind === 'standards' && n.sectionId) continue;
      throw new ValidationError(`verifications: '${ref}' is not a verification result (mandate://verifications/<id>) or a criterion reference`);
    }
  }

  /** Merge touched files into the work order (and a section's codeRefs). Idempotent: no commit when nothing changes. */
  async touch(id: string, agent: string, input: { section?: string; files: TouchedInput[] }, meta: CommitMeta = {}): Promise<WorkOrder> {
    const w = await this.requireHolder(id, agent);
    if (!isOpen(w)) throw this.frozenError(w);
    const files = input.files.map(touchedFromInput);
    const d = await this.modify(
      id,
      (cur) => {
        const sec = input.section ? this.woSection(cur, input.section) : null;
        return {
          ...cur,
          touched: mergeTouched(cur.touched ?? [], files),
          sections: sec ? cur.sections.map((s) => (s.id === sec.id ? ({ ...s, codeRefs: mergeTouched(s.codeRefs ?? [], files) } as Section) : s)) : cur.sections,
        };
      },
      { ...meta, message: meta.message ?? `work order: touched ${files.length} file(s) in ${id}` },
    );
    return this.project(d);
  }

  /** Merge git context for one code repo (idempotent). Closed work orders: only pr status / mergedCommit / mergedInto. */
  async gitUpdate(id: string, agent: string, patch: GitFieldsInput, meta: CommitMeta = {}): Promise<WorkOrder> {
    const w = await this.requireHolder(id, agent);
    const d = await this.modify(id, (cur) => this.applyExtras(cur, { git: [patch] }), { ...meta, message: meta.message ?? `work order: git context of ${id} (${patch.repo})` }).catch((e) => {
      if ((e as { code?: string }).code === 'work_order_frozen') throw this.frozenError(w);
      throw e;
    });
    return this.project(d);
  }

  /**
   * Compute touched files and commits from a local checkout of the CODE repo (only when the server can read it, see
   * code-repos.ts), then merge them like work_order_touch + work_order_git_update (commits, headCommit).
   */
  async touchFromCommits(
    id: string,
    agent: string,
    input: { repo: string; commits?: string[]; range?: string; section?: string },
    resolve: CodeRepoResolver | undefined,
    meta: CommitMeta = {},
  ): Promise<{ workOrder: WorkOrder; files: TouchedFile[]; commits: string[] }> {
    const w = await this.requireHolder(id, agent);
    if (!isOpen(w)) throw this.frozenError(w);
    if (!input.commits?.length && !input.range) throw new ValidationError('give commits or range');
    const dir = resolve?.(input.repo) ?? null;
    if (!dir) {
      throw new WorkOrderError(
        'code_repo_unavailable',
        `the server cannot read a local checkout of code repo '${input.repo}' (it only reads repos wired to this project with \`mandate connect\` on the same machine): report the files yourself with work_order_touch and the commits with work_order_git_update`,
        { kind: 'code_repo', repo: input.repo },
        400,
      );
    }
    const { commits, files } = await codeChanges(dir, input.repo, input);
    if (!commits.length) throw new ValidationError(`no commits in ${input.range ?? 'the given list'}`);
    const d = await this.modify(
      id,
      (cur) => {
        const sec = input.section ? this.woSection(cur, input.section) : null;
        return {
          ...cur,
          touched: mergeTouched(cur.touched ?? [], files),
          git: mergeGit(cur.git ?? [], { repo: input.repo, commits, headCommit: commits.at(-1)! }),
          sections: sec ? cur.sections.map((s) => (s.id === sec.id ? ({ ...s, codeRefs: mergeTouched(s.codeRefs ?? [], files) } as Section) : s)) : cur.sections,
        };
      },
      { ...meta, message: meta.message ?? `work order: touched ${files.length} file(s) from ${commits.length} commit(s) of ${input.repo} in ${id}` },
    );
    return { workOrder: this.project(d), files, commits };
  }

  /**
   * Finish a work order: outcome required (input or the outcome section), blocking comments resolved (`open_comments`;
   * non-blocking open threads only warn), every still-pending section marked done (recording implementedCommit), then
   * done (frozen from now on).
   */
  async complete(id: string, agent: string, input: { outcome?: string; reconciliation?: string; codeLinks?: CodeLink[] } & DeliveryExtras = {}, meta: CommitMeta = {}): Promise<{ workOrder: WorkOrder; warnings: string[] }> {
    {
      const probe = await this.doc(id);
      this.applyExtras(probe, input); // MW-11: invalid extras fail before any commit
    }
    // MW-12 / MW-15: the claim and the blocking-comment checks run inside the write lock, right before the writes.
    return this.locked(async () => {
      const doc = await this.doc(id);
      if (!isOpen(doc)) throw new ConflictError(`work order ${id} is ${doc.status}; done and cancelled are final`);
      // Nobody holds the claim and every section is done (auto-released): any agent may complete it.
      if (!(!doc.claim && allSectionsDone(doc))) this.requireClaim(doc, agent);
      const outcome = input.outcome?.trim() || sectionBody(doc, WO_OUTCOME).trim();
      if (!outcome) throw new WorkOrderError('outcome_required', `work order ${id}: give outcome (a summary of what was delivered) to complete it`, { kind: 'work_order', missing: ['outcome'] }, 400);
      const warnings: string[] = [];
      const threads = (await this.comments?.(buildRef({ kind: 'work-orders', id }))) ?? [];
      const open = threads.filter((t) => t.status === 'open');
      const blocking = open.filter((t) => t.blocking);
      if (blocking.length) {
        throw new WorkOrderError('open_comments', `work order ${id} has ${blocking.length} unresolved blocking comment(s): address and resolve them (comment_resolve) first`, {
          kind: 'comments',
          threads: blocking.map((t) => ({ id: t.id, uri: t.uri, target: t.target, author: t.author.agent, body: t.body.slice(0, 300) })),
        });
      }
      const unfinished = unfinishedSteps(stepsOf(doc, sectionBody(doc, WO_PLAN)));
      if (unfinished.length) {
        throw new WorkOrderError(
          'steps_unfinished',
          `steps_unfinished: work order ${id} cannot complete: ${unfinished.length} plan step(s) not finished: ${unfinished.map((s) => `${s.id} (${s.status.replace('_', ' ')}) ${s.text.slice(0, 60)}`).join('; ')}`,
          { kind: 'steps', steps: unfinished.map((s) => ({ id: s.id, text: s.text, status: s.status })) },
        );
      }
      await this.requireProvenCriteria(doc);
      if (open.length) warnings.push(`${open.length} open non-blocking comment thread(s): ${open.map((t) => t.uri).join(', ')}`);
      const pending = doc.sections.filter(isWoSection).filter((s) => (s.status ?? 'pending') === 'pending');
      if (pending.length) {
        this.keepClaimOnDone.add(id);
        try {
          await this.sectionDone({ id, sections: pending.map((s) => s.id), status: 'done' }, meta);
        } finally {
          this.keepClaimOnDone.delete(id);
        }
      }
      const d = await this.modify(
        id,
        (cur) => {
          const sections = cur.sections.map((s) => {
            if (s.id === WO_OUTCOME) return { ...s, body: outcome };
            if (s.id === WO_RECONCILIATION && input.reconciliation?.trim()) return { ...s, body: input.reconciliation.trim() };
            return s;
          });
          // Dirty claims (uncommitted code) made during this work order, linked to the commit that completed it.
          const links = input.codeLinks?.length ? { codeLinks: [...(cur.codeLinks ?? []), ...input.codeLinks.filter((l) => !(cur.codeLinks ?? []).some((c) => c.ref === l.ref))] } : {};
          return this.applyExtras({ ...cur, sections, status: 'done', ...links }, input);
        },
        { ...meta, ...(doc.claim ? {} : { agent: meta.agent ?? agent }), message: meta.message ?? `work order: complete ${id}${doc.claim ? '' : ` (by ${agent}, no claim held: all sections were done)`}` },
      );
      this.heartbeats.clear(id);
      try {
        await this.onCompleted?.(this.project(d), meta);
      } catch {
        // closing the requests is a convenience: a failure leaves them open (request_close)
      }
      if (!(d.touched ?? []).length) warnings.push('no touched code recorded: report the files you changed with work_order_touch');
      return { workOrder: this.project(d), warnings };
    });
  }

  /**
   * Criteria <-> tests: every acceptance criterion an implement / update / fix work order covers needs a passing verification
   * result recorded during the work order (`verification_record`), linked to a test (evidence.test or codeRefs) for `test` criteria.
   */
  private async requireProvenCriteria(doc: StoredWorkOrderDoc): Promise<void> {
    if (!this.verificationRecords || !(doc.kind === 'implement' || doc.kind === 'update' || doc.kind === 'fix')) return;
    const spec = await this.specs.get(doc.spec).catch(() => null);
    const targets = doc.sections.filter(isWoSection).filter((s) => s.status !== 'obsolete').map(targetSection);
    const criteria = coveredCriteria(spec, targets);
    if (!criteria.length) return;
    const specUri = buildRef({ kind: 'specs', id: doc.spec });
    const recs = (await this.verificationRecords()).filter((r) => r.appliedTo === specUri && r.at >= doc.createdAt && r.result !== 'skipped');
    const missing: { criterion: string; title: string; reason: string }[] = [];
    for (const c of criteria) {
      const uri = buildRef({ kind: 'specs', id: doc.spec, sectionId: c.id });
      const mine = recs.filter((r) => r.criterion === uri);
      const last = mine.at(-1);
      const tested = mine.some((r) => r.result === 'pass' && (r.evidence?.test?.trim() || r.codeRefs?.length));
      if (!last) missing.push({ criterion: uri, title: c.title, reason: 'no passing result recorded' });
      else if (last.result === 'fail') missing.push({ criterion: uri, title: c.title, reason: 'the latest result is a failure' });
      else if ((c.method ?? 'test') === 'test' && !tested) missing.push({ criterion: uri, title: c.title, reason: 'the passing result names no test (evidence.test or codeRefs)' });
    }
    if (missing.length) {
      throw new WorkOrderError(
        'criteria_unproven',
        `criteria_unproven: work order ${doc.id} cannot complete: ${missing.length} acceptance criteri${missing.length === 1 ? 'on has' : 'a have'} no test proof: ${missing.map((m) => `${m.criterion.replace('mandate://', '')} (${m.reason})`).join('; ')}`,
        { kind: 'criteria', missing },
      );
    }
  }

  /** Fail or cancel a work order (closing transitions never validate the pin; the claim is moved to `claims`). */
  async close(id: string, status: 'failed' | 'cancelled', agent: string, note: string | undefined, meta: CommitMeta = {}): Promise<WorkOrder> {
    const current = await this.requireHolder(id, agent);
    const notes = note ? [current.note, `${status}: ${note}`].filter(Boolean).join('\n') : current.note;
    const w = await this.update(id, { status, ...(notes ? { note: notes } : {}) }, { ...meta, message: meta.message ?? `work order: ${status === 'failed' ? 'fail' : 'cancel'} ${id}` });
    this.heartbeats.clear(id);
    return w;
  }

  /**
   * Atomically pick and claim the next eligible work order: open, unclaimed (or stale, or already the caller's), with a
   * plan (or a fast-path fix), none of its pending sections blocked or broken, matching the filters; by priority (p0
   * first), then age. Concurrent callers never get the same item (the claim check runs inside the write lock).
   */
  async next(
    filters: { kinds?: WorkOrder['kind'][]; spec?: string; priority?: string[]; specs?: (s: StoredSpec) => boolean },
    claim: { agent: string; branch?: string; worktree?: string },
    meta: CommitMeta = {},
  ): Promise<{ workOrder: WorkOrder | null; skipped: { id: string; reason: string }[] }> {
    const skipped: { id: string; reason: string }[] = [];
    const rank = (w: WorkOrder) => (w.priority ? Number(w.priority.slice(1)) : 9);
    const candidates = (await this.list())
      .filter((w) => isOpen(w))
      .filter((w) => !filters.kinds?.length || filters.kinds.includes(w.kind))
      .filter((w) => !filters.spec || w.spec === filters.spec)
      .filter((w) => !filters.priority?.length || (w.priority && filters.priority.includes(w.priority)))
      .filter((w) => !w.claim || w.claim.agent === claim.agent || isClaimStale(w.claim))
      .filter((w) => !w.sections.length || !w.sections.every((x) => x.status === 'done' || x.status === 'obsolete'))
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
      if (!w.hasPlan && !isFastPath(w)) {
        skipped.push({ id: w.id, reason: 'no plan yet (work_order_plan_set, then claim)' });
        continue;
      }
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
        if (e instanceof WorkOrderError && e.code === 'plan_required') {
          skipped.push({ id: w.id, reason: 'no plan yet (work_order_plan_set, then claim)' });
          continue;
        }
        throw e;
      }
    }
    return { workOrder: null, skipped };
  }

  /** Cancel the open work orders of an archived spec; mark pending sections that were archived obsolete. */
  async afterSpecWrite(spec: StoredSpec, meta: CommitMeta = {}): Promise<void> {
    for (const w of await this.list()) {
      if (w.spec !== spec.id || !isOpen(w)) continue;
      if (!(await this.docs.raw(w.id))) continue; // legacy, not migrated yet
      if (spec.status === 'archived') {
        await this.update(w.id, { status: 'cancelled' }, { ...meta, message: `work order: cancel ${w.id} (spec archived)` });
        continue;
      }
      const archived = new Set(spec.sections.filter((s) => s.archived).map((s) => s.id));
      if (w.sections.some((s) => s.status === 'pending' && archived.has(s.id))) {
        const sections = w.sections.map((s) => (s.status === 'pending' && archived.has(s.id) ? { ...s, status: 'obsolete' as const } : s));
        // Every section archived: nothing left to do.
        const allObsolete = sections.every((s) => s.status === 'obsolete');
        await this.update(w.id, { sections, ...(allObsolete ? { status: 'cancelled' as const } : {}) }, { ...meta, message: `work order: ${w.id} sections archived` });
      }
    }
  }

  /** The resolved work order: sections at specCommit, plan / notes / code, comments, dependency graph. */
  async resolve(id: string, opts: Omit<WorkOrderDependenciesInput, 'id'> = {}): Promise<ResolvedWorkOrder> {
    const { at: depAt, depth } = workOrderDependenciesInputSchema.parse({ ...opts, id });
    const item = await this.get(id);
    const doc = await this.docs.get(id).catch(() => docFromLegacy(item));
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
    const uri = buildRef({ kind: 'work-orders', id });
    const threads = (await this.comments?.(uri)) ?? [];
    const history = sectionBody(doc, WO_HISTORY);
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
      doc: {
        plan: sectionBody(doc, WO_PLAN),
        reconciliation: sectionBody(doc, WO_RECONCILIATION),
        outcome: sectionBody(doc, WO_OUTCOME),
        ...(history ? { history } : {}),
        sections: doc.sections.filter(isWoSection).map((s) => ({
          id: s.id,
          uri: buildRef({ kind: 'work-orders', id, sectionId: s.id }),
          target: s.target ?? '',
          title: s.title,
          status: s.status ?? 'pending',
          notes: s.body,
          verifications: s.verifications ?? [],
          codeRefs: s.codeRefs ?? [],
          deviations: s.deviations ?? [],
        })),
      },
      comments: {
        counts: { open: threads.filter((t) => t.status === 'open').length, openBlocking: threads.filter((t) => t.status === 'open' && t.blocking).length, resolved: threads.filter((t) => t.status === 'resolved').length },
        threads: threads.filter((t) => t.status === 'open'),
      },
      claims: doc.claims ?? [],
      git: doc.git ?? [],
      touched: doc.touched ?? [],
    };
  }

  historyOf(id: string) {
    return this.history.mentioning(id);
  }

  /**
   * Other open work orders that touched files this one touches or is about to touch (its `touched` plus the code refs
   * of its targeted spec sections): `claim_overlap` warnings on claim.
   */
  async overlaps(id: string): Promise<{ workOrder: string; status: string; agent?: string; files: string[] }[]> {
    const me = await this.get(id);
    const spec = await this.specs.get(me.spec).catch(() => null);
    const targets = new Set(me.sections.map((s) => s.id));
    const mine = new Set([
      ...(me.touched ?? []).map((t) => `${t.repo}:${t.path}`),
      ...(spec?.sections ?? []).filter((s) => targets.has(s.id)).flatMap((s) => s.refs.map((r) => `${r.repo}:${r.path.replace(/^\.?\/+/, '')}`)),
    ]);
    if (!mine.size) return [];
    return (await this.list())
      .filter((w) => w.id !== id && isOpen(w))
      .map((w) => ({ workOrder: w.id, status: w.status, ...(w.claim ? { agent: w.claim.agent } : {}), files: [...new Set((w.touched ?? []).map((t) => `${t.repo}:${t.path}`))].filter((f) => mine.has(f)) }))
      .filter((x) => x.files.length);
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

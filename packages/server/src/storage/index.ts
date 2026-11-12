import { auditSchema, type StoredAudit, componentSchema, type StoredComponent, verificationRecordSchema, type VerificationRecord, feedbackSchema, workOrderDocSchema, specSchema, standardSchema, type StoredFeedback, type StoredWorkOrderDoc, type WorkOrder, type StoredSpec, type StoredStandard } from '@mandate/shared';
import type { GitStore } from '../git/GitStore.js';
import type { DocFormat } from '@mandate/doc';
import { auditCodec, auditFormat, componentCodec, componentFormat, specCodec, specFormat, standardCodec, standardFormat, workOrderCodec, workOrderFormat } from './codecs.js';
import { CommentService } from './comments.js';
import { QuestionService } from './questions.js';
import { MemoryHeartbeats, type HeartbeatStore } from './heartbeats.js';
import { HistoryService } from './history.js';
import { JsonlFileRepository } from './JsonlFileRepository.js';
import { MarkdownDirRepository } from './MarkdownDirRepository.js';
import { Mutex } from './Mutex.js';
import { resolveCauses } from './causes.js';
import { WorkOrderService } from './work-orders.js';
import { DependencyService } from './dependencies.js';
import { FeedbackService } from './feedback.js';
import { VerificationService } from './verification.js';
import { LinkService } from './links.js';
import { DocRules } from './doc-rules.js';
import { IntegrityService, type IntegrityKind } from './integrity.js';
import { ArchitectureService } from './components.js';
import { waiverPolicy, type Model } from './model.js';
import { AuditService } from './audits.js';
import { LineageAnnotationService } from './lineage-annotations.js';
import { INTEGRITY_SNOOZES_FILE, integritySnoozeSchema, LINEAGE_ANNOTATIONS_FILE, lineageAnnotationSchema, type IntegritySnooze, type LineageAnnotation } from '@mandate/shared';
import { IntegritySnoozeService } from './integrity-snoozes.js';

export interface Storage {
  git: GitStore;
  /** Serializes all working-tree writes, commits and syncs. */
  lock: Mutex;
  specs: MarkdownDirRepository<StoredSpec>;
  standards: MarkdownDirRepository<StoredStandard>;
  /** Architecture components (`components/<id>.md`). */
  components: MarkdownDirRepository<StoredComponent>;
  /** Work orders, projected (`WorkOrder`): list / get. The documents are `workOrderDocs`. */
  workOrders: { list(): Promise<WorkOrder[]>; get(id: string): Promise<WorkOrder> };
  /** Work-order documents (`work-orders/<id>.md`). */
  workOrderDocs: MarkdownDirRepository<StoredWorkOrderDoc>;
  /** Claim heartbeats (runtime state, never committed). */
  heartbeats: HeartbeatStore;
  /** Comment threads (`comments.jsonl`, append-only). */
  commentService: CommentService;
  /** Questions agents ask the user (`questions.jsonl`, append-only). */
  questionService: QuestionService;
  history: HistoryService;
  /** Work-order rules (validation, derived status) on top of `workOrders`. */
  workOrderService: WorkOrderService;
  /** @deprecated Alias of `workOrderService`. */
  readonly queueService: WorkOrderService;
  feedback: JsonlFileRepository<StoredFeedback>;
  /** Feedback rules (target validation, derived `applied`). */
  feedbackService: FeedbackService;
  verifications: JsonlFileRepository<VerificationRecord>;
  /** Verification results, derived criterion states and the done gate. */
  verificationService: VerificationService;
  /** Section links: validation, backlinks, blocked / upstream changed. */
  linkService: LinkService;
  /** Write-time rules of specs and standards (transitions, identity, links, gate). */
  docRules: DocRules;
  /** Repo lint after pulls / merges (I7). */
  integrity: IntegrityService;
  /** Generated architecture view (`architectureGet`). */
  architecture: ArchitectureService;
  /** Audit reports (`audits/<id>.md`). */
  audits: MarkdownDirRepository<StoredAudit>;
  /** Audit plans, report writes (frozen after completion), derived state (outcome, staleness, links). */
  auditService: AuditService;
  /** Lineage annotations (`lineage.jsonl`, append-only): causes recorded after the fact for past commits. */
  lineageAnnotations: JsonlFileRepository<LineageAnnotation>;
  lineageAnnotationService: LineageAnnotationService;
  /** Acknowledged integrity warnings (`integrity-snoozes.jsonl`, append-only). */
  integritySnoozes: IntegritySnoozeService;
  /** Snapshot of all documents, work orders and feedback (with feedback authors). */
  model(): Promise<Model>;
}

export interface StorageOptions {
  /** Where claim heartbeats live (default: in memory). */
  heartbeats?: HeartbeatStore;
  /** The project's write lock (default: in-process; Postgres deployments: a shared advisory lock, db/write-lock.ts). */
  lock?: Mutex;
}

export function createStorage(git: GitStore, opts: StorageOptions = {}): Storage {
  const lock = opts.lock ?? new Mutex();
  // Integrity: the gate + incremental update run inside the write lock of every repository (wired below).
  let integrityRef: IntegrityService | undefined;
  const hook = <T extends { id: string }>(kind: IntegrityKind | null) => ({
    check: (next: T, current: T | undefined) => integrityRef?.hook<T>(kind).check(next, current) ?? Promise.resolve(undefined),
    committed: (token: unknown, sha: string | null) => integrityRef?.hook<T>(kind).committed(token, sha),
  });
  // Former document ids (git history) are never reused, also by generated ids.
  const everIds = (dir: string) => async (id: string) => (await git.fileHistory([dir])).has(`${dir}/${id}.md`);
  const heartbeats = opts.heartbeats ?? new MemoryHeartbeats();
  // Every commit is checked against closed feedback (no new `Feedback:` trailers for closed items).
  let feedbackService: FeedbackService | undefined;
  let verificationService: VerificationService | undefined;
  let linkService: LinkService | undefined;
  let docRules: DocRules | undefined;
  let workOrderService: WorkOrderService | undefined;
  const beforeCommit = (message: string) => feedbackService?.guardCommit(message) ?? Promise.resolve();
  const specs = new MarkdownDirRepository('specs', specCodec, {
    label: 'spec',
    integrity: hook<StoredSpec>('specs'),
    idTaken: everIds('specs'),
    schema: specSchema,
    git,
    lock,
    beforeCommit,
    noDelete: 'specs are never deleted; set status archived',
    // Transitions, identity, links, criteria shrink and the done gate (inside the write lock).
    beforeWrite: (next, current, ctx) => docRules?.beforeWrite('specs', next, current, ctx) ?? Promise.resolve(next),
    // Archiving cascades to work orders (cancel; archived sections become obsolete).
    // MW-23: the cascade keeps the write's attribution (trailers, branch) and reports its commits (onCommit).
    afterWrite: (spec, _current, meta) => workOrderService?.afterSpecWrite(spec, { ...meta, message: undefined }) ?? Promise.resolve(),
  });
  const workOrderDocs = new MarkdownDirRepository<StoredWorkOrderDoc>('work-orders', workOrderCodec, {
    label: 'work order',
    integrity: hook<StoredWorkOrderDoc>('work-orders'),
    sequence: { prefix: 'q' },
    idTaken: everIds('work-orders'),
    schema: workOrderDocSchema as never,
    git,
    lock,
    idTrailer: 'Work-Order',
    beforeCommit,
    noDelete: 'work orders are never deleted; cancel them (work_order_cancel)',
    // Structure, transitions, the freeze of closed work orders, claims, pins (inside the write lock).
    beforeWrite: (next, current, ctx) => workOrderService!.beforeWrite(next, current, ctx),
  });
  const history = new HistoryService(git, ['specs', 'standards', 'components', 'audits', 'work-orders'], {
    specs: specFormat as DocFormat<unknown, unknown>,
    standards: standardFormat as DocFormat<unknown, unknown>,
    components: componentFormat as DocFormat<unknown, unknown>,
    audits: auditFormat as DocFormat<unknown, unknown>,
    'work-orders': workOrderFormat as DocFormat<unknown, unknown>,
  });
  let auditService: AuditService | undefined;
  const audits = new MarkdownDirRepository<StoredAudit>('audits', auditCodec, {
    label: 'audit',
    integrity: hook<StoredAudit>('audits'),
    schema: auditSchema as never,
    git,
    lock,
    beforeCommit,
    noDelete: 'audits are never deleted; abandon an audit in progress (audit_abandon)',
    beforeWrite: (next, current, ctx) => auditService!.beforeWrite(next, current, ctx),
  });
  const components = new MarkdownDirRepository('components', componentCodec, {
    label: 'component',
    integrity: hook<StoredComponent>('components'),
    idTaken: everIds('components'),
    schema: componentSchema,
    git,
    lock,
    beforeCommit,
    noDelete: 'components are never deleted; set status deprecated',
    beforeWrite: (next, current, ctx) => docRules?.beforeWrite('components', next, current, ctx) ?? Promise.resolve(next),
  });
  const standards = new MarkdownDirRepository('standards', standardCodec, {
    label: 'standard',
    integrity: hook<StoredStandard>('standards'),
    idTaken: everIds('standards'),
    schema: standardSchema,
    git,
    lock,
    beforeCommit,
    noDelete: 'standards are never deleted; archive their sections or supersede them',
    beforeWrite: (next, current, ctx) => docRules?.beforeWrite('standards', next, current, ctx) ?? Promise.resolve(next),
  });
  const feedback = new JsonlFileRepository<StoredFeedback>('feedback.jsonl', {
    label: 'feedback',
    integrity: hook<StoredFeedback>(null),
    sequence: { prefix: 'fb' },
    schema: feedbackSchema as never,
    git,
    lock,
    stamp: true,
    idTrailer: 'Feedback-Item',
    beforeCommit,
    beforeWrite: async (next, current) => {
      await feedbackService?.check(next, current);
    },
  });
  const verifications = new JsonlFileRepository<VerificationRecord>('verifications.jsonl', {
    label: 'verification',
    integrity: hook<VerificationRecord>(null),
    sequence: { prefix: 'vr' },
    schema: verificationRecordSchema as never,
    git,
    lock,
    stamp: false,
    idTrailer: 'Verification',
    beforeCommit,
    appendOnly: true,
    beforeWrite: async (next) => {
      await verificationService?.check(next);
    },
  });
  verificationService = new VerificationService(verifications, specs, standards, git, history);
  const lineageAnnotations = new JsonlFileRepository<LineageAnnotation>(LINEAGE_ANNOTATIONS_FILE, {
    label: 'lineage annotation',
    integrity: hook<LineageAnnotation>(null),
    sequence: { prefix: 'la' },
    schema: lineageAnnotationSchema as never,
    git,
    lock,
    stamp: false,
    idTrailer: 'Lineage-Annotation',
    beforeCommit,
    appendOnly: true,
  });
  const snoozeRepo = new JsonlFileRepository<IntegritySnooze>(INTEGRITY_SNOOZES_FILE, {
    label: 'integrity snooze',
    integrity: hook<IntegritySnooze>(null),
    sequence: { prefix: 'is' },
    schema: integritySnoozeSchema as never,
    git,
    lock,
    stamp: false,
    idTrailer: 'Integrity-Snooze',
    beforeCommit,
    appendOnly: true,
  });
  linkService = new LinkService(specs, standards, git);
  workOrderService = new WorkOrderService(workOrderDocs, specs, git, history, heartbeats);
  const wos = workOrderService;
  const workOrders = { list: () => wos.list(), get: (id: string) => wos.get(id) };
  const commentService = new CommentService(git, lock, beforeCommit, hook(null));
  commentService.wire({
    workOrders: wos,
    docExists: async (kind, id, section) => {
      const repo = kind === 'specs' ? specs : kind === 'standards' ? standards : kind === 'components' ? components : kind === 'audits' ? audits : kind === 'work-orders' ? workOrderDocs : null;
      const doc = repo ? await (repo as unknown as MarkdownDirRepository<{ id: string; sections: { id: string }[] }>).get(id).catch(() => null) : null;
      return !!doc && (!section || doc.sections.some((s) => s.id === section));
    },
  });
  wos.comments = (uri) => commentService.threads(uri);
  const questionService = new QuestionService(git, lock, beforeCommit, hook(null));
  const dependencyService = new DependencyService(specs, standards, workOrders, git);
  dependencyService.components = components;
  workOrderService.dependencies = (item, opts) => dependencyService.tree(item, opts);
  workOrderService.blockedSections = async (spec) => (await linkService!.blockedSections([spec]))[spec.id] ?? [];
  workOrderService.brokenSections = async (spec) => (await linkService!.brokenSections([spec]))[spec.id] ?? [];
  workOrderService.feedback = () => feedback.list();
  workOrderService.lock = lock;
  workOrderService.verificationIds = async () => (await verifications.list()).map((v) => v.id);
  linkService.components = components;
  feedbackService = new FeedbackService(feedback, { specs, standards, components }, git, history, {
    specs: specFormat as DocFormat<unknown, unknown>,
    standards: standardFormat as DocFormat<unknown, unknown>,
    components: componentFormat as DocFormat<unknown, unknown>,
  });
  feedbackService.verifications = () => verifications.list();
  const fs = feedbackService;
  const model = async (): Promise<Model> => {
    const authors = await fs.authors_();
    // Acceptors are only derived while the held acceptor rule is on (history reads).
    const acceptors = waiverPolicy.acceptorMustDiffer ? await fs.acceptors_() : new Map<string, string | null>();
    return {
      specs: await specs.list(),
      standards: await standards.list(),
      components: await components.list(),
      workOrders: await workOrders.list(),
      feedback: await feedback.list(),
      feedbackAuthor: (id) => authors.get(id) ?? null,
      feedbackAcceptor: (id) => acceptors.get(id) ?? null,
    };
  };
  linkService.model = model;
  verificationService.model = model;
  docRules = new DocRules({
    specs,
    standards,
    components,
    git,
    links: linkService,
    verification: verificationService,
    model,
    workOrders: () => workOrders.list(),
    feedback: () => feedback.list(),
    verifications: () => verifications.list(),
    acceptorOf: (id) => fs.acceptorOf(id),
  });
  const integrity = new IntegrityService(git, model, feedbackService, lock, { audits: () => audits.list(), drift: (spec, m) => verificationService!.drift(spec, m) });
  integrityRef = integrity;
  const architecture = new ArchitectureService(git, model, { verification: verificationService, links: linkService });
  auditService = new AuditService(audits, { specs, standards, git, verification: verificationService, workOrders: workOrderService, model, lock });
  const causeStorage = { git, specs, standards, components, feedback, workOrders, audits, verifications, commentService, questionService };
  questionService.resolve = async (uri) => (await resolveCauses(causeStorage, uri))[0]!;
  feedbackService.resolveRef = (uri) => resolveCauses(causeStorage, uri);
  feedbackService.audit = (id) => audits.get(id).catch(() => null) as never;
  return {
    git,
    lock,
    specs,
    standards,
    components,
    feedback,
    feedbackService,
    verifications,
    verificationService,
    linkService,
    docRules,
    integrity,
    architecture,
    audits,
    auditService,
    lineageAnnotations,
    lineageAnnotationService: new LineageAnnotationService(lineageAnnotations, git, () => causeStorage),
    integritySnoozes: new IntegritySnoozeService(snoozeRepo, () => integrity),
    model,
    workOrders,
    workOrderDocs,
    heartbeats,
    commentService,
    questionService,
    history,
    workOrderService,
    /** @deprecated Alias of `workOrderService` (until the index code is renamed). */
    get queueService() {
      return workOrderService;
    },
  };
}

export * from './GitBackedRepository.js';
export { componentCodec, componentFormat, sectionTypes, specCodec, specFormat, standardCodec, standardFormat, workOrderCodec, workOrderFormat } from './codecs.js';
export { HistoryService, parseCommitMessage } from './history.js';
export { WorkOrderService } from './work-orders.js';
export { computeDependencyTree, DependencyService } from './dependencies.js';
export { FeedbackService } from './feedback.js';
export { DoneGateError, VerificationService } from './verification.js';
export { DocRules } from './doc-rules.js';
export { deriveSpecs, derivedStatus } from './insights.js';
export { IntegrityService, IntegrityViolationError, checkIntegrity, collectIntegrity, coveredBy, docOf } from './integrity.js';
export * as model from './model.js';
export { newId, ulid, criterionHash, isFullSha } from './ids.js';
export { ClaimedError, WorkOrderError } from './work-orders.js';
export { CommentService } from './comments.js';
export { QuestionService, QuestionError } from './questions.js';
export { MemoryHeartbeats, SqliteHeartbeats, type HeartbeatStore } from './heartbeats.js';
export { migrateWorkOrders, workOrdersAt } from './work-order-docs.js';
export { LinkService } from './links.js';
export { JsonlFileRepository } from './JsonlFileRepository.js';
export { MarkdownDirRepository, type FileCodec } from './MarkdownDirRepository.js';
export { setSpecStatus } from './spec-status.js';
export { rulesForCode } from './rules.js';
export { ArchitectureService, componentRules, coverage, deriveComponents, toMermaid } from './components.js';
export { resolveReference } from './refs.js';
export { AuditError, AuditService, auditCounts, auditOutcome } from './audits.js';

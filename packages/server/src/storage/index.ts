import { componentSchema, type StoredComponent, verificationRecordSchema, type VerificationRecord, feedbackSchema, workOrderSchema, specSchema, standardSchema, type StoredFeedback, type WorkOrder, type StoredSpec, type StoredStandard } from '@mandate/shared';
import type { GitStore } from '../git/GitStore.js';
import type { DocFormat } from '@mandate/doc';
import { componentCodec, componentFormat, specCodec, specFormat, standardCodec, standardFormat } from './codecs.js';
import { HistoryService } from './history.js';
import { JsonlFileRepository } from './JsonlFileRepository.js';
import { MarkdownDirRepository } from './MarkdownDirRepository.js';
import { Mutex } from './Mutex.js';
import { WorkOrderService } from './work-orders.js';
import { DependencyService } from './dependencies.js';
import { FeedbackService } from './feedback.js';
import { VerificationService } from './verification.js';
import { LinkService } from './links.js';
import { DocRules } from './doc-rules.js';
import { IntegrityService } from './insights.js';
import { ArchitectureService } from './components.js';
import type { Model } from './model.js';

export interface Storage {
  git: GitStore;
  /** Serializes all working-tree writes, commits and syncs. */
  lock: Mutex;
  specs: MarkdownDirRepository<StoredSpec>;
  standards: MarkdownDirRepository<StoredStandard>;
  /** Architecture components (`components/<id>.md`). */
  components: MarkdownDirRepository<StoredComponent>;
  workOrders: JsonlFileRepository<WorkOrder>;
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
  /** Snapshot of all documents, work orders and feedback (with feedback authors). */
  model(): Promise<Model>;
}

export function createStorage(git: GitStore): Storage {
  const lock = new Mutex();
  // Every commit is checked against closed feedback (no new `Feedback:` trailers for closed items).
  let feedbackService: FeedbackService | undefined;
  let verificationService: VerificationService | undefined;
  let linkService: LinkService | undefined;
  let docRules: DocRules | undefined;
  let workOrderService: WorkOrderService | undefined;
  const beforeCommit = (message: string) => feedbackService?.guardCommit(message) ?? Promise.resolve();
  const specs = new MarkdownDirRepository('specs', specCodec, {
    label: 'spec',
    schema: specSchema,
    git,
    lock,
    beforeCommit,
    noDelete: 'specs are never deleted; set status archived',
    // Transitions, identity, links, criteria shrink and the done gate (inside the write lock).
    beforeWrite: (next, current, ctx) => docRules?.beforeWrite('specs', next, current, ctx) ?? Promise.resolve(next),
    // Archiving cascades to work orders (cancel; archived sections become obsolete).
    afterWrite: (spec, _current, meta) => workOrderService?.afterSpecWrite(spec, { agent: meta.agent, author: meta.author }) ?? Promise.resolve(),
  });
  const workOrders = new JsonlFileRepository('work-orders.jsonl', {
    label: 'work order',
    schema: workOrderSchema,
    git,
    lock,
    stamp: true,
    idTrailer: 'Work-Order',
    beforeCommit,
    beforeWrite: async (next, current) => {
      await workOrderService?.check(next, current);
    },
  });
  const history = new HistoryService(git, ['specs', 'standards', 'components'], {
    specs: specFormat as DocFormat<unknown, unknown>,
    standards: standardFormat as DocFormat<unknown, unknown>,
    components: componentFormat as DocFormat<unknown, unknown>,
  });
  const components = new MarkdownDirRepository('components', componentCodec, {
    label: 'component',
    schema: componentSchema,
    git,
    lock,
    beforeCommit,
    noDelete: 'components are never deleted; set status deprecated',
    beforeWrite: (next, current, ctx) => docRules?.beforeWrite('components', next, current, ctx) ?? Promise.resolve(next),
  });
  const standards = new MarkdownDirRepository('standards', standardCodec, {
    label: 'standard',
    schema: standardSchema,
    git,
    lock,
    beforeCommit,
    noDelete: 'standards are never deleted; archive their sections or supersede them',
    beforeWrite: (next, current, ctx) => docRules?.beforeWrite('standards', next, current, ctx) ?? Promise.resolve(next),
  });
  const feedback = new JsonlFileRepository<StoredFeedback>('feedback.jsonl', {
    label: 'feedback',
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
  linkService = new LinkService(specs, standards, git);
  workOrderService = new WorkOrderService(workOrders, specs, git, history);
  const dependencyService = new DependencyService(specs, standards, workOrders, git);
  dependencyService.components = components;
  workOrderService.dependencies = (item, opts) => dependencyService.tree(item, opts);
  workOrderService.blockedSections = async (spec) => (await linkService!.blockedSections([spec]))[spec.id] ?? [];
  workOrderService.brokenSections = async (spec) => (await linkService!.brokenSections([spec]))[spec.id] ?? [];
  workOrderService.feedback = () => feedback.list();
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
    return {
      specs: await specs.list(),
      standards: await standards.list(),
      components: await components.list(),
      workOrders: await workOrders.list(),
      feedback: await feedback.list(),
      feedbackAuthor: (id) => authors.get(id) ?? null,
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
  });
  const integrity = new IntegrityService(git, model, feedbackService);
  const architecture = new ArchitectureService(git, model, { verification: verificationService, links: linkService });
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
    model,
    workOrders,
    history,
    workOrderService,
    /** @deprecated Alias of `workOrderService` (until the index code is renamed). */
    get queueService() {
      return workOrderService;
    },
  };
}

export * from './GitBackedRepository.js';
export { componentCodec, componentFormat, sectionTypes, specCodec, specFormat, standardCodec, standardFormat } from './codecs.js';
export { HistoryService, parseCommitMessage } from './history.js';
export { WorkOrderService } from './work-orders.js';
export { computeDependencyTree, DependencyService } from './dependencies.js';
export { FeedbackService } from './feedback.js';
export { DoneGateError, VerificationService } from './verification.js';
export { DocRules } from './doc-rules.js';
export { deriveSpecs, derivedStatus, IntegrityService } from './insights.js';
export * as model from './model.js';
export { newId, ulid, criterionHash, isFullSha } from './ids.js';
export { ClaimedError } from './work-orders.js';
export { LinkService } from './links.js';
export { JsonlFileRepository } from './JsonlFileRepository.js';
export { MarkdownDirRepository, type FileCodec } from './MarkdownDirRepository.js';
export { setSpecStatus } from './spec-status.js';
export { rulesForCode } from './rules.js';
export { ArchitectureService, componentRules, coverage, deriveComponents, toMermaid } from './components.js';
export { resolveReference } from './refs.js';

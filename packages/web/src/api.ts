import { primeContributors } from './lib/people';
import { buildRef, type RefKind } from '@mandate/shared/refs';
import { callTool, McpToolError } from './mcp/client';
import type { CommentCounts, CommentThread, StoredWorkOrderDoc, AutoPushStatus, ArchitectureGraph, GitCommitInfo, DocFeedback, EntityKind, Feedback, FileVersion, ResolvedFeedback, ResolvedWorkOrder, SectionImplementation, StandardUsage, GitStatus, GitSyncResult, HistoryEntry, WorkOrder, SectionTypeInfo, Spec, Standard } from '@mandate/shared';

/** Any stored entity; work orders carry extra fields. */
export type Entity = Spec | Standard | WorkOrder | Feedback;

type DocKind = 'specs' | 'standards' | 'components' | 'audits' | 'work-orders';

/** Drop undefined / empty values: tool inputs are strict. */
const compact = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== '' && v !== false && v !== null));
const call = <T>(tool: string, args: Record<string, unknown> = {}) => callTool<T>(tool, args);
/** Get results carry `contributors`: hand them to the people stacks (no second call). */
const primed =
  (kind: string, id: string) =>
  <T>(r: T): T => {
    const list = (r as { contributors?: unknown } | null)?.contributors;
    if (list) primeContributors(buildRef({ kind: kind as RefKind, id }), list);
    return r;
  };
const historyOf = (kind: RefKind, id: string) => call<{ entries: HistoryEntry[] }>('history_get', { ref: buildRef({ kind, id }), limit: 500 }).then((r) => r.entries);

/** Read-only client over MCP tools (the web UI never writes; agents write through MCP). */
export const api = {
  list: (kind: EntityKind) => call<{ items: Entity[] }>('doc_list', { kind }).then((r) => r.items),
  get: (kind: EntityKind, id: string): Promise<Entity> =>
    (kind === 'work-orders' ? call<Entity>('get', { of: 'work-orders', ref: id }) : kind === 'feedback' ? call<Entity>('get', { of: 'feedback', ref: id }) : call<Entity>('doc_get', { kind, id })).then(primed(kind, id)),
  history: (kind: DocKind, id: string) => historyOf(kind, id),
  version: (kind: DocKind, id: string, commit: string, against: 'parent' | 'head' = 'parent', base?: string) =>
    call<FileVersion>('version_get', compact({ kind, id, commit, against: against === 'head' ? 'head' : undefined, base })),
  standardUsage: (id: string) => call<{ items: StandardUsage[] }>('standard_usage', { id }).then((r) => r.items),
  /** The file's text, or null when it does not exist. */
  raw: async (kind: DocKind, id: string): Promise<string | null> => {
    try {
      return (await call<{ text: string | null }>('doc_raw', { kind, id })).text;
    } catch (e) {
      if (e instanceof McpToolError && e.code === 'not_found') return null;
      throw e;
    }
  },
  workOrder: (id: string, at?: string) => call<ResolvedWorkOrder>('get', compact({ of: 'work-orders', ref: id, at })).then(at ? (r) => r : primed('work-orders', id)),
  workOrderHistory: (id: string) => historyOf('work-orders', id),
  /** The work-order document (`doc_get`): stored doc + git meta + `workOrder` (the resolved view). */
  workOrderDoc: (id: string) => call<StoredWorkOrderDoc & { workOrder: ResolvedWorkOrder; lastCommit?: string | null; versionCount?: number; updatedBy?: string | null }>('doc_get', { kind: 'work-orders', id }),
  /** Comment threads on a target and its sections (`list` of comments). */
  comments: (target: string, includeResolved = true) => call<{ target: string; counts: CommentCounts; threads: CommentThread[] }>('list', { of: 'comments', target, includeResolved }),
  implementation: (specId: string) => call<{ sections: SectionImplementation }>('spec_implementation', { id: specId }).then((r) => r.sections),
  feedbackItem: (id: string) => call<ResolvedFeedback>('get', { of: 'feedback', ref: id }).then(primed('feedback', id)),
  feedbackHistory: (id: string) => historyOf('feedback', id),
  docFeedback: (kind: 'specs' | 'standards', id: string) => call<DocFeedback>('doc_feedback', { kind, id }),
  sectionTypes: () => call<{ items: SectionTypeInfo[] }>('section_types').then((r) => r.items),
  gitStatus: () => call<GitStatus>('git_status'),
  /** Fetch + pull only, never push. */
  gitPull: () => call<GitSyncResult>('git_pull'),
  /** Push local commits now (normally automatic); never force. */
  gitPush: () => call<AutoPushStatus>('git_push'),
  gitLog: (limit = 80) => call<{ items: GitCommitInfo[] }>('git_log', { limit }).then((r) => r.items),
  /** The generated architecture (`architecture_get`). */
  architecture: (p: { at?: string; compare?: string; focus?: string; includeArchived?: boolean; groupBy?: 'repo' | 'kind'; format?: 'graph' | 'mermaid' } = {}) =>
    call<ArchitectureGraph>('architecture_get', compact(p)),
};

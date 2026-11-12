import { buildRef, type RefKind } from '@mandate/shared/refs';
import { callTool, McpToolError } from './mcp/client';
import type { AutoPushStatus, ArchitectureGraph, GitCommitInfo, DocFeedback, EntityKind, Feedback, FileVersion, ResolvedFeedback, ResolvedWorkOrder, SectionImplementation, StandardUsage, GitStatus, GitSyncResult, HistoryEntry, WorkOrder, SectionTypeInfo, Spec, Standard } from '@mandate/shared';

/** Any stored entity; work orders carry extra fields. */
export type Entity = Spec | Standard | WorkOrder | Feedback;

type DocKind = 'specs' | 'standards' | 'components';

/** Drop undefined / empty values: tool inputs are strict. */
const compact = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== '' && v !== false && v !== null));
const call = <T>(tool: string, args: Record<string, unknown> = {}) => callTool<T>(tool, args);
const historyOf = (kind: RefKind, id: string) => call<{ entries: HistoryEntry[] }>('history_get', { ref: buildRef({ kind, id }), limit: 500 }).then((r) => r.entries);

/** Read-only client over MCP tools (the web UI never writes; agents write through MCP). */
export const api = {
  list: (kind: EntityKind) => call<{ items: Entity[] }>('doc_list', { kind }).then((r) => r.items),
  get: (kind: EntityKind, id: string): Promise<Entity> =>
    kind === 'work-orders' ? call('work_order_get', { ref: id }) : kind === 'feedback' ? call('feedback_get', { ref: id }) : call('doc_get', { kind, id }),
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
  workOrder: (id: string, at?: string) => call<ResolvedWorkOrder>('work_order_get', compact({ ref: id, at })),
  workOrderHistory: (id: string) => historyOf('work-orders', id),
  implementation: (specId: string) => call<{ sections: SectionImplementation }>('spec_implementation', { id: specId }).then((r) => r.sections),
  feedbackItem: (id: string) => call<ResolvedFeedback>('feedback_get', { ref: id }),
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

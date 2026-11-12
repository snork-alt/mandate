import { useQuery } from '@tanstack/react-query';
import { callRootTool } from '../mcp/client';

/** One project of `project_list` (unscoped `/mcp`). */
export interface ProjectSummary {
  id: string;
  name: string;
  description?: string;
  dataDir: string;
  branch: string;
  remote: string | null;
  mcpPath: string;
  counts: { specs: number; standards: number; components: number; workOrders: number; feedback: number };
  lastActivity: { at: string; summary: string; agent?: string } | null;
  /** GitHub storage (null for local-only projects); `reconnect` = the stored GitHub grant no longer works. */
  /** Server mode: what the signed-in user may do (from GitHub repo access). */
  access?: 'read' | 'write';
  github?: { repo: string; path: string | null; connectedBy: string; status: 'ok' | 'reconnect' } | null;
}

export interface ProjectList {
  defaultProject: string;
  items: ProjectSummary[];
}

export const listProjects = () => callRootTool<ProjectList>('project_list');

/** Every registered project (picker, switcher, legacy redirects). */
export const useProjects = () => useQuery({ queryKey: ['projects'], queryFn: () => listProjects(), staleTime: 15_000, refetchInterval: 30_000 });

/** "Read only" / "Can write" badge text (null when access isn't reported). */
export const accessLabel = (a: ProjectSummary['access']) => (a === 'read' ? 'Read only' : a === 'write' ? 'Can write' : null);

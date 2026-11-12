import { useQuery } from '@tanstack/react-query';
import { callTool, McpToolError } from '../../mcp/client';

export interface RefNode {
  ref: string;
  kind: string;
  label: string;
  props: Record<string, unknown>;
}

/** Resolve a reference through MCP `graph_node` (cached per reference). */
export function useRefNode(uri: string, enabled = true) {
  return useQuery<RefNode, McpToolError>({
    queryKey: ['mcp', 'node', uri],
    queryFn: async ({ signal }) => (await callTool<{ node: RefNode }>('graph_node', { uri }, signal)).node,
    enabled: enabled && !!uri,
    staleTime: 30_000,
    retry: false,
  });
}

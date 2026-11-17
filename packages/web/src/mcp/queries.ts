import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type { CodeSearchResponse, SearchKind, SearchResponse, SymbolSearchResponse, TextSearchResponse } from '@mandate/shared';
import { buildRef, type RefKind } from '@mandate/shared/refs';
import { callTool, McpToolError } from './client';

const STALE = 10_000;
const opts = { staleTime: STALE, placeholderData: keepPreviousData, retry: false } as const;

/** Generic typed tool query, keyed by tool + args. */
export function useMcpTool<T>(name: string, args: Record<string, unknown>, enabled = true) {
  return useQuery<T, McpToolError>({
    queryKey: ['mcp', name, args],
    queryFn: ({ signal }) => callTool<T>(name, args, signal),
    enabled,
    ...opts,
  });
}

export interface SearchFilterState {
  kinds: SearchKind[];
  status: string[];
}

export function useMcpSearch(q: string, filters: SearchFilterState, enabled = true) {
  return useMcpTool<SearchResponse>(
    'search',
    { q, mode: 'hybrid', limit: 8, ...(filters.kinds.length ? { kinds: filters.kinds } : {}), ...(filters.status.length ? { status: filters.status } : {}) },
    enabled && q.length > 0,
  );
}

export function useMcpTextSearch(phrase: string, filters: SearchFilterState, enabled = true) {
  return useMcpTool<TextSearchResponse>(
    'text_search',
    { q: phrase, limit: 20, ...(filters.kinds.length ? { kinds: filters.kinds } : {}), ...(filters.status.length ? { status: filters.status } : {}) },
    enabled && phrase.length > 0,
  );
}

export function useMcpSymbolSearch(name: string, enabled = true) {
  return useMcpTool<SymbolSearchResponse>('symbol_search', { name, match: 'prefix', limit: 15 }, enabled && name.length > 0);
}

export function useMcpCodeSearch(path: string, lines: string | undefined, enabled = true) {
  return useMcpTool<CodeSearchResponse>('code_search', { path, ...(lines ? { lines } : {}), limit: 20 }, enabled && path.length > 0);
}

export interface GraphNodeResult {
  node: { ref: string; kind: string; label: string; props: Record<string, unknown> };
}

/** Resolve a pasted reference (any kind, versioned or not). */
export function useMcpNode(uri: string, enabled = true) {
  return useMcpTool<GraphNodeResult>('graph_node', { uri }, enabled && uri.length > 0);
}

const ID_KINDS: RefKind[] = ['specs', 'standards', 'work-orders', 'feedback'];

/** `#id`: try spec, standard, work order and feedback ids in order; null when none exists. */
export function useMcpIdLookup(id: string, enabled = true) {
  return useQuery<(GraphNodeResult & { refKind: RefKind }) | null, McpToolError>({
    queryKey: ['mcp', 'id-lookup', id],
    enabled: enabled && id.length > 0,
    queryFn: async ({ signal }) => {
      for (const kind of ID_KINDS) {
        try {
          const r = await callTool<GraphNodeResult>('graph_node', { uri: buildRef({ kind, id }) }, signal);
          return { ...r, refKind: kind };
        } catch (e) {
          if (!(e instanceof McpToolError) || (e.code !== 'unknown_node' && e.code !== 'not_found' && e.code !== 'invalid_input')) throw e;
        }
      }
      return null;
    },
    ...opts,
  });
}

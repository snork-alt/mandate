import { createContext, useContext, useEffect, useRef, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { refMention } from '@mandate/shared/refs';
import { api } from '../../api';

type DocLib = typeof import('@mandate/doc');
let lib: DocLib | null = null;
const loadLib = () => import('@mandate/doc').then((m) => (lib = m));

export interface DocSource {
  kind: 'specs' | 'standards' | 'components' | 'audits' | 'work-orders';
  id: string;
  /** Pin references to this commit (tracked mode). */
  commit?: string;
  /** The `.md` source currently on screen, when loaded (synchronous, for copy events). */
  source(): string | null;
  /** The doc library, when loaded (synchronous helpers like locateQuote). */
  lib(): DocLib | null;
}

export const DocSourceCtx = createContext<DocSource | null>(null);
export const useDocSource = () => useContext(DocSourceCtx);

/**
 * The document's source and line helpers, so every copy inside it can produce `#Lx-Ly` references.
 * `source` overrides the current file (e.g. an older version on screen).
 */
export function useDocSourceValue(kind: 'specs' | 'standards' | 'components' | 'audits' | 'work-orders' | null, id: string, commit?: string, source?: string | null): DocSource | null {
  const raw = useQuery({
    queryKey: [kind, id, 'raw'],
    queryFn: () => api.raw(kind as 'specs', id),
    enabled: !!kind && source === undefined,
    staleTime: 10_000,
  });
  const ref = useRef<DocSource | null>(null);
  useEffect(() => {
    void loadLib();
  }, []);
  ref.current = kind
    ? { kind, id, commit, source: () => (source !== undefined ? source : (raw.data ?? null)), lib: () => lib }
    : null;
  return ref.current;
}

export function DocSourceProvider({ value, children }: { value: DocSource | null; children: ReactNode }) {
  return <DocSourceCtx.Provider value={value}>{children}</DocSourceCtx.Provider>;
}

/** Mention of a section, optionally versioned and with a line range (built by the shared refs builder). */
export function sectionReference(doc: DocSource, sectionId: string, lines?: { start: number; end: number } | null): string {
  return refMention({ kind: doc.kind, id: doc.id, sectionId, commit: doc.commit, lines: lines ?? undefined });
}

/** Reference to a fenced block of a section (code block by content, or the section's own fence). */
export async function blockReference(doc: DocSource, sectionId: string, code?: string): Promise<string> {
  const l = lib ?? (await loadLib());
  const src = doc.source() ?? (await api.raw(doc.kind, doc.id));
  const lines = src ? (code ? l.codeBlockRange(src, sectionId, code) : (l.codeBlockRange(src, sectionId) ?? l.sectionBodyRange(src, sectionId))) : null;
  return sectionReference(doc, sectionId, lines);
}

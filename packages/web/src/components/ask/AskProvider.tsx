import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useLocation } from 'react-router';
import { callTool } from '../../mcp/client';
import { chipsFromLocation, dedupeChips, type PageSelection } from './context';
import type { AskChip } from './types';
import { appPathname } from '../../project';

export type AskStatus = 'waiting' | 'answering' | 'done' | 'cancelled';
/** One question of the panel = one stored ask thread (answered by a coding agent). */
export interface AskTurn {
  id: number;
  /** Server id (ask_post); unset while posting. */
  askId?: string;
  question: string;
  status: AskStatus;
  /** The answer so far. */
  answer: string;
  /** Label of the agent answering (or addressed). */
  agent: string | null;
  to?: string | null;
  error?: string;
  running: boolean;
}

export interface AskDeps {
  callTool: <T>(name: string, args: Record<string, unknown>, signal?: AbortSignal, opts?: { timeoutMs?: number; retry?: boolean }) => Promise<T>;
}
interface AskView {
  id: string;
  conversationId: string;
  status: AskStatus;
  answer: string;
  agent: string | null;
  to: string | null;
}
export const ASK_POLL_MS = 1500;

export interface AskState {
  turns: AskTurn[];
  conversationId?: string;
  /** Post the question with the current context chips (`ask_post`); `to`: an agent handle, `any`, or none (the only online agent). */
  send: (question: string, to?: string) => void;
  /** The agent picked in this browser (a handle, `any`) or null = automatic. */
  agentChoice: string | null;
  setAgentChoice: (id: string | null) => void;
  /** Cancel the question that waits for an answer. */
  stop: () => void;
  running: boolean;
  /** Start a new conversation. */
  reset: () => void;
  draft: string;
  setDraft: (s: string) => void;
  /** Auto chips (current page) minus removed ones, plus manually added ones. */
  chips: AskChip[];
  removeChip: (uri: string) => void;
  addChip: (c: AskChip) => void;
}

const Ctx = createContext<AskState | null>(null);
export function useAsk(): AskState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAsk outside AskProvider');
  return v;
}
/** The Ask state when inside an AskProvider (components that also render outside the app shell). */
export const useAskOptional = (): AskState | null => useContext(Ctx);

/** Ask state lives above the pages, so the draft, chips and hint survive navigation. */
const realDeps: AskDeps = { callTool };

export function AskProvider({ children, deps = realDeps }: { children: ReactNode; deps?: AskDeps }) {
  const loc = useLocation();
  const [draft, setDraft] = useState('');
  const [turns, setTurns] = useState<AskTurn[]>([]);
  const [conversationId, setConversationId] = useState<string | undefined>();
  const [agentChoice, setAgentChoice] = useState<string | null>(null);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());
  useEffect(() => () => timers.current.forEach((t) => clearTimeout(t)), []);
  const nextId = useRef(1);
  const [manual, setManual] = useState<AskChip[]>([]);
  const [removed, setRemoved] = useState<{ path: string; uris: string[] }>({ path: '', uris: [] });
  const [selection, setSelection] = useState<(PageSelection & { path: string }) | null>(null);

  // Text selected inside a document (mouseup in `.doc-main`) becomes the section chip with a quote.
  useEffect(() => {
    const onUp = (e: MouseEvent) => {
      if (!(e.target as Element | null)?.closest?.('.doc-main')) return;
      const sel = window.getSelection();
      const text = sel && !sel.isCollapsed ? sel.toString().trim() : '';
      const node = sel?.anchorNode;
      const el = node ? (node.nodeType === 1 ? (node as Element) : node.parentElement)?.closest<HTMLElement>('[data-section-id]') : null;
      setSelection(text && el?.dataset.sectionId ? { sectionId: el.dataset.sectionId, text, path: appPathname() } : null);
    };
    document.addEventListener('mouseup', onUp);
    return () => document.removeEventListener('mouseup', onUp);
  }, []);

  const page = loc.pathname + loc.search;
  const chips = useMemo(() => {
    const sel = selection && selection.path === loc.pathname ? selection : null;
    const auto = chipsFromLocation(loc, sel);
    const hidden = removed.path === page ? removed.uris : [];
    return dedupeChips([...auto, ...manual]).filter((c) => !hidden.includes(c.uri));
  }, [loc, selection, manual, removed, page]);

  const removeChip = useCallback(
    (uri: string) => {
      setManual((m) => m.filter((c) => c.uri !== uri));
      setRemoved((r) => ({ path: page, uris: [...(r.path === page ? r.uris : []), uri] }));
    },
    [page],
  );
  const addChip = useCallback((c: AskChip) => {
    setManual((m) => (m.some((x) => x.uri === c.uri) ? m : [...m, c]));
    setRemoved((r) => ({ ...r, uris: r.uris.filter((u) => u !== c.uri) }));
  }, []);

  const chipsRef = useRef(chips);
  chipsRef.current = chips;
  const convRef = useRef(conversationId);
  convRef.current = conversationId;
  const running = turns.some((t) => t.running);
  const turnsRef = useRef(turns);
  turnsRef.current = turns;

  const patch = useCallback((id: number, p: Partial<AskTurn>) => setTurns((t) => t.map((x) => (x.id === id ? { ...x, ...p } : x))), []);
  const poll = useCallback(
    (id: number, askId: string) => {
      const tick = async () => {
        try {
          const v = await deps.callTool<AskView>('ask_get', { id: askId }, undefined, { retry: false });
          const finished = v.status === 'done' || v.status === 'cancelled';
          patch(id, { status: v.status, answer: v.answer, agent: v.agent, to: v.to, running: !finished });
          if (!finished) timers.current.set(id, setTimeout(tick, ASK_POLL_MS));
        } catch (e) {
          patch(id, { running: false, error: (e as Error).message });
        }
      };
      timers.current.set(id, setTimeout(tick, ASK_POLL_MS));
    },
    [deps, patch],
  );
  const send = useCallback(
    (question: string, to?: string) => {
      const q = question.trim();
      if (!q) return;
      const id = nextId.current++;
      setTurns((t) => [...t, { id, question: q, status: 'waiting', answer: '', agent: null, running: true }]);
      setDraft('');
      void deps
        .callTool<AskView>('ask_post', { question: q, context: chipsRef.current.map((c) => c.uri), ...(convRef.current ? { conversationId: convRef.current } : {}), ...(to ? { to } : {}) }, undefined, { retry: false })
        .then((v) => {
          setConversationId(v.conversationId);
          patch(id, { askId: v.id, status: v.status, answer: v.answer, agent: v.agent, to: v.to });
          poll(id, v.id);
        })
        .catch((e: Error) => patch(id, { running: false, error: e.message }));
    },
    [deps, patch, poll],
  );
  const stop = useCallback(() => {
    for (const t of turnsRef.current) if (t.running && t.askId) void deps.callTool('ask_cancel', { id: t.askId }, undefined, { retry: false }).catch(() => undefined);
  }, [deps]);
  const reset = useCallback(() => {
    timers.current.forEach((t) => clearTimeout(t));
    timers.current.clear();
    setTurns([]);
    setConversationId(undefined);
  }, []);

  const value = useMemo(
    () => ({ draft, setDraft, chips, removeChip, addChip, turns, conversationId, send, stop, running, reset, agentChoice, setAgentChoice }),
    [draft, chips, removeChip, addChip, turns, conversationId, send, stop, running, reset, agentChoice],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

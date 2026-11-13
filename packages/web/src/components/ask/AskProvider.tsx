import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useLocation } from 'react-router';
import { callTool } from '../../mcp/client';
import { onNotification } from '../../mcp/client';
import { emptyAnswer, runAsk, type AskDeps, type AskLiveState } from './stream';
import { chipsFromLocation, dedupeChips, type PageSelection } from './context';
import type { AskChip } from './types';
import { appPathname } from '../../project';

export interface AskTurn {
  id: number;
  question: string;
  state: AskLiveState;
  running: boolean;
}

export interface AskState {
  turns: AskTurn[];
  conversationId?: string;
  /** Ask the question with the current context chips (the `ask` MCP tool), with a configured model id (default: the server's). */
  send: (question: string, model?: string) => void;
  /** The model picked in this browser (remembered in localStorage); null = the server default. */
  modelChoice: string | null;
  setModelChoice: (id: string | null) => void;
  /** Cancel the running request. */
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
const realDeps: AskDeps = { callTool, onNotification };

const MODEL_KEY = 'mandate.ask.model';
function loadModelChoice(): string | null {
  try {
    return window.localStorage.getItem(MODEL_KEY);
  } catch {
    return null;
  }
}
function saveModelChoice(id: string | null): void {
  try {
    if (id) window.localStorage.setItem(MODEL_KEY, id);
    else window.localStorage.removeItem(MODEL_KEY);
  } catch {
    // storage unavailable (private mode, blocked): the choice lasts for this page only
  }
}

export function AskProvider({ children, deps = realDeps }: { children: ReactNode; deps?: AskDeps }) {
  const loc = useLocation();
  const [draft, setDraft] = useState('');
  const [turns, setTurns] = useState<AskTurn[]>([]);
  const [conversationId, setConversationId] = useState<string | undefined>();
  const [modelChoice, setModelChoiceState] = useState<string | null>(loadModelChoice);
  const setModelChoice = useCallback((id: string | null) => {
    setModelChoiceState(id);
    saveModelChoice(id);
  }, []);
  const abort = useRef<AbortController | null>(null);
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

  const send = useCallback(
    (question: string, model?: string) => {
      const q = question.trim();
      if (!q || abort.current) return;
      const id = nextId.current++;
      const ctl = new AbortController();
      abort.current = ctl;
      setTurns((t) => [...t, { id, question: q, state: emptyAnswer(), running: true }]);
      setDraft('');
      const patch = (state: AskLiveState, running: boolean) => setTurns((t) => t.map((x) => (x.id === id ? { ...x, state, running } : x)));
      void runAsk(deps, { question: q, context: chipsRef.current.map((c) => c.uri), conversationId: convRef.current, ...(model ? { model } : {}) }, (s) => patch(s, true), ctl.signal).then((final) => {
        if (final.result) setConversationId(final.result.conversationId);
        patch(final, false);
        abort.current = null;
      });
    },
    [deps],
  );
  const stop = useCallback(() => abort.current?.abort(), []);
  const reset = useCallback(() => {
    abort.current?.abort();
    abort.current = null;
    setTurns([]);
    setConversationId(undefined);
  }, []);

  const value = useMemo(
    () => ({ draft, setDraft, chips, removeChip, addChip, turns, conversationId, send, stop, running, reset, modelChoice, setModelChoice }),
    [draft, chips, removeChip, addChip, turns, conversationId, send, stop, running, reset, modelChoice, setModelChoice],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

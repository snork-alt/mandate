import { ASK_NOTIFICATION, type AskAnswerState, type AskEvent, type AskResult } from '@mandate/shared';

export type AskLiveState = AskAnswerState & { stopped?: boolean };

export const emptyAnswer = (): AskLiveState => ({ text: '', toolCalls: [], running: [] });

/** Fold one streamed `notifications/mandate/ask` event into the answer being shown. Pure. */
export function reduceAskEvent(s: AskLiveState, e: AskEvent): AskLiveState {
  switch (e.type) {
    case 'start':
      return { ...s, model: e.model };
    case 'text':
      return { ...s, text: s.text + e.delta };
    case 'tool_start':
      // Narration before a tool call is not part of the answer.
      return { ...s, text: '', running: [...s.running, { id: e.id, name: e.name, args: e.args }] };
    case 'tool_end':
      return { ...s, running: s.running.filter((r) => r.id !== e.call.id), toolCalls: [...s.toolCalls.filter((c) => c.id !== e.call.id), e.call] };
    case 'done':
      return { ...s, running: [], toolCalls: e.result.toolCalls, text: e.result.answer, result: e.result };
    case 'error':
      return { ...s, running: [], error: e.error };
  }
}

export interface AskDeps {
  callTool: <T>(name: string, args: Record<string, unknown>, signal?: AbortSignal, opts?: { timeoutMs?: number; retry?: boolean }) => Promise<T>;
  onNotification: (handler: (n: { method: string; params?: Record<string, unknown> }) => void) => () => void;
}

export interface AskRequest {
  question: string;
  context: string[];
  conversationId?: string;
  /** Configured model id (ask_status); the server default when absent. */
  model?: string;
}

/** Run one `ask` call, reporting every state change; abort the signal to stop (cancels the request on the server). */
export async function runAsk(deps: AskDeps, req: AskRequest, onState: (s: AskLiveState) => void, signal: AbortSignal): Promise<AskLiveState> {
  let state = emptyAnswer();
  let askId: string | undefined;
  const push = (next: AskLiveState) => {
    state = next;
    onState(state);
  };
  const off = deps.onNotification((n) => {
    if (n.method !== ASK_NOTIFICATION) return;
    const ev = n.params as unknown as AskEvent;
    askId ??= ev.askId;
    if (ev.askId === askId) push(reduceAskEvent(state, ev));
  });
  try {
    const result = await deps.callTool<AskResult>('ask', { question: req.question, context: req.context, ...(req.conversationId ? { conversationId: req.conversationId } : {}), ...(req.model ? { model: req.model } : {}) }, signal, { timeoutMs: 600_000, retry: false });
    push(reduceAskEvent(state, { askId: askId ?? '', type: 'done', result }));
  } catch (e) {
    if (signal.aborted) push({ ...state, running: [], stopped: true });
    else {
      const err = e as { code?: string; message?: string };
      push({ ...state, running: [], error: { code: err.code ?? 'error', message: err.message ?? String(e) } });
    }
  }
  off();
  return state;
}

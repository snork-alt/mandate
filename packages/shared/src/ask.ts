/**
 * Ask: built-in answering over Mandate's read tools. Shared by the server (`ask` MCP tool, agent loop) and the web UI
 * (rich rendering of answers and of the streamed `notifications/mandate/ask` progress).
 *
 * Answer format: markdown where every entity is a `mandate://` link (`[Login with SSO](mandate://specs/login-sso)`),
 * plus fenced embed blocks:
 *   ```mandate-embed            -> a live card for one reference (section, criterion, work order, feedback, commit ...)
 *   ref: mandate://specs/x/sections/y
 *   ```
 *   ```mandate-table            -> a table (JSON { "columns": [...], "rows": [[...]] }); cells that are refs render as chips
 *   ```mandate-graph            -> a small subgraph around the listed refs (`ref:` lines, optional `depth: 1|2`)
 */
import { z } from 'zod';
import { parseNodeUri } from './refs.js';

export const ASK_NOTIFICATION = 'notifications/mandate/ask';

const refString = z
  .string()
  .trim()
  .min(1)
  .max(400)
  .refine((v) => parseNodeUri(v) !== null, 'expected a mandate:// reference');

export const askInputSchema = z
  .object({
    question: z.string().trim().min(1).max(4000),
    /** References the question is about (the UI's context chips). */
    context: z.array(refString).max(20).default([]),
    /** Continue a conversation (follow-up questions keep the earlier turns). */
    conversationId: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/, 'invalid conversationId').optional(),
    /** Id of a configured model (ask_status lists them); default: the configured default. A conversation may switch models. */
    model: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, 'invalid model id').optional(),
  })
  .strict();
export type AskInput = z.input<typeof askInputSchema>;

export type EmbedKind = 'mandate-embed' | 'mandate-table' | 'mandate-graph';

export type AnswerEmbed =
  | { kind: 'mandate-embed'; ref: string; index: number }
  | { kind: 'mandate-table'; columns: string[]; rows: unknown[][]; index: number }
  | { kind: 'mandate-graph'; refs: string[]; depth: number; index: number }
  | { kind: 'invalid'; block: EmbedKind; error: string; index: number };

export interface ReferenceCheck {
  ref: string;
  resolved: boolean;
  /** Node kind and label when resolved. */
  kind?: string;
  label?: string;
  /** Why it did not resolve (shown on the chip, never hidden). */
  error?: string;
}

export interface AskToolCall {
  id: string;
  name: string;
  args: unknown;
  ok: boolean;
  /** One line: "6 hits", "12 rows", "not_found: ...". */
  summary: string;
  /** Result trimmed for rich rendering (search hits, Cypher rows, neighbours). */
  result?: unknown;
  error?: { code: string; message: string };
  ms: number;
}

export interface AskResult {
  conversationId: string;
  /** Markdown with mandate:// links and embed blocks. */
  answer: string;
  embeds: AnswerEmbed[];
  /** Every reference in the answer, checked with resolveRef. */
  references: ReferenceCheck[];
  toolCalls: AskToolCall[];
  /** inputTokens includes cachedInputTokens (prompt-cache reads, when the provider reports them). */
  usage: { inputTokens: number; outputTokens: number; cachedInputTokens?: number };
  /** Why the loop ended: done, max_tool_calls, token_budget, timeout, max_tokens, refusal, aborted. */
  stopReason: string;
  provider: string;
  model: string;
  /** Configured model id (`ask.models[].id`) and its label. */
  modelId: string;
  modelLabel: string;
  /** Set when the provider kept failing after retries (stopReason `provider_error`); answer and toolCalls hold what was done. */
  error?: { code: string; message: string };
  /** Provider retries of this answer (transient stream / routing / 429 / 5xx failures), with the errors seen. */
  diagnostics?: { retries: number; providerErrors: AskProviderError[] };
}

/** A provider failure (never contains keys). */
export interface AskProviderError {
  class: string;
  message: string;
  status?: number;
  requestId?: string;
}

/** The model answering a question. */
export interface AskModelInfo {
  id: string;
  label: string;
  provider: string;
  model: string;
}

/** Streamed while an answer is produced (`notifications/mandate/ask`). */
export type AskEvent =
  | { askId: string; type: 'start'; model: AskModelInfo }
  | { askId: string; type: 'text'; delta: string }
  | { askId: string; type: 'tool_start'; id: string; name: string; args: unknown }
  | { askId: string; type: 'tool_end'; call: AskToolCall }
  /** The provider dropped the current step; it is retried. `text` replaces the streamed text (the failed step's partial text is discarded). */
  | { askId: string; type: 'retry'; attempt: number; max: number; message: string; text: string }
  | { askId: string; type: 'done'; result: AskResult }
  | { askId: string; type: 'error'; error: { code: string; message: string } };

/** Phase-2 answer as the UI accumulates it from AskEvents. */
export interface AskAnswerState {
  text: string;
  toolCalls: AskToolCall[];
  running: { id: string; name: string; args: unknown }[];
  /** The answering model (from the `start` event). */
  model?: AskModelInfo;
  /** A transient status line (e.g. "Provider interrupted; retrying (1/2)…"). */
  notice?: string;
  result?: AskResult;
  error?: { code: string; message: string };
}

const LINK_RE = /\[([^\]]*)\]\(((?:@mandate:)?mandate:\/\/[^)\s]+)\)/g;
const BARE_RE = /(?<![(\w/])((?:@mandate:)?mandate:\/\/[^\s)\]>`"',;]+)/g;
const FENCE_RE = /^```(mandate-embed|mandate-table|mandate-graph)[ \t]*\n([\s\S]*?)^```[ \t]*$/gm;

const clean = (r: string) => r.trim().replace(/^@mandate:/, '').replace(/[.:]+$/, '');

function kv(body: string): [string, string][] {
  return body
    .split('\n')
    .map((l) => /^\s*([a-z]+)\s*:\s*(.+?)\s*$/i.exec(l))
    .filter((m): m is RegExpExecArray => !!m)
    .map((m) => [m[1]!.toLowerCase(), m[2]!]);
}

/** Parse embed blocks and collect every mandate:// reference (links, bare refs, embed refs, table cells). */
export function parseAnswer(markdown: string): { embeds: AnswerEmbed[]; refs: string[] } {
  const refs = new Set<string>();
  const embeds: AnswerEmbed[] = [];
  let index = 0;
  for (const m of markdown.matchAll(FENCE_RE)) {
    const block = m[1] as EmbedKind;
    const body = m[2]!;
    const i = index++;
    if (block === 'mandate-embed') {
      const ref = kv(body).find(([k]) => k === 'ref')?.[1];
      if (!ref || !parseNodeUri(ref)) embeds.push({ kind: 'invalid', block, error: 'expected "ref: mandate://..."', index: i });
      else {
        refs.add(clean(ref));
        embeds.push({ kind: 'mandate-embed', ref: clean(ref), index: i });
      }
    } else if (block === 'mandate-graph') {
      const pairs = kv(body);
      const list = pairs.filter(([k]) => k === 'ref').map(([, v]) => clean(v));
      const depth = Math.min(2, Math.max(1, Number(pairs.find(([k]) => k === 'depth')?.[1] ?? 1) || 1));
      if (!list.length || list.some((r) => !parseNodeUri(r))) embeds.push({ kind: 'invalid', block, error: 'expected one or more "ref: mandate://..." lines', index: i });
      else {
        list.forEach((r) => refs.add(r));
        embeds.push({ kind: 'mandate-graph', refs: list, depth, index: i });
      }
    } else {
      try {
        const t = JSON.parse(body) as { columns?: unknown; rows?: unknown };
        if (!Array.isArray(t.columns) || !Array.isArray(t.rows) || !t.rows.every(Array.isArray)) throw new Error('expected { "columns": [...], "rows": [[...]] }');
        for (const row of t.rows as unknown[][]) for (const c of row) if (typeof c === 'string' && /^(@mandate:)?mandate:\/\//.test(c) && parseNodeUri(c)) refs.add(clean(c));
        embeds.push({ kind: 'mandate-table', columns: t.columns.map(String), rows: t.rows as unknown[][], index: i });
      } catch (e) {
        embeds.push({ kind: 'invalid', block, error: (e as Error).message, index: i });
      }
    }
  }
  const prose = markdown.replace(FENCE_RE, '');
  for (const m of prose.matchAll(LINK_RE)) refs.add(clean(m[2]!));
  for (const m of prose.replace(LINK_RE, '').matchAll(BARE_RE)) refs.add(clean(m[1]!));
  return { embeds, refs: [...refs] };
}

/** Split markdown into prose and embed segments, in order (the UI renders embeds in place). */
export function answerSegments(markdown: string): ({ type: 'markdown'; text: string } | { type: 'embed'; index: number })[] {
  const out: ({ type: 'markdown'; text: string } | { type: 'embed'; index: number })[] = [];
  let last = 0;
  let i = 0;
  for (const m of markdown.matchAll(FENCE_RE)) {
    if (m.index! > last) out.push({ type: 'markdown', text: markdown.slice(last, m.index) });
    out.push({ type: 'embed', index: i++ });
    last = m.index! + m[0].length;
  }
  if (last < markdown.length) out.push({ type: 'markdown', text: markdown.slice(last) });
  return out;
}

/** The system prompt section describing the answer format (server-side; exported for tests and docs). */
export const ANSWER_FORMAT_GUIDE = `Answer format (markdown):
- Every spec, standard, section, work order, feedback item, symbol, code location or commit you mention is a link to its mandate:// reference, e.g. [Authentication flow](mandate://specs/login-sso/sections/auth-flow). Use the exact refs returned by the tools; never invent one.
- Cite a reference for every claim. If the tools found nothing, say so.
- To show a section, criterion, work order, feedback item or commit as a live card, add an embed block:
\`\`\`mandate-embed
ref: mandate://specs/login-sso/sections/auth-flow
\`\`\`
- For tabular results add \`\`\`mandate-table with JSON {"columns": [...], "rows": [[...]]} (cells may be mandate:// refs).
- To show how a few nodes connect, add \`\`\`mandate-graph with one "ref: mandate://..." line per node (optional "depth: 1" or "depth: 2").
- Be concise: a direct answer first, then the evidence.`;

/** `ask`: built-in answering with the configured model over Mandate's read tools (streams notifications/mandate/ask). */
import { ASK_NOTIFICATION, askInputSchema, type AskEvent } from '@mandate/shared';
import { DEFAULT_ASK_CONFIG } from '../../config.js';
import { askLimits, askModelStatus, cachedAskModel, ConversationStore, liveAskConfig, runAsk, type AskModel } from '../../ask/index.js';
import { defineTool, type AnyToolDef, type ToolContext } from '../define.js';
import { ToolError } from '../errors.js';

/**
 * Read tools the Ask agent cannot use, and why. Everything else with `kind: 'read'` is offered automatically
 * (write and ops tools never are).
 */
export const ASK_EXCLUDED_TOOLS: Readonly<Record<string, string>> = {
  // Recursion: an Ask answer would start another agent loop (and another model bill) inside a tool call.
  ask: 'recursion',
  // A per-session streaming subscription (it only changes which notifications this MCP session receives): no result for a model.
  activity_subscribe: 'streaming subscription',
};
/** Tools the model may call: every read tool except ASK_EXCLUDED_TOOLS. */
export function askToolset(all: AnyToolDef[]): AnyToolDef[] {
  return all.filter((t) => t.kind === 'read' && t.annotations?.readOnlyHint !== false && !Object.hasOwn(ASK_EXCLUDED_TOOLS, t.name));
}

/** Fallback when the context has no per-project store (tests building a bare ToolContext). */
const sharedConversations = new ConversationStore();

/** Registry injected by server.ts (avoids an import cycle). */
let registry: () => AnyToolDef[] = () => [];
export function setAskRegistry(fn: () => AnyToolDef[]): void {
  registry = fn;
}

export const askTools = [
  defineTool({
    name: 'ask',
    title: 'Ask (built-in answering)',
    kind: 'read',
    // Reads Mandate only, but calls the configured model's API.
    annotations: { openWorldHint: true },
    description: `Answer a question with the model configured in ~/.mandate/config.json (\`ask\` block; see ask_status), which uses Mandate's read tools (search, graph, Cypher, get, history) and cites mandate:// references. Streams \`${ASK_NOTIFICATION}\` notifications (text deltas, tool steps, done) on the request's stream; cancel the request to stop. Returns the markdown answer (mandate:// links and mandate-embed / mandate-table / mandate-graph blocks), parsed embeds, every reference checked with resolveRef, the tool steps, token usage and the stop reason. conversationId continues a conversation. model picks a configured model by id (default: the configured default); a conversation may switch models between questions. Unknown model -> invalid_input; not configured -> error not_configured with the missing fields.
Example: {"question":"What blocks login-sso?","context":["mandate://specs/login-sso"],"model":"opus"}`,
    input: askInputSchema,
    run: async (a, ctx: ToolContext) => {
      const cfg = liveAskConfig(ctx.ask ?? DEFAULT_ASK_CONFIG);
      const ids = cfg.models.map((m) => m.id);
      if (a.model !== undefined && !ids.includes(a.model)) {
        throw new ToolError('invalid_input', `unknown model '${a.model}'`, ids.length ? `use one of: ${ids.join(', ')} (ask_status lists them)` : 'no models are configured (ask_status)', 'model');
      }
      const id = a.model ?? cfg.default ?? cfg.models[0]?.id;
      const entry = cfg.models.find((m) => m.id === id);
      let model: AskModel;
      let choice: { id: string; label: string };
      if (ctx.askModel && typeof ctx.askModel !== 'function') {
        // Test override: one model for every choice.
        model = ctx.askModel;
        choice = { id: entry?.id ?? 'default', label: entry?.label ?? entry?.id ?? model.model };
      } else {
        const status = entry ? askModelStatus(entry) : undefined;
        if (!entry || !status?.configured) {
          const missing = status?.missing ?? ['provider', 'model'];
          throw new ToolError(
            'not_configured',
            entry ? `Ask model '${entry.id}' is not configured (missing: ${missing.join(', ')}${status?.reason ? `: ${status.reason}` : ''})` : `no model configured for Ask (missing: ${missing.join(', ')})`,
            'configure the ask block in ~/.mandate/config.json (keys via the env var named by apiKeyEnv, or ~/.mandate/secrets.env); ask_status shows what is missing',
            '',
            { kind: 'ask', ...(entry ? { model: entry.id } : {}), missing },
          );
        }
        model = typeof ctx.askModel === 'function' ? ctx.askModel(entry) : cachedAskModel(entry);
        choice = { id: entry.id, label: entry.label ?? entry.id };
      }
      const index = ctx.index;
      return runAsk({
        question: a.question,
        context: a.context,
        conversationId: a.conversationId,
        model,
        choice,
        tools: askToolset(registry()),
        ctx,
        limits: askLimits(cfg, entry),
        conversations: ctx.conversations ?? sharedConversations,
        signal: ctx.signal,
        emit: (e: AskEvent) => void ctx.notify?.(ASK_NOTIFICATION, e as unknown as Record<string, unknown>),
        resolve: index
          ? async (ref) => {
              const r = await index.resolveRef({ ref });
              return { kind: r.node.kind, label: r.node.label };
            }
          : null,
      });
    },
  }),
];

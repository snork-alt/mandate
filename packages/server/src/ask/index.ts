import { ASK_LIMITS, type AskModelConfig, type ResolvedAskConfig } from '../config.js';
import type { AskLimits } from './agent.js';

export { askStatus, askModelStatus, type AskStatus, type AskModelStatus, type AskMissing } from './status.js';
export { liveAskConfig } from './live.js';
export { runAsk, ConversationStore, askSystemPrompt, summarizeToolResult, type AskLimits, type AskToolLine } from './agent.js';
export { cachedAskModel, clearAskModelCache, createAskModel, DEFAULT_ANTHROPIC_MODEL, type AskModel } from './model.js';

type Limits = Partial<Pick<ResolvedAskConfig, keyof AskLimits>>;
/** Limits for one question: the model's overrides, then the `ask` block's, then ASK_LIMITS. */
export function askLimits(cfg: Limits | undefined, model?: Partial<AskModelConfig>): AskLimits {
  return {
    maxToolCalls: model?.maxToolCalls ?? cfg?.maxToolCalls ?? ASK_LIMITS.maxToolCalls,
    timeoutMs: model?.timeoutMs ?? cfg?.timeoutMs ?? ASK_LIMITS.timeoutMs,
    tokenBudget: model?.tokenBudget ?? cfg?.tokenBudget ?? ASK_LIMITS.tokenBudget,
    maxOutputTokens: model?.maxOutputTokens ?? cfg?.maxOutputTokens ?? ASK_LIMITS.maxOutputTokens,
  };
}

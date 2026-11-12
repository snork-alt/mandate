/** Limits of one Ask question: the model's overrides, then the `ask` block's, then the defaults. */
import { ASK_LIMITS, ASK_TOOL_RESULT_TOKENS, type AskModelConfig, type ResolvedAskConfig } from '../config.js';
import type { AskLimits } from './agent.js';

type Limits = Partial<Pick<ResolvedAskConfig, 'maxToolCalls' | 'timeoutMs' | 'tokenBudget' | 'maxOutputTokens' | 'maxToolResultTokens' | 'toolResultTokens'>>;
/** Limits for one question: the model's overrides, then the `ask` block's, then ASK_LIMITS. */
export function askLimits(cfg: Limits | undefined, model?: Partial<AskModelConfig>): AskLimits {
  return {
    maxToolCalls: model?.maxToolCalls ?? cfg?.maxToolCalls ?? ASK_LIMITS.maxToolCalls,
    timeoutMs: model?.timeoutMs ?? cfg?.timeoutMs ?? ASK_LIMITS.timeoutMs,
    tokenBudget: model?.tokenBudget ?? cfg?.tokenBudget ?? ASK_LIMITS.tokenBudget,
    maxOutputTokens: model?.maxOutputTokens ?? cfg?.maxOutputTokens ?? ASK_LIMITS.maxOutputTokens,
    maxToolResultTokens: model?.maxToolResultTokens ?? cfg?.maxToolResultTokens ?? ASK_LIMITS.maxToolResultTokens,
    toolResultTokens: { ...ASK_TOOL_RESULT_TOKENS, ...(cfg?.toolResultTokens ?? {}) },
  };
}

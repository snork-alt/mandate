/** `lifecycle_get`: the lifecycle registry (states, transitions, gates, error actions, when to set each state). */
import { ERROR_ACTIONS, INTEGRITY_RULES, LIFECYCLE_KINDS, lifecycleGetInputSchema, lifecycleView } from '@mandate/shared';
import { defineTool } from '../define.js';

export const lifecycleTools = [
  defineTool({
    name: 'lifecycle_get',
    title: 'Lifecycle rules',
    kind: 'read',
    description: `States, allowed transitions (from -> to), the tool, gate, error codes and WHEN in the flow to make each change, for one object kind. kind integrity: the integrity rules (errors block writes). Without kind: the kinds and errorActions (code -> what to do). Call it before a status change you are unsure of.
Example: {"kind":"spec"}`,
    input: lifecycleGetInputSchema,
    run: async (a) => {
      if (a.kind === 'integrity') return { integrityRules: INTEGRITY_RULES.map(({ enforcedBy: _e, ...r }) => r) };
      if (a.kind) {
        const v = lifecycleView(a.kind);
        const codes = [...new Set(v.steps.flatMap((s) => s.errors ?? []))];
        // enforcedBy (server file / function names) helps maintainers, not agents.
        return { ...v, steps: v.steps.map(({ enforcedBy: _e, ...st }) => st), errorActions: Object.fromEntries(codes.map((c) => [c, ERROR_ACTIONS[c] ?? ''])) };
      }
      return { kinds: [...LIFECYCLE_KINDS, 'integrity'], errorActions: ERROR_ACTIONS };
    },
  }),
];

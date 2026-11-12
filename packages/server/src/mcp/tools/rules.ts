/** Rules tools (read): which rules apply to a piece of code, and the automated checks to run for a spec. */
import { ruleCheckPlanInputSchema, rulesForCodeInputSchema } from '@mandate/shared';
import { rulesForCode } from '../../storage/index.js';
import { defineTool } from '../define.js';

export const ruleTools = [
  defineTool({
    name: 'rules_for_code',
    title: 'Rules for code',
    kind: 'read',
    description: `Standard rules applying to code you are editing: active rules whose scope matches the file, plus rules inherited by sections referencing it. Sorted must, should, may; with rationale and check.
Example: {"repo":"app","path":"src/auth/session.ts","lines":"10-40"}`,
    input: rulesForCodeInputSchema,
    run: async (a, ctx) => ({ rules: rulesForCode(a, await ctx.storage.model()) }),
  }),
  defineTool({
    name: 'rule_check_plan',
    title: 'Rule check plan',
    kind: 'read',
    description: `Automated checks (lint / test / script commands) to run for a spec: each inherited rule with a check, its level and state. Record results with evidence.command / evidence.output.
Example: {"spec":"mandate://specs/login-sso"}`,
    input: ruleCheckPlanInputSchema,
    run: async (a, ctx) => ({ checks: await ctx.storage.verificationService.ruleCheckPlan(a) }),
  }),
];

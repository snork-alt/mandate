import { z } from 'zod';
import type { GraphNode, SectionTypeDef } from '../registry.js';

export const RULE_LEVELS = ['must', 'should', 'may'] as const;
export type RuleLevel = (typeof RULE_LEVELS)[number];
export const RULE_CHECK_KINDS = ['lint', 'test', 'script', 'review'] as const;

/** `mandate://code/<repo>[@<commit>]/<path>[#La[-Lb]]` (a code reference URI). */
export const CODE_REF_URI = /^mandate:\/\/code\/[^/@#\s]+(?:@[0-9a-f]{4,40})?\/[^#\s]+(?:#L\d+(?:-L\d+)?)?$/;

export const ruleScopeSchema = z.object({
  /** Globs over repository paths (`src/**\/*.ts`). */
  paths: z.array(z.string().min(1)).optional(),
  /** Languages (from file extensions): typescript, javascript, python, go, ... */
  languages: z.array(z.string().min(1)).optional(),
});
export type RuleScope = z.infer<typeof ruleScopeSchema>;

export const ruleCheckSchema = z.object({
  kind: z.enum(RULE_CHECK_KINDS),
  command: z.string().min(1).optional(),
  ruleId: z.string().min(1).optional(),
  note: z.string().min(1).optional(),
});
export type RuleCheck = z.infer<typeof ruleCheckSchema>;

/** Frontmatter entry of a rule: level, rationale (required), optional scope, check and examples. */
export const ruleMetaSchema = z.object({
  level: z.enum(RULE_LEVELS, { message: `level must be one of ${RULE_LEVELS.join(', ')}` }),
  rationale: z.string().trim().min(1, 'a rule needs a rationale'),
  scope: ruleScopeSchema.optional(),
  check: ruleCheckSchema.optional(),
  examples: z.array(z.string().regex(CODE_REF_URI, 'examples are code reference URIs (mandate://code/<repo>/<path>#Lx-Ly)')).optional(),
});

/**
 * One rule of a standard per section. The body is markdown, by convention with **Do** / **Don't**
 * code blocks. A rule is a criterion: inherited by following specs, verified, waived and gated
 * like an acceptance criterion; `must` blocks done, `should` only warns, `may` is informational.
 */
export const ruleType: SectionTypeDef = {
  id: 'rule',
  label: 'Rule',
  description: 'One rule of a standard: level (must|should|may), rationale, optional scope (paths, languages), check (lint|test|script|review) and code examples; body with **Do** / **Don\'t** blocks.',
  metaSchema: ruleMetaSchema,
  verifies: true,
  extractNodes(section, docUri): GraphNode[] {
    return [{ uri: `${docUri}/sections/${section.id}`, kind: 'criterion', label: section.title, text: section.body }];
  },
  status(section, ctx) {
    const state = ctx.itemStates?.[`${ctx.docUri}/sections/${section.id}`] ?? 'unverified';
    return { total: 1, verified: state === 'verified' ? 1 : 0, state };
  },
};

/** Split a rule body into its prose and the **Do** / **Don't** code blocks. */
export function ruleExamples(body: string): { prose: string; do: { lang: string; code: string }[]; dont: { lang: string; code: string }[] } {
  const out = { prose: '', do: [] as { lang: string; code: string }[], dont: [] as { lang: string; code: string }[] };
  const re = /\*\*(Do|Don't|Don’t)\*\*:?\s*\n+```([\w-]*)\n([\s\S]*?)\n```/g;
  let last = 0;
  const prose: string[] = [];
  for (const m of body.matchAll(re)) {
    prose.push(body.slice(last, m.index));
    last = m.index! + m[0].length;
    (m[1] === 'Do' ? out.do : out.dont).push({ lang: m[2] ?? '', code: m[3] ?? '' });
  }
  prose.push(body.slice(last));
  out.prose = prose.join('').trim();
  return out;
}

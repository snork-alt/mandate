import { describe, expect, it } from 'vitest';
import { ruleExamples } from '../src/index.js';
import { fmt } from './fixtures.js';

const doc = (entry: string, body = 'Never log tokens.') => `---
title: S
sections:
  - id: r
    title: No tokens in logs
    type: rule
${entry}
---

<!-- @section r -->
## No tokens in logs

${body}
`;

describe('rule section type', () => {
  it('parses level, rationale, scope, check and examples and round-trips', () => {
    const md = doc(
      [
        '    level: must',
        '    rationale: Logs are shipped to third parties.',
        '    scope: {paths: [src/**/*.ts], languages: [typescript]}',
        '    check: {kind: lint, command: npm run lint, ruleId: no-token-log}',
        '    examples: [mandate://code/app/src/log.ts#L3-L9]',
      ].join('\n'),
    );
    const d = fmt.parse(md);
    expect(d.sections[0]).toMatchObject({
      type: 'rule',
      level: 'must',
      rationale: 'Logs are shipped to third parties.',
      scope: { paths: ['src/**/*.ts'], languages: ['typescript'] },
      check: { kind: 'lint', command: 'npm run lint', ruleId: 'no-token-log' },
      examples: ['mandate://code/app/src/log.ts#L3-L9'],
    });
    expect(fmt.parse(fmt.serialize(d))).toEqual(d);
  });

  it('requires a level and a rationale, and code-ref examples', () => {
    expect(fmt.validate(doc('    level: must')).issues.map((i) => i.message).join(' ')).toMatch(/rationale/);
    expect(fmt.validate(doc('    rationale: x')).issues.map((i) => i.message).join(' ')).toMatch(/level/);
    expect(fmt.validate(doc('    level: often\n    rationale: x')).ok).toBe(false);
    expect(fmt.validate(doc('    level: may\n    rationale: x\n    examples: [https://x]')).issues[0]!.message).toMatch(/code reference/);
    expect(fmt.validate(doc('    level: may\n    rationale: x\n    check: {kind: magic}')).ok).toBe(false);
  });

  it('can be listed in verifiedBy (it is a criterion)', () => {
    const md = `---\ntitle: S\nsections:\n  - id: a\n    title: A\n    verifiedBy: [r]\n  - id: r\n    title: R\n    type: rule\n    level: should\n    rationale: why\n---\n\n<!-- @section a -->\n## A\n\nx\n\n<!-- @section r -->\n## R\n\ny\n`;
    expect(fmt.validate(md).ok).toBe(true);
  });

  it("splits Do / Don't blocks from the prose", () => {
    const fence = '`'.repeat(3);
    const body = ['Use the logger.', '', '**Do**', '', `${fence}ts`, 'log.info({ user })', fence, '', "**Don't**", '', `${fence}ts`, 'console.log(token)', fence].join('\n');
    expect(ruleExamples(body)).toEqual({ prose: 'Use the logger.', do: [{ lang: 'ts', code: 'log.info({ user })' }], dont: [{ lang: 'ts', code: 'console.log(token)' }] });
  });
});

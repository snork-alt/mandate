import { describe, expect, it } from 'vitest';
import { acceptanceType, diffDocs, verifiedByEdges } from '../src/index.js';
import { fmt } from './fixtures.js';

const doc = (sections: string, body: string) => `---\ntitle: T\nstatus: draft\nsections:\n${sections}\n---\n${body}`;
const FRONT = `  - id: flow
    title: Flow
    type: markdown
    verifiedBy: [ac-rotation]
  - id: ac-rotation
    title: Refresh tokens rotate
    type: acceptance
    method: test
  - id: ac-latency
    title: Login is fast
    type: acceptance
    method: metric
    threshold: {metric: p95_ms, max: 300}`;
const BODY = `
<!-- @section flow -->
## Flow

Tokens rotate.

<!-- @section ac-rotation -->
## Refresh tokens rotate

Using a refresh token twice revokes the session.

<!-- @section ac-latency -->
## Login is fast

p95 under 300 ms.
`;

describe('acceptance section type', () => {
  it('parses criteria with method / threshold and round-trips', () => {
    const md = doc(FRONT, BODY);
    const d = fmt.parse(md);
    expect(d.sections[1]).toMatchObject({ id: 'ac-rotation', type: 'acceptance', method: 'test' });
    expect(d.sections[2]).toMatchObject({ method: 'metric', threshold: { metric: 'p95_ms', max: 300 } });
    expect(d.sections[0]!.verifiedBy).toEqual(['ac-rotation']);
    expect(fmt.serialize(d)).toBe(md);
  });

  it('validates the frontmatter entry and verifiedBy targets', () => {
    const codes = (md: string) => fmt.validate(md).issues.map((i) => i.message);
    expect(codes(doc(FRONT.replace('method: test', 'method: vibes'), BODY))[0]).toMatch(/method must be one of/);
    expect(codes(doc(FRONT.replace('    method: test\n', ''), BODY))[0]).toMatch(/method/);
    expect(codes(doc(FRONT.replace('    threshold: {metric: p95_ms, max: 300}', ''), BODY))[0]).toMatch(/threshold/);
    expect(codes(doc(FRONT.replace('[ac-rotation]', '[ghost]'), BODY))[0]).toMatch(/not a section/);
    expect(codes(doc(FRONT.replace('[ac-rotation]', '[flow]'), BODY))[0]).toMatch(/not a criterion/);
  });

  it('contributes graph nodes, verified-by edges and a status rollup', () => {
    const d = fmt.parse(doc(FRONT, BODY));
    const uri = 'mandate://specs/x';
    expect(acceptanceType.extractNodes!(d.sections[1]!, uri)).toEqual([
      { uri: `${uri}/sections/ac-rotation`, kind: 'criterion', label: 'Refresh tokens rotate', text: 'Using a refresh token twice revokes the session.' },
    ]);
    expect(verifiedByEdges(d.sections[0]!, uri)).toEqual([{ from: `${uri}/sections/flow`, to: `${uri}/sections/ac-rotation`, kind: 'verified-by' }]);
    expect(acceptanceType.status!(d.sections[1]!, { docUri: uri, itemStates: { [`${uri}/sections/ac-rotation`]: 'verified' } })).toEqual({ total: 1, verified: 1, state: 'verified' });
    expect(acceptanceType.status!(d.sections[2]!, { docUri: uri })).toEqual({ total: 1, verified: 0, state: 'unverified' });
  });

  it('diffs criteria like any section (per criterion = per section)', () => {
    const a = doc(FRONT, BODY);
    const b = doc(FRONT.replace('method: test', 'method: manual'), BODY.replace('revokes the session', 'revokes every session'));
    const s = diffDocs(fmt, a, b).sections.find((x) => x.id === 'ac-rotation')!;
    expect(s.status).toBe('modified');
    expect(s.meta).toEqual([expect.objectContaining({ key: 'method', before: 'test', after: 'manual' })]);
    expect(s.body).toBeDefined();
  });
});

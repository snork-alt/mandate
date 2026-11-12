/**
 * Fuzz: random and near-valid payloads into EVERY tool. Each call must return a valid result or a structured
 * error ({ code, message, path }); never a JSON-RPC error, a crash or an unhandled rejection. Nothing is written.
 */
import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TOOLS } from '../../src/mcp/index.js';
import { mcpFixture, type McpFixture } from './fixture.js';

let fx: McpFixture;
let headBefore: string;
let writes = 0;
const unhandled: unknown[] = [];
const onUnhandled = (e: unknown) => unhandled.push(e);

beforeAll(async () => {
  fx = await mcpFixture();
  headBefore = (await fx.git.head())!;
  process.on('unhandledRejection', onUnhandled);
}, 120_000);
afterAll(async () => {
  process.off('unhandledRejection', onUnhandled);
  await fx?.close();
});

/** Values that look like the inputs tools expect (references, shas, ranges, enums) plus junk. */
const refish = fc.oneof(
  fc.constantFrom(
    'mandate://specs/login-sso',
    '@mandate:mandate://specs/login-sso/sections/auth-flow#L1-L5',
    'mandate://specs/login-sso@0000000/sections/auth-flow',
    'mandate://standards/security-baseline/sections/rules',
    'mandate://work-orders/q-0001',
    'mandate://queue/q-0001',
    'mandate://feedback/fb-0001',
    'mandate://symbols/AuthService.login',
    'mandate://code/app/src/auth/session.ts#L30-L35',
    'mandate://commits/abcdef0',
    'mandate://specs/x#L0-L1',
    'mandate://specs/../etc',
    'login-sso',
    'HEAD',
    'deadbeef',
    '2026-11-01',
    '1-2',
    'src/**/*.ts',
    'MATCH (n) RETURN n LIMIT 1',
    'MATCH (a)-[*1..99]->(b) RETURN a',
    "MATCH (s:Spec) WHERE s.ref = 'mandate://specs/login-sso' RETURN s",
    '(((',
    '.*',
    '',
  ),
  fc.string({ maxLength: 40 }),
  fc.string({ unit: 'binary', maxLength: 20 }),
);
const value: fc.Arbitrary<unknown> = fc.letrec((tie) => ({
  v: fc.oneof(
    { depthSize: 'small' },
    refish,
    fc.integer({ min: -5, max: 10_000 }),
    fc.double(),
    fc.boolean(),
    fc.constant(null),
    fc.array(tie('v'), { maxLength: 4 }),
    fc.dictionary(fc.constantFrom('op', 'args', 'uri', 'q', 'x'), tie('v'), { maxKeys: 3 }),
  ),
})).v;

const keysOf = (name: string) => {
  const t = TOOLS.find((x) => x.name === name)!;
  const shape = (t.input as unknown as { shape?: Record<string, unknown>; _zod?: { def?: { in?: { shape?: Record<string, unknown> }; schema?: { shape?: Record<string, unknown> } } } });
  return Object.keys(shape.shape ?? shape._zod?.def?.in?.shape ?? shape._zod?.def?.schema?.shape ?? {});
};

describe('fuzz every tool', () => {
  for (const t of TOOLS) {
    it(t.name, async () => {
      const keys = [...keysOf(t.name), 'bogus'];
      const payload = fc.oneof(
        fc.dictionary(fc.constantFrom(...keys), value, { maxKeys: 5 }),
        fc.dictionary(fc.string({ maxLength: 8 }), value, { maxKeys: 3 }),
      );
      await fc.assert(
        fc.asyncProperty(payload, async (args) => {
          const before = await fx.git.head();
          const r = await fx.client.callTool({ name: t.name, arguments: args as Record<string, unknown> });
          const body = r.structuredContent as Record<string, any> | undefined;
          expect(body, 'structuredContent').toBeTypeOf('object');
          if (r.isError) {
            expect(typeof body!.error.code).toBe('string');
            expect(typeof body!.error.message).toBe('string');
            expect(typeof body!.error.path).toBe('string');
            // Unexpected server errors are bugs: inputs must be rejected by validation or a domain check.
            expect(body!.error.code, JSON.stringify({ args, error: body!.error })).not.toBe('internal');
          }
          if (t.kind === 'write') {
            // Never a partial write: a rejected call leaves HEAD and the working tree as they were; an accepted one
            // reports the commit it made (or none), and leaves a clean tree.
            const after = await fx.git.head();
            if (r.isError) expect(after, JSON.stringify({ args, error: body!.error })).toBe(before);
            else if (after !== before) expect(body!.commit).toBe(after);
            expect((await fx.git.status()).files ?? [], JSON.stringify(args)).toEqual([]);
            if (after !== before) writes++;
          } else if (t.name !== 'git_pull') {
            expect(await fx.git.head(), `${t.name} is read-only`).toBe(before);
          }
        }),
        { numRuns: t.name === 'git_pull' ? 20 : 60, seed: 4242 },
      );
    }, 120_000);
  }

  it('read tools wrote nothing; no unhandled rejections', async () => {
    // Only accepted write-tool calls may have committed.
    if (!writes) expect(await fx.git.head()).toBe(headBefore);
    expect((await fx.git.status()).files ?? []).toEqual([]);
    expect(unhandled).toEqual([]);
  });
});

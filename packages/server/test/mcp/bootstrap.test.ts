/** /mandate-bootstrap: skill text names only real tools, the MCP prompt, and the provenance / confidence section fields. */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { specFormat } from '../../src/storage/codecs.js';
import { specSectionInputSchemas } from '@mandate/shared';
import { createMcpServer, TOOLS } from '../../src/mcp/server.js';
import { BOOTSTRAP_COMMAND, BOOTSTRAP_SKILL_BODY, NOTE_TYPES } from '../../src/mcp/bootstrap.js';
import { SKILL_BODY } from '../../src/mcp/guide.js';
import type { ToolContext } from '../../src/mcp/define.js';

const names = new Set(TOOLS.map((t) => t.name));
const PREFIX = /^(project|spec|standard|component|work_order|feedback|verification|graph|rule|rules|search|symbol|code|text|architecture|audit|comment)_/;

describe('bootstrap skill', () => {
  it('names only real MCP tools (the dry-run review)', () => {
    const texts = [BOOTSTRAP_SKILL_BODY, BOOTSTRAP_COMMAND.render('--resume')];
    const mentioned = new Set(texts.flatMap((t) => [...t.matchAll(/\b([a-z]+(?:_[a-z]+)+)\b/g)].map((m) => m[1]!)).filter((n) => (PREFIX.test(n) || n === 'rules_for_code') && !(NOTE_TYPES as readonly string[]).includes(n) && n !== 'standard_confirmation'));
    expect([...mentioned].filter((n) => !names.has(n))).toEqual([]);
    for (const n of ['project_info', 'spec_match', 'spec_create', 'component_create', 'standard_create', 'work_order_create', 'work_order_plan_set', 'verification_record', 'feedback_create', 'work_order_complete']) expect(mentioned.has(n), n).toBe(true);
  });

  it('covers the stages, resume, notes schema, asking rules and the standards rule', () => {
    const t = BOOTSTRAP_SKILL_BODY;
    for (const x of ['Stage 1: EXTRACT', 'Stage 2: DISTILL', 'Stage 3: REVIEW', '--resume', 'mandate bootstrap validate', 'mandate bootstrap init', 'provenance: "inferred"', 'standard_confirmation', 'fresh', 'sub-agents', 'cause: <tracking work order ref>', 'Never invent requirements', 'Never ask what code', 'done only if every criterion passed', 'distilled|reviewed']) expect(t, x).toContain(x);
    // H1 / M8: no workOrder field on every write; never done after skipped verifications.
    expect(t).not.toContain('workOrder:');
    expect(t).not.toMatch(/ready → done/);
    for (const type of NOTE_TYPES) expect(t).toContain(type);
    expect(t).toMatch(/before creating or changing ANY standard \(always, even with approval\s+off\)/);
    expect(t).toMatchSnapshot();
  });

  it('the master skill only points at it', () => {
    expect(SKILL_BODY).toContain('/mandate-bootstrap');
    expect(SKILL_BODY).not.toContain('Stage 1: EXTRACT');
  });
});

describe('MCP prompts', () => {
  it('lists mandate-flow and mandate-bootstrap; renders the arguments', async () => {
    const server = createMcpServer({} as ToolContext);
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    const c = new Client({ name: 't', version: '0' });
    await c.connect(b);
    expect((await c.listPrompts()).prompts.map((p) => p.name)).toEqual(['mandate-flow', 'mandate-bootstrap']);
    const r = await c.getPrompt({ name: 'mandate-bootstrap', arguments: { args: 'distill --run 20261112-101500-ab12' } });
    expect((r.messages[0]!.content as { text: string }).text).toContain('Arguments: "distill --run 20261112-101500-ab12"');
    await c.close();
  });
});

describe('provenance / confidence', () => {
  const ref = 'mandate://specs/x/sections/a';
  it('section writes accept inferred | confirmed and a 0..1 confidence (strictly)', () => {
    expect(specSectionInputSchemas.update.safeParse({ ref, provenance: 'inferred', confidence: 0.6 }).success).toBe(true);
    expect(specSectionInputSchemas.update.safeParse({ ref, provenance: 'confirmed', confidence: null }).success).toBe(true);
    expect(specSectionInputSchemas.update.safeParse({ ref, provenance: 'guessed' }).success).toBe(false);
    expect(specSectionInputSchemas.update.safeParse({ ref, confidence: 1.5 }).success).toBe(false);
    expect(specSectionInputSchemas.insert.safeParse({ doc: 'x', section: { title: 'A', provenance: 'inferred', confidence: 0.3 } }).success).toBe(true);
  });
  it('round-trips through the document format (and invalid values are rejected)', () => {
    const src = readFileSync(path.resolve(__dirname, '../../../../data/repo/specs/login-sso.md'), 'utf8');
    const doc = specFormat.parse(src);
    const sections = doc.sections.map((x, i) => (i === 0 ? { ...x, provenance: 'inferred' as const, confidence: 0.6 } : x));
    const text = specFormat.serialize({ frontmatter: doc.frontmatter, sections });
    expect(text).toContain('provenance: inferred');
    expect(text).toContain('confidence: 0.6');
    expect(specFormat.parse(text).sections[0]).toMatchObject({ provenance: 'inferred', confidence: 0.6 });
    expect(specFormat.validate(text.replace('provenance: inferred', 'provenance: maybe')).ok).toBe(false);
    expect(specFormat.validate(text.replace('confidence: 0.6', 'confidence: 7')).ok).toBe(false);
  });
});

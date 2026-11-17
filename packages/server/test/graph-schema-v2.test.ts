/**
 * Graph schema v2 (P1-P6): one edge kind per link rel with its own lineage orientation, derived document-level
 * dependencies under their own names, `uses_standard` without `applies_to`, `covers` from work-order sections only,
 * the P5 kinds (acts_on, created_by / filed_by, duplicate_finding_of, ...), user nodes and case-folded agent ids.
 */
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CAUSAL_EDGES,
  EDGE_KINDS,
  LINEAGE_EDGES,
  LINEAGE_KINDS_BY_NODE,
  LINK_EDGE_KINDS,
  NODE_KINDS,
  REVERSE_EDGE_NAMES,
  buildNodeUri,
  createSpecSchema,
  createStandardSchema,
  parseNodeUri,
} from '@mandate/shared';
import { extractFile } from '../src/index/extract.js';
import { auditFormat } from '../src/storage/codecs.js';
import { IndexService } from '../src/index/service.js';
import { createStorage, type Storage } from '../src/storage/index.js';
import { cleanupTempDirs, newStore, tempDir } from './helpers.js';

const embedding = {
  provider: 'openai-compatible' as const,
  baseUrl: 'http://localhost:1/v1',
  model: 'fake',
  apiKeyEnv: null,
  dimensions: 64,
  maxInputTokens: 2048,
  batchSize: 16,
  documentPrefix: 'search_document: ',
  queryPrefix: 'search_query: ',
};
const indexCfg = (file: string) => ({ path: file, chunkTargetTokens: 350, chunkOverlapTokens: 50, sectionSoftLimitTokens: 600 });

let storage: Storage;
let index: IndexService;
let fb: string;
let wo: string;
const S = (id: string, sid?: string) => `mandate://specs/${id}${sid ? `/sections/${sid}` : ''}`;
const rows = <T>(sql: string, ...p: unknown[]) => index.db.prepare(sql).all(...p) as T[];

beforeAll(async () => {
  const dir = await tempDir();
  const git = await newStore(dir);
  storage = createStorage(git);
  await storage.standards.create(createStandardSchema.parse({ title: 'Sec', sections: [{ id: 'rules', title: 'Rules', body: 'Never log tokens.' }] }));
  await storage.standards.create(createStandardSchema.parse({ title: 'Api', appliesTo: ['tag:api'], sections: [{ id: 'style', title: 'Style', body: 'REST.' }] }));
  await storage.specs.create(createSpecSchema.parse({ title: 'Base', sections: [{ id: 'core', title: 'Core', body: 'Core API.' }, { id: 'old', title: 'Old', body: 'Old flow.' }, { id: 'ext', title: 'Ext', body: 'Extension point.' }] }));
  await storage.specs.create(
    createSpecSchema.parse({
      title: 'Login',
      tags: ['api'],
      sections: [
        { id: 'logging', title: 'Logging', body: 'Logs redact tokens.', links: [{ to: 'mandate://standards/sec/sections/rules', rel: 'follows' }, { to: 'mandate://standards/api', rel: 'follows' }] },
        { id: 'debug', title: 'Debug', body: 'Debug mode logs raw requests.', links: [{ to: 'mandate://standards/sec/sections/rules', rel: 'deviates_from', note: 'local only' }] },
        { id: 'flow', title: 'Flow', body: 'Uses the core API.', links: [{ to: S('base', 'core'), rel: 'depends_on' }, { to: S('base', 'ext'), rel: 'extends' }] },
        { id: 'next', title: 'Next', body: 'Replaces the old flow.', links: [{ to: S('base', 'old'), rel: 'supersedes' }, { to: S('base', 'core'), rel: 'relates_to' }] },
      ],
    }),
    { agent: 'Giulia' },
  );
  // Server mode: the commit names its user (`Mandate-User`); feedback is filed and a work order created by users.
  const f = await storage.feedbackService.create({ targets: [S('login', 'flow')], kind: 'improvement', body: 'Retry the core call.' } as never, { agent: 'coding-agent', trailers: { 'Mandate-User': 'Alice' } });
  fb = `mandate://requests/${f.id}`;
  const w = await storage.workOrderService.create({ spec: 'login', kind: 'implement', status: 'pending', sections: [{ id: 'flow' }], reason: [f.id], plan: 'p' }, { agent: 'coding-agent', trailers: { 'Mandate-User': 'BOB' } });
  wo = `mandate://work-orders/${w.id}`;
  index = new IndexService({ git, storage, index: indexCfg(path.join(dir, '..', `${path.basename(dir)}-v2.sqlite`)), embedding, provider: null });
  await index.start();
}, 120_000);
afterAll(async () => {
  index?.close();
  await cleanupTempDirs();
});

describe('registry', () => {
  it('every kind has a unique reverse name; link kinds, P5 kinds and user are registered; links_to / applies_to are gone', () => {
    const names = Object.values(REVERSE_EDGE_NAMES);
    expect(new Set(names).size).toBe(names.length);
    for (const n of names) expect((EDGE_KINDS as readonly string[]).includes(n), n).toBe(false);
    for (const k of [...LINK_EDGE_KINDS, 'spec_depends_on', 'component_depends_on', 'acts_on', 'waived_by', 'verified_at_code', 'created_by', 'filed_by', 'duplicate_finding_of']) expect(EDGE_KINDS).toContain(k);
    for (const k of ['links_to', 'applies_to', 'superseded_by']) expect(EDGE_KINDS).not.toContain(k);
    expect(REVERSE_EDGE_NAMES.supersedes).toBe('superseded_by');
    expect(NODE_KINDS).toContain('user');
    expect(LINEAGE_KINDS_BY_NODE.user.length).toBeGreaterThan(0);
    for (const k of ['acts_on', 'waived_by', 'verified_at_code', 'duplicate_finding_of'] as const) {
      expect(LINEAGE_EDGES[k]).toBeDefined();
      expect(CAUSAL_EDGES).toContain(k);
    }
  });

  it('lineage orientation per rel: the target causes a dependency; a superseding / affecting section is the cause', () => {
    for (const k of ['depends_on', 'follows', 'deviates_from', 'extends', 'conflicts_with', 'relates_to'] as const) expect(LINEAGE_EDGES[k], k).toBe('reverse');
    for (const k of ['supersedes', 'affects', 'verified_by'] as const) expect(LINEAGE_EDGES[k], k).toBe('forward');
    expect(LINEAGE_EDGES.acts_on).toBe('reverse');
  });
});

describe('index', () => {
  it('P1: one edge kind per rel, link metadata on the edge, no links_to', async () => {
    const kinds = (from: string) => rows<{ kind: string; to_uri: string }>('SELECT kind, to_uri FROM edges WHERE from_uri = ? AND valid_to IS NULL ORDER BY kind', from);
    expect(kinds(S('login', 'flow')).map((r) => r.kind)).toEqual(expect.arrayContaining(['depends_on', 'extends']));
    expect(kinds(S('login', 'next')).map((r) => r.kind)).toEqual(expect.arrayContaining(['supersedes', 'relates_to']));
    expect(kinds(S('login', 'logging')).filter((r) => r.kind === 'follows')).toHaveLength(2);
    expect(rows("SELECT 1 FROM edges WHERE kind IN ('links_to', 'applies_to', 'superseded_by')")).toHaveLength(0);
    const r = await index.graphNode({ uri: S('base', 'old') });
    expect(r.neighbors.find((g) => g.name === 'superseded_by')?.nodes.map((n) => n.uri)).toEqual([S('login', 'next')]);
  });

  it('P1: lineage follows each rel in its own direction', async () => {
    const up = await index.lineage({ ref: S('login', 'flow'), direction: 'up', depth: 1, structure: true });
    expect(up.edges).toContainEqual(expect.objectContaining({ from: S('base', 'core'), to: S('login', 'flow'), kind: 'depends_on' }));
    const old = await index.lineage({ ref: S('base', 'old'), direction: 'up', depth: 1, structure: true });
    expect(old.edges).toContainEqual(expect.objectContaining({ from: S('login', 'next'), to: S('base', 'old'), kind: 'supersedes' }));
  });

  it('P2 / P3: spec_depends_on is derived (never depends_on between documents); uses_standard merges links and appliesTo', async () => {
    const out = rows<{ kind: string; to_uri: string; props: string }>("SELECT kind, to_uri, props FROM edges WHERE from_uri = ? AND valid_to IS NULL AND kind IN ('depends_on', 'spec_depends_on', 'uses_standard') ORDER BY kind, to_uri", S('login'));
    expect(out.map((e) => [e.kind, e.to_uri, JSON.parse(e.props)])).toEqual([
      ['spec_depends_on', S('base'), { via: 'links' }],
      ['uses_standard', 'mandate://standards/api', { via: ['links', 'appliesTo'], rules: ['tag:api'] }],
      ['uses_standard', 'mandate://standards/sec', { via: ['links'] }],
    ]);
    const impact = await index.graphImpact({ uri: 'mandate://standards/api' });
    expect(impact.groups.spec?.map((n) => n.uri)).toContain(S('login'));
  });

  it('P4: covers runs from the work-order section to the spec section; the work order reaches it through has_section', async () => {
    const cov = rows<{ from_uri: string; to_uri: string }>("SELECT from_uri, to_uri FROM edges WHERE kind = 'covers' AND valid_to IS NULL");
    expect(cov.length).toBeGreaterThan(0);
    for (const c of cov) {
      expect(c.from_uri.startsWith(`${wo}/sections/`)).toBe(true);
      expect(c.to_uri).toBe(S('login', 'flow'));
    }
    const q = await index.graphQuery({ query: 'MATCH (w:WorkOrder {ref: $wo})-[:HAS_SECTION]->(:Section)-[:COVERS]->(s:Section) RETURN s.ref', params: { wo } });
    expect(q.rows.map((r) => r[0])).toEqual([S('login', 'flow')]);
    const impact = await index.graphImpact({ uri: S('login', 'flow') });
    expect(impact.groups.work_order?.map((n) => n.uri)).toContain(wo);
  });

  it('P5: acts_on is the recorded cause of a work order (source reason); no caused_by from reason', async () => {
    expect(rows("SELECT 1 FROM edges WHERE kind = 'acts_on' AND from_uri = ? AND to_uri = ? AND valid_to IS NULL", wo, fb)).toHaveLength(1);
    expect(rows("SELECT 1 FROM edges WHERE kind = 'caused_by' AND from_uri = ? AND json_extract(props, '$.source') = 'reason'", wo)).toHaveLength(0);
    const l = await index.lineage({ ref: wo, direction: 'up', depth: 1 });
    expect(l.edges).toContainEqual(expect.objectContaining({ from: fb, to: wo, kind: 'acts_on', recorded: true, source: 'reason' }));
  });

  it('P6: user nodes (case-folded), authored_by / filed_by / created_by; agents are case-folded with old refs resolving', async () => {
    const users = rows<{ uri: string; label: string }>("SELECT uri, label FROM nodes WHERE kind = 'user' ORDER BY uri");
    expect(users.map((u) => u.uri)).toEqual(['mandate://users/alice', 'mandate://users/bob']);
    expect(rows("SELECT 1 FROM edges WHERE kind = 'filed_by' AND from_uri = ? AND to_uri = 'mandate://users/alice'", fb)).toHaveLength(1);
    expect(rows("SELECT 1 FROM edges WHERE kind = 'created_by' AND from_uri = ? AND to_uri = 'mandate://users/bob'", wo)).toHaveLength(1);
    expect(rows("SELECT 1 FROM edges WHERE kind = 'authored_by' AND from_uri LIKE 'mandate://commits/%' AND to_uri = 'mandate://users/bob'")).toHaveLength(1);
    // Commits without a user record none (local mode has no user nodes).
    const noUser = rows<{ n: number }>("SELECT COUNT(*) AS n FROM commits c WHERE c.trailers NOT LIKE '%Mandate-User%' AND EXISTS (SELECT 1 FROM edges e WHERE e.from_uri = 'mandate://commits/' || c.sha AND e.kind = 'authored_by' AND e.to_uri LIKE 'mandate://users/%')");
    expect(noUser[0]!.n).toBe(0);
    // Agent ids are case-folded: the old `mandate://agents/Giulia` reference resolves to the same node.
    expect(buildNodeUri({ kind: 'agents', name: 'Giulia' })).toBe('mandate://agents/giulia');
    const a = await index.resolveRef({ ref: 'mandate://agents/Giulia' });
    expect(a.node).toMatchObject({ uri: 'mandate://agents/giulia', kind: 'agent', label: 'Giulia' });
    const u = await index.resolveRef({ ref: 'mandate://users/ALICE' });
    expect(u.node).toMatchObject({ uri: 'mandate://users/alice', kind: 'user' });
    expect(parseNodeUri('mandate://users/alice')).toEqual({ kind: 'users', login: 'alice' });
    const q = await index.graphQuery({ query: 'MATCH (w:WorkOrder)-[:CREATED_BY]->(u:User) RETURN w.ref, u.login' });
    expect(q.rows).toEqual([[wo, 'bob']]);
  });

  it('a low-confidence lineage annotation is an inferred edge (confidence: low)', async () => {
    const head = (await storage.history.log('specs/login.md'))[0]!.commit;
    const rec = await storage.lineageAnnotationService.annotate({ commit: head, causes: [S('base', 'core')], note: 'inferred: same topic', by: 'tester', confidence: 'low' });
    expect(rec.confidence).toBe('low');
    await index.ensureFresh();
    const l = await index.lineage({ ref: S('login'), direction: 'up', depth: 1 });
    expect(l.edges).toContainEqual(expect.objectContaining({ from: S('base', 'core'), source: 'annotation', confidence: 'low' }));
  });

  it('P5: a finding repeating an earlier audit finding gets duplicate_finding_of', () => {
    const md = auditFormat.serialize({
      frontmatter: {
        title: 'Audit two',
        target: 'mandate://standards/sec',
        commit: 'a'.repeat(40),
        auditor: { agent: 'auditor' },
        status: 'in_progress',
        startedAt: '2026-11-12T00:00:00.000Z',
        counts: { must: {}, should: {}, may: {}, findings: {} },
      },
      sections: [
        {
          id: 'rules',
          title: 'Rules',
          type: 'audit-item',
          ref: 'mandate://standards/sec/sections/rules',
          kind: 'rule',
          level: 'must',
          result: 'fail',
          findings: [{ id: 'f1', title: 'Token logged', severity: 'major', classification: 'code_deviates', description: 'The token is logged.', codeRefs: [], duplicateOf: 'mandate://audits/audit-one/findings/f3' }],
          body: 'Checked the logger.',
        },
      ],
    } as never);
    const rec = extractFile('audits/audit-two.md', md, { formats: { audits: auditFormat } as never, chunk: {} as never, graphOnly: true });
    expect(rec.errors.join('; ')).toBe('');
    expect(rec.edges).toContainEqual(expect.objectContaining({ from: 'mandate://audits/audit-two/findings/f1', to: 'mandate://audits/audit-one/findings/f3', kind: 'duplicate_finding_of' }));
  });
});

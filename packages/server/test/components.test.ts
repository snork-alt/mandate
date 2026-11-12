/** Components: link rules and directions, cycles, ownership precedence, derived states, coverage lint, architectureGet, references. */
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildArchitectureRef, createComponentSchema, createSpecSchema, createStandardSchema, ownerOf, parseNodeUri, globSpecificity, nodeKindOf } from '@mandate/shared';
import { checkLinks } from '@mandate/doc';
import { coverage, createStorage, deriveComponents, resolveReference } from '../src/storage/index.js';
import { componentEdges } from '../src/index/rules.js';
import { cleanupTempDirs, newStore, tempDir } from './helpers.js';

afterEach(cleanupTempDirs);

const C = (id: string, sid?: string) => `mandate://components/${id}${sid ? `/sections/${sid}` : ''}`;
const sec = (id: string, extra: object = {}) => ({ id, title: id.toUpperCase(), body: `${id} body`, ...extra });
const dep = (to: string) => ({ to, rel: 'depends_on' });

async function setup() {
  const git = await newStore(path.join(await tempDir(), 'repo'));
  const storage = createStorage(git);
  const comp = (id: string, sections: object[], extra: object = {}) =>
    storage.components.create(createComponentSchema.parse({ id, title: id, kind: 'service', sections, ...extra }));
  const spec = (id: string, sections: object[], extra: object = {}) => storage.specs.create(createSpecSchema.parse({ id, title: id, sections, ...extra }));
  const patchComp = async (id: string, f: (s: { id: string; links: { to: string; rel: string }[] }) => object) => {
    const c = await storage.components.get(id);
    return storage.components.update(id, { sections: c.sections.map((s) => ({ ...s, ...f(s) })) } as never);
  };
  return { git, storage, comp, spec, patchComp };
}

describe('component link rules', () => {
  it('allows only the defined directions and rels', () => {
    const l = (to: string, rel: string) => [{ id: 'a', links: [{ to, rel: rel as 'affects' }] }];
    expect(checkLinks('specs', 's', l(C('auth'), 'affects'))).toEqual([]);
    expect(checkLinks('specs', 's', l(C('auth', 'api'), 'affects'))).toEqual([]);
    expect(checkLinks('specs', 's', l(C('auth'), 'depends_on'))[0]).toMatch(/affects/);
    expect(checkLinks('components', 'x', l(C('auth', 'api'), 'depends_on'))).toEqual([]);
    expect(checkLinks('components', 'x', l('mandate://standards/sec', 'follows'))).toEqual([]);
    expect(checkLinks('components', 'x', l('mandate://standards/sec', 'deviates_from'))[0]).toMatch(/needs a note/);
    expect(checkLinks('components', 'x', l('mandate://specs/s/sections/a', 'relates_to'))[0]).toMatch(/components never link to specs/);
    expect(checkLinks('standards', 'x', l(C('auth'), 'relates_to'))[0]).toMatch(/appliesTo/);
  });

  it('validates targets, rejects component cycles (section and component level), stamps seenAt on new dependencies', async () => {
    const { storage, comp, spec, patchComp } = await setup();
    await comp('db', [sec('schema')], { kind: 'datastore' });
    const auth = await comp('auth', [sec('api', { links: [dep(C('db', 'schema'))] })]);
    expect(auth.sections[0]!.links[0]!.seenAt).toMatch(/^[0-9a-f]{40}$/);
    await expect(comp('bad', [sec('x', { links: [dep(C('nope'))] })])).rejects.toThrow(/does not exist/);
    await expect(patchComp('db', () => ({ links: [dep(C('auth', 'api'))] }))).rejects.toThrow(/component depends_on cycle/);
    await expect(patchComp('db', () => ({ links: [dep(C('auth'))] }))).rejects.toThrow(/cycle/);
    await spec('s', [sec('a', { links: [{ to: C('auth', 'api'), rel: 'affects' }] })]);
    await expect(storage.components.delete('auth')).rejects.toMatchObject({ code: 'archive_only' });
    await expect(storage.components.update('auth', { sections: [] } as never)).rejects.toMatchObject({ code: 'section_referenced' });
    // Feedback may target component sections.
    const f = await storage.feedbackService.create({ targets: [C('auth', 'api')], kind: 'question', body: 'rate limits?' });
    expect(f.targets).toEqual([C('auth', 'api')]);
  });
});

describe('ownership', () => {
  it('picks the most specific glob', () => {
    const comps = [
      { id: 'app', owns: [{ repo: 'app', paths: ['src/**'] }] },
      { id: 'auth', owns: [{ repo: 'app', paths: ['src/auth/**'] }] },
      { id: 'callback', owns: [{ repo: 'app', paths: ['src/auth/callback.ts'] }] },
      { id: 'other-repo', owns: [{ repo: 'api', paths: ['src/auth/**'] }] },
    ];
    expect(ownerOf('app', 'src/auth/callback.ts', comps)?.component.id).toBe('callback');
    expect(ownerOf('app', 'src/auth/oidc.ts', comps)?.component.id).toBe('auth');
    expect(ownerOf('app', 'src/ui/x.tsx', comps)?.component.id).toBe('app');
    expect(ownerOf('api', 'src/auth/x.ts', comps)?.component.id).toBe('other-repo');
    expect(ownerOf('app', 'db/x.sql', comps)).toBeNull();
    expect(globSpecificity('src/auth/**')).toBeGreaterThan(globSpecificity('src/**'));
  });
});

describe('derived states and coverage', () => {
  it('derives spec / work order / feedback connections, rules, upstream changes and the coverage lint', async () => {
    const { storage, comp, spec, patchComp } = await setup();
    await storage.standards.create(
      createStandardSchema.parse({ id: 'svc', title: 'Services', appliesTo: ['componentKind:service'], sections: [{ id: 'r', title: 'R', type: 'rule', level: 'must', rationale: 'x', body: 'y' }] }),
    );
    await comp('db', [sec('schema')], { kind: 'datastore', owns: [{ repo: 'app', paths: ['db/**', 'nothing/**'] }] });
    await comp('auth', [sec('api', { links: [dep(C('db', 'schema'))] })], { owns: [{ repo: 'app', paths: ['src/auth/**'] }] });
    await spec('s', [sec('a', { refs: [{ repo: 'app', path: 'src/auth/oidc.ts' }] }), sec('b', { links: [{ to: C('db'), rel: 'affects' }], refs: [{ repo: 'app', path: 'lib/x.ts' }] })], { status: 'ready' });
    const w = await storage.workOrderService.create({ spec: 's', kind: 'implement', status: 'pending', sections: [{ id: 'a' }] });
    await storage.workOrderService.claim({ id: w.id, agent: 'claude' });
    await storage.feedbackService.create({ targets: [C('db', 'schema')], kind: 'bug', body: 'index missing' });
    // An interface change of db/schema -> "upstream changed" on auth/api.
    await patchComp('db', (s) => (s.id === 'schema' ? { body: 'new schema' } : {}));
    const m = await storage.model();
    const d = await deriveComponents(await storage.components.list(), m, { links: storage.linkService });
    expect(d.auth).toMatchObject({ dependsOn: ['db'], affectedBy: [{ spec: 's', sections: ['a'], via: ['owns'] }], workOrders: [{ id: w.id, claim: { agent: 'claude' } }], upstreamChanged: ['api'] });
    expect(d.auth!.rules.map((r) => [r.uri.split('/').pop(), r.via])).toEqual([['r', 'appliesTo componentKind:service']]);
    expect(d.db).toMatchObject({ dependents: ['auth'], openFeedback: 1, affectedBy: [{ spec: 's', sections: ['b'], via: ['affects'] }], emptyGlobs: ['app:db/**', 'app:nothing/**'] });
    expect(d.db!.rules).toEqual([]); // a datastore is not a service
    const cov = coverage(m);
    expect(cov.unowned.map((r) => r.path)).toEqual(['lib/x.ts']);
    const issues = (await storage.integrity.run()).issues.map((i) => i.rule);
    expect(issues).toEqual(expect.arrayContaining(['unowned_code_ref', 'owns_matches_nothing']));
    // Work orders and specs see the components they touch.
    const tree = (await storage.workOrderService.resolve(w.id)).dependencies!;
    expect(tree.nodes[0]!.components).toEqual(['auth']);
  });
});

describe('architectureGet', () => {
  it('returns the graph (groups, labelled edges, focus), mermaid, an old commit and the compare diff', async () => {
    const { git, storage, comp } = await setup();
    await comp('db', [sec('schema')], { kind: 'datastore', owns: [{ repo: 'app', paths: ['db/**'] }] });
    await comp('auth', [sec('api', { links: [dep(C('db', 'schema'))] })], { owns: [{ repo: 'app', paths: ['src/auth/**'] }] });
    const old = (await git.log(1))[0]!.id;
    await comp('web', [sec('shell', { links: [dep(C('auth', 'api'))] })], { kind: 'module', owns: [{ repo: 'web', paths: ['src/**'] }] });
    const db = await storage.components.get('db');
    await storage.components.update('db', { summary: 'Primary store', sections: db.sections } as never);

    const g = await storage.architecture.get({ focus: 'auth' });
    expect(g.ref).toBe('mandate://architecture?focus=auth');
    expect(g.groups.map((x) => x.id)).toEqual(['app', 'web']);
    expect(g.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ from: 'auth', to: 'db', label: 'SCHEMA', section: 'schema', focus: true }),
        expect.objectContaining({ from: 'web', to: 'auth', label: 'API' }),
      ]),
    );
    expect(Object.fromEntries(g.nodes.map((n) => [n.id, n.focus]))).toEqual({ auth: 'focus', db: 'upstream', web: 'downstream' });
    const byKind = await storage.architecture.get({ groupBy: 'kind' });
    expect(byKind.groups.map((x) => x.id)).toEqual(['datastore', 'module', 'service']);

    const mm = await storage.architecture.get({ format: 'mermaid' });
    expect(mm.mermaid).toMatch(/^flowchart TB/);
    expect(mm.mermaid).toContain('subgraph layer_level_1["Level 1"]');
    expect(mm.mermaid).toContain('auth -->|"SCHEMA"| db');

    const then = await storage.architecture.get({ at: old.slice(0, 7) });
    expect(then.commit).toBe(old);
    expect(then.nodes.map((n) => n.id).sort()).toEqual(['auth', 'db']);
    expect(then.ref).toBe(buildArchitectureRef({ commit: old }));

    const cmp = await storage.architecture.get({ compare: old });
    expect(Object.fromEntries(cmp.nodes.map((n) => [n.id, n.diff]))).toEqual({ auth: 'unchanged', db: 'changed', web: 'added' });
    expect(cmp.edges.find((e) => e.from === 'web')!.diff).toBe('added');
    await expect(storage.architecture.get({ at: 'ffffffff' })).rejects.toMatchObject({ statusCode: 404 });
  });
  it('layers: explicit + derived, upward-edge violations, mermaid subgraph per layer (top to bottom)', async () => {
    const { storage, comp } = await setup();
    await comp('db', [sec('schema')], { kind: 'datastore', layer: 'data' });
    await comp('stripe', [sec('api')], { kind: 'external' });
    await comp('billing', [sec('core', { links: [dep(C('db', 'schema')), dep(C('stripe', 'api'))] })]);
    await comp('web', [sec('shell', { links: [dep(C('billing'))] })], { kind: 'module', layer: 'ui' });
    // A data-layer job depending on the UI: an upward edge.
    await comp('job', [sec('run', { links: [dep(C('web'))] })], { kind: 'module', layer: 'data' });

    const g = await storage.architecture.get({});
    expect(g.layers.map((l) => l.id)).toEqual(['ui', 'data']);
    const by = Object.fromEntries(g.nodes.map((n) => [n.id, `${n.layer}/${n.layerSource}`]));
    expect(by).toEqual({ db: 'data/explicit', stripe: 'data/derived', billing: 'ui/derived', web: 'ui/explicit', job: 'data/explicit' });
    expect(g.edges.filter((e) => e.violation).map((e) => `${e.from}->${e.to}`)).toEqual(['job->web']);
    expect(g.edges.filter((e) => !e.violation).every((e) => e.violation === undefined)).toBe(true);

    const mm = (await storage.architecture.get({ format: 'mermaid' })).mermaid!;
    const lines = mm.split('\n');
    expect(lines[0]).toBe('flowchart TB');
    expect(lines.indexOf('  subgraph layer_ui["UI"]')).toBeLessThan(lines.indexOf('  subgraph layer_data["Data"]'));
    expect(mm).toContain('    web["web"]');
    const vi = g.edges.findIndex((e) => e.violation);
    expect(mm).toContain(`  linkStyle ${vi} stroke:#e03131`);

    // Removing every explicit layer falls back to derived levels.
    for (const id of ['db', 'web', 'job']) await storage.components.update(id, { layer: null } as never);
    await expect(storage.components.update('db', { layer: 'Not valid' } as never)).rejects.toThrow();
    const d = await storage.architecture.get({});
    expect(d.layers.every((l) => l.derived)).toBe(true);
  });
});

describe('references', () => {
  it('builds, parses and resolves component and architecture references', async () => {
    const { storage, comp } = await setup();
    await comp('db', [sec('schema')], { kind: 'datastore' });
    expect(nodeKindOf(parseNodeUri(C('db'))!)).toBe('component');
    expect(nodeKindOf(parseNodeUri(C('db', 'schema'))!)).toBe('section');
    const a = parseNodeUri('mandate://architecture@abc1234?focus=db')!;
    expect(a).toEqual({ kind: 'architecture', commit: 'abc1234', focus: 'db' });
    expect(nodeKindOf(a)).toBe('architecture');
    expect((await resolveReference(storage, { uri: C('db', 'schema') })).sectionTitle).toBe('SCHEMA');
    const head = (await storage.git.log(1))[0]!.id;
    const r = await resolveReference(storage, { uri: `mandate://architecture@${head.slice(0, 7)}?focus=db` });
    expect(r).toMatchObject({ kind: 'architecture', commit: head, uri: `mandate://architecture@${head}?focus=db` });
    await expect(resolveReference(storage, { uri: 'mandate://architecture?focus=nope' })).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('containment (parent)', () => {
  it('validates the parent: exists, not itself, no cycles, archive rules (no cascade)', async () => {
    const { storage, comp } = await setup();
    await comp('billing', [sec('core')], { layer: 'domain' });
    await comp('invoices', [sec('core')], { parent: 'billing', kind: 'module' });
    await comp('pdf', [sec('core')], { parent: 'invoices', kind: 'library' });
    await expect(comp('orphan', [sec('core')], { parent: 'nope' })).rejects.toMatchObject({ code: 'invalid_parent' });
    await expect(storage.components.update('billing', { parent: 'billing' } as never)).rejects.toMatchObject({ code: 'invalid_parent' });
    // billing -> invoices -> pdf -> billing would close a loop.
    await expect(storage.components.update('billing', { parent: 'pdf' } as never)).rejects.toThrow(/containment cycle/);
    // Archiving a parent with live children fails; archiving bottom-up works.
    await expect(storage.components.update('billing', { status: 'archived' } as never)).rejects.toMatchObject({ code: 'has_children' });
    await storage.components.update('pdf', { status: 'archived' } as never);
    await storage.components.update('invoices', { status: 'archived' } as never);
    await storage.components.update('billing', { status: 'archived' } as never);
    // No live child under an archived parent.
    await expect(comp('late', [sec('core')], { parent: 'billing' })).rejects.toMatchObject({ code: 'archived_parent' });
    await expect(comp('late2', [sec('core')], { parent: 'billing', status: 'archived' })).resolves.toMatchObject({ parent: 'billing' });
  });

  it('children backlinks, inherited layers, nested mermaid, contains graph edges, owned code rolls up', async () => {
    const { git, storage, comp, spec } = await setup();
    await comp('db', [sec('schema')], { kind: 'datastore', layer: 'data' });
    await comp('billing', [sec('core')], { layer: 'domain', owns: [{ repo: 'app', paths: ['src/billing/**'] }] });
    await comp('invoices', [sec('core', { links: [dep(C('db', 'schema'))] })], { parent: 'billing', kind: 'module', owns: [{ repo: 'app', paths: ['src/billing/invoices/**'] }] });
    await comp('web', [sec('shell', { links: [dep(C('invoices'))] })], { kind: 'module', layer: 'ui' });
    await spec('inv', [sec('a', { refs: [{ repo: 'app', path: 'src/billing/invoices/pdf.ts' }] })]);

    const g = await storage.architecture.get({});
    const node = (id: string) => g.nodes.find((n) => n.id === id)!;
    expect(node('billing').children).toEqual(['invoices']);
    expect(node('invoices')).toMatchObject({ parent: 'billing', layer: 'domain', layerSource: 'inherited' });
    expect(node('db').parent).toBeUndefined();
    // The child owns the file (most specific glob) and the parent's rollup counts it too.
    expect(node('invoices').overlay.specs).toBe(1);
    expect(node('billing').overlay.specs).toBe(1);

    const m = (await storage.architecture.get({ format: 'mermaid' })).mermaid!;
    expect(m).toContain('  subgraph layer_domain["Domain"]\n    subgraph billing["billing"]\n      invoices["invoices"]\n    end\n  end');

    const derived = await deriveComponents([await storage.components.get('billing'), await storage.components.get('invoices')], await storage.model());
    expect(derived.billing!.children).toEqual([{ id: 'invoices', title: 'invoices', status: 'active' }]);
    expect(derived.invoices!.ancestors).toEqual([{ id: 'billing', title: 'billing' }]);

    const edges = componentEdges(await storage.model()).filter((e) => e.kind === 'contains');
    expect(edges).toEqual([{ from: 'mandate://components/billing', to: 'mandate://components/invoices', kind: 'contains', props: {} }]);
    void git;
  });
});

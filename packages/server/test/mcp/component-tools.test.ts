/**
 * Component write tools over MCP (create / meta / status / sections / links), read-your-write through the component read
 * tools, architecture_get and the component / architecture resources.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mcpFixture, type McpFixture } from './fixture.js';

let fx: McpFixture;
beforeAll(async () => {
  fx = await mcpFixture();
}, 120_000);
afterAll(async () => {
  await fx?.close();
});

const AGENT = 'writer@test';
async function ok(name: string, args: Record<string, unknown> = {}, agent = true) {
  const r = await fx.call(name, agent ? { agent: AGENT, ...args } : args);
  if (r.isError) throw new Error(`${name} failed: ${JSON.stringify(r.body.error)}`);
  return r.body;
}
async function fail(name: string, args: Record<string, unknown>) {
  const r = await fx.call(name, { agent: AGENT, ...args });
  expect(r.isError, `${name} should fail`).toBe(true);
  return r.body.error as { code: string; message: string };
}

describe('component write tools', () => {
  it('create, meta, sections, links, status: every write is a commit and reads back', async () => {
    const id = `cmp-${Date.now().toString(36)}`;
    const c = await ok('component_create', {
      id,
      title: 'Search worker',
      kind: 'service',
      owns: [{ repo: 'app', paths: ['src/search/**'] }],
      sections: [{ id: 'responsibility', title: 'Responsibility', summary: 'Indexes documents.', body: 'Indexes documents for search.' }],
    });
    expect(c.ref).toBe(`mandate://components/${id}`);
    expect(c.commit).toMatch(/^[0-9a-f]{40}$/);
    expect((await ok('component_update_meta', { ref: id, tags: ['search'], owns: [{ repo: 'app', paths: ['src/search/**', 'src/index/**'] }] })).document.tags).toEqual(['search']);
    const ins = await ok('component_section_insert', { doc: id, section: { id: 'storage', title: 'Storage', summary: 'Where it stores.', body: 'Uses postgres.' }, position: 'first' });
    expect(ins.section.id).toBe('storage');
    await ok('component_section_update', { ref: `mandate://components/${id}/sections/storage`, body: 'Uses the postgres schema.' });
    await ok('component_section_move', { ref: `mandate://components/${id}/sections/storage`, position: 'last' });
    const l = await ok('component_section_link_add', { ref: `mandate://components/${id}/sections/storage`, to: 'mandate://components/postgres/sections/schema', rel: 'depends_on' });
    expect(l.section.links[0].rel).toBe('depends_on');
    // A component cannot link to a spec (link rules of the data model).
    expect((await fail('component_section_link_add', { ref: `mandate://components/${id}/sections/storage`, to: 'mandate://specs/login-sso/sections/auth-flow', rel: 'relates_to' })).code).toBeTruthy();
    const arch = await ok('architecture_get', { focus: id }, false);
    expect(arch.edges).toEqual(expect.arrayContaining([expect.objectContaining({ from: id, to: 'postgres', section: 'schema' })]));
    expect((await ok('code_owner', { repo: 'app', path: 'src/index/a.ts' }, false)).owner.id).toBe(id);
    await ok('component_section_link_remove', { ref: `mandate://components/${id}/sections/storage`, to: 'mandate://components/postgres/sections/schema' });
    expect((await ok('architecture_get', {}, false)).edges.some((e: { from: string }) => e.from === id)).toBe(false);
    await ok('component_section_archive', { ref: `mandate://components/${id}/sections/storage` });
    expect((await ok('component_section_get', { ref: `mandate://components/${id}/sections/storage` }, false)).section.meta.archived).toBe(true);
    expect((await ok('component_status_set', { ref: id, status: 'deprecated' })).status).toBe('deprecated');
    expect((await ok('component_get', { ref: id, metadataOnly: true }, false)).frontmatter.status).toBe('deprecated');
    expect((await fail('component_status_set', { ref: id, status: 'retired' })).code).toBe('invalid_input');
    expect((await ok('component_list', { status: ['deprecated'] }, false)).items.map((x: { id: string }) => x.id)).toContain(id);
  }, 60_000);
  it('layer: set on create and through update_meta (validated), removed with null, exposed by architecture_get', async () => {
    const id = `lyr-${Date.now().toString(36)}`;
    expect((await ok('component_create', { id, title: 'Layered', kind: 'module', layer: 'domain' })).document.layer).toBe('domain');
    expect((await fail('component_create', { id: `${id}-bad`, title: 'Bad', kind: 'module', layer: 'Not A Layer' })).code).toBe('invalid_input');
    expect((await fail('component_update_meta', { ref: id, layer: 'api layer' })).code).toBe('invalid_input');
    await ok('component_update_meta', { ref: id, layer: 'service' });
    expect((await ok('component_get', { ref: id, metadataOnly: true }, false)).frontmatter.layer).toBe('service');
    let arch = await ok('architecture_get', {}, false);
    const node = () => arch.nodes.find((n: { id: string }) => n.id === id);
    expect(node()).toMatchObject({ layer: 'service', layerSource: 'explicit' });
    expect(arch.layers.map((l: { id: string }) => l.id)).toContain('service');
    await ok('component_update_meta', { ref: id, layer: null });
    expect((await ok('component_get', { ref: id, metadataOnly: true }, false)).frontmatter.layer).toBeUndefined();
    arch = await ok('architecture_get', {}, false);
    expect(node().layerSource).toBe('derived');
    const mm = await ok('architecture_get', { format: 'mermaid' }, false);
    expect(mm.mermaid).toMatch(/^flowchart TB\n {2}subgraph layer_/);
  }, 60_000);
});

describe('archived components', () => {
  it('archive: hidden from the architecture, still resolvable, owns nothing, links to it rejected or broken, final', async () => {
    const t = Date.now().toString(36);
    const [a, b, spec] = [`arc-a-${t}`, `arc-b-${t}`, `arc-spec-${t}`];
    const sec = { id: 'api', title: 'API', summary: 'Its API.', body: 'The API.' };
    await ok('component_create', { id: a, title: 'Archived soon', kind: 'module', owns: [{ repo: 'zz-repo', paths: ['lib/**'] }], sections: [sec] });
    await ok('component_create', { id: b, title: 'Depends on it', kind: 'module', sections: [sec] });
    await ok('component_section_link_add', { ref: `mandate://components/${b}/sections/api`, to: `mandate://components/${a}`, rel: 'depends_on' });
    await ok('spec_create', { id: spec, title: `Spec ${spec}`, sections: [{ id: 'overview', title: 'Overview', summary: 'What.', body: 'Body.' }] });
    await ok('spec_section_link_add', { ref: `mandate://specs/${spec}/sections/overview`, to: `mandate://components/${a}`, rel: 'affects' });
    expect((await ok('code_owner', { repo: 'zz-repo', path: 'lib/x.ts' }, false)).owner.id).toBe(a);

    expect((await ok('component_archive', { ref: a, reason: 'replaced' })).status).toBe('archived');
    const arch = await ok('architecture_get', {}, false);
    expect(arch.nodes.map((n: { id: string }) => n.id)).not.toContain(a);
    expect(arch.edges.some((e: { to: string }) => e.to === a)).toBe(false);
    const all = await ok('architecture_get', { includeArchived: true }, false);
    expect(all.nodes.find((n: { id: string }) => n.id === a).status).toBe('archived');
    expect(all.edges).toEqual(expect.arrayContaining([expect.objectContaining({ from: b, to: a })]));
    expect((await ok('component_get', { ref: a, metadataOnly: true }, false)).frontmatter.status).toBe('archived');
    expect((await ok('code_owner', { repo: 'zz-repo', path: 'lib/x.ts' }, false)).owner).toBeNull();
    // Graph side (incremental index): the architecture node hides it, the Component node keeps its status.
    const node = await ok('graph_node', { uri: 'mandate://architecture' }, false);
    expect(node.node.props.components).not.toContain(`mandate://components/${a}`);
    expect(node.node.props.components).toContain(`mandate://components/${b}`);
    const rows = (await ok('graph_query', { query: 'MATCH (c:Component {ref: $r}) RETURN c.status', params: { r: `mandate://components/${a}` } }, false)).rows;
    expect(rows).toEqual([['archived']]);
    // Existing links: "Broken dependency".
    expect((await ok('component_get', { ref: b }, false)).links.sections.api.broken).toBe(true);
    expect((await ok('spec_get', { ref: spec }, false)).links.sections.overview.broken).toBe(true);
    // New links to it are rejected; archived is final.
    await ok('component_section_insert', { doc: b, section: { id: 'more', title: 'More', summary: 'More.', body: 'More.' } });
    expect((await fail('component_section_link_add', { ref: `mandate://components/${b}/sections/more`, to: `mandate://components/${a}`, rel: 'depends_on' })).message).toMatch(/archived/);
    expect((await fail('component_status_set', { ref: a, status: 'active' })).message).toMatch(/not allowed/);
  }, 60_000);
});

describe('resources', () => {
  it('component docs and sections, and the architecture view', async () => {
    const doc = await fx.client.readResource({ uri: 'mandate://components/auth-service' });
    expect((doc.contents[0] as { text: string }).text).toContain('title: Auth service');
    const sec = await fx.client.readResource({ uri: 'mandate://components/auth-service/sections/sessions-api' });
    expect((sec.contents[0] as { text: string }).text).toContain('depends_on mandate://components/postgres/sections/schema');
    const arch = JSON.parse(((await fx.client.readResource({ uri: 'mandate://architecture?focus=auth-service' })).contents[0] as { text: string }).text);
    expect(arch.mermaid).toContain('flowchart');
    expect(arch.nodes.find((n: { id: string }) => n.id === 'auth-service').focus).toBe('focus');
    const { resources } = await fx.client.listResources();
    expect(resources.map((r) => r.uri)).toEqual(expect.arrayContaining(['mandate://architecture', 'mandate://components/auth-service']));
  });
});

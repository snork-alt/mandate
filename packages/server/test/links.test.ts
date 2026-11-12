import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createSpecSchema, createStandardSchema, standardUsage } from '@mandate/shared';
import { createStorage, setSpecStatus } from '../src/storage/index.js';
import { cleanupTempDirs, newStore, tempDir } from './helpers.js';

afterEach(cleanupTempDirs);

const sec = (id: string, extra: object = {}) => ({ id, title: id.toUpperCase(), body: `${id} body`, ...extra });
const link = (to: string, rel: string, note?: string) => ({ to, rel, ...(note ? { note } : {}) });

async function setup() {
  const git = await newStore(path.join(await tempDir(), 'repo'));
  const storage = createStorage(git);
  const spec = (id: string, sections: object[], extra: object = {}) => storage.specs.create(createSpecSchema.parse({ id, title: id, sections, ...extra }));
  const std = (id: string, sections: object[], extra: object = {}) => storage.standards.create(createStandardSchema.parse({ id, title: id, sections, ...extra }));
  return { git, storage, spec, std };
}

describe('section links', () => {
  it('validates targets: existing section of another document, allowed direction and rel, no cycles', async () => {
    const { storage, spec, std } = await setup();
    await spec('a', [sec('one'), sec('two')]);
    await spec('b', [sec('x')]);
    await std('sec', [sec('rule')]);
    const bad = async (sections: object[]) => expect(spec('c', sections)).rejects.toMatchObject({ statusCode: 400 });
    await bad([sec('s', { links: [link('mandate://specs/nope/sections/x', 'relates_to')] })]); // missing spec
    await bad([sec('s', { links: [link('mandate://specs/a/sections/zz', 'relates_to')] })]); // missing section
    await bad([sec('s', { links: [link('mandate://specs/c/sections/t', 'relates_to')] }), sec('t')]); // same document
    await bad([sec('s', { links: [link('mandate://standards/sec/sections/rule', 'depends_on')] })]); // wrong rel for spec -> standard
    await bad([sec('s', { links: [link('mandate://standards/sec/sections/rule', 'deviates_from')] })]); // note required
    await expect(std('std2', [sec('r', { links: [link('mandate://specs/a/sections/one', 'relates_to')] })])).rejects.toThrow(/never link to specs/);
    await expect(std('std3', [sec('r', { links: [link('mandate://standards/sec/sections/rule', 'depends_on')] })])).rejects.toThrow(/cannot depend/);

    // depends_on cycle a/one -> b/x -> a/one
    const a = await storage.specs.get('a');
    await storage.specs.update('a', { sections: a.sections.map((s) => (s.id === 'one' ? { ...s, links: [{ to: 'mandate://specs/b/sections/x', rel: 'depends_on' as const }] } : s)) });
    const b = await storage.specs.get('b');
    await expect(
      storage.specs.update('b', { sections: b.sections.map((s) => ({ ...s, links: [{ to: 'mandate://specs/a/sections/one', rel: 'depends_on' as const }] })) }),
    ).rejects.toThrow(/depends_on cycle/);
  });

  it('computes backlinks, blocked and upstream changed', async () => {
    const { git, storage, spec } = await setup();
    await spec('target', [sec('api'), sec('done-part')]);
    const c1 = (await git.log(1))[0]!.id.slice(0, 7);
    const t = await storage.specs.get('target');
    await storage.specs.update('target', { sections: t.sections.map((s) => (s.id === 'done-part' ? { ...s, implementedCommit: c1 } : s)) });
    await spec('source', [
      sec('needs-api', { links: [link('mandate://specs/target/sections/api', 'depends_on')] }),
      sec('uses-done', { links: [link('mandate://specs/target/sections/done-part', 'depends_on'), link('mandate://specs/target/sections/api', 'relates_to', 'see api')] }),
    ]);
    // Implement the source section, then change its upstream target.
    const src = await storage.specs.get('source');
    const c2 = (await git.log(1))[0]!.id.slice(0, 7);
    await storage.specs.update('source', { sections: src.sections.map((s) => (s.id === 'uses-done' ? { ...s, implementedCommit: c2 } : s)) });
    const t2 = await storage.specs.get('target');
    await storage.specs.update('target', { sections: t2.sections.map((s) => (s.id === 'done-part' ? { ...s, body: 'changed upstream' } : s)) });

    const links = await storage.linkService.forDoc('specs', await storage.specs.get('source'));
    expect(links.sections['needs-api']).toMatchObject({ blocked: true, upstreamChanged: false });
    expect(links.sections['uses-done']).toMatchObject({ blocked: false, upstreamChanged: true });
    expect(links.sections['uses-done']!.outgoing[0]).toMatchObject({ docTitle: 'target', sectionTitle: 'DONE-PART', implemented: true, upstreamChanged: true });

    const back = await storage.linkService.forDoc('specs', await storage.specs.get('target'));
    expect(back.sections.api!.backlinks.map((b) => [b.sectionId, b.rel])).toEqual([
      ['needs-api', 'depends_on'],
      ['uses-done', 'relates_to'],
    ]);
    expect(await storage.linkService.blockedSections(await storage.specs.list())).toMatchObject({ source: ['needs-api'], target: [] });
  });
});

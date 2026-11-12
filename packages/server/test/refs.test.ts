import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createSpecSchema } from '@mandate/shared';
import { createStorage, resolveReference } from '../src/storage/index.js';
import { cleanupTempDirs, newStore, tempDir } from './helpers.js';

afterEach(cleanupTempDirs);

describe('resolveReference', () => {
  it('resolves short shas to full ones and maps lines against the old version', async () => {
    const git = await newStore(path.join(await tempDir(), 'repo'));
    const storage = createStorage(git);
    await storage.specs.create(createSpecSchema.parse({ id: 'doc', title: 'Doc', sections: [{ id: 'tokens', title: 'Tokens', body: 'Tokens rotate.\nOld line.' }] }));
    const v1 = (await git.log(1))[0]!.id;
    // Later the section is renamed away; the old reference must still resolve at v1.
    await storage.specs.update('doc', { sections: [{ id: 'keys', title: 'Keys', type: 'markdown', refs: [], symbols: [], links: [], verifiedBy: [], body: 'Keys rotate.' }] });

    const raw = await storage.git.readFileAt(v1, 'specs/doc.md');
    const line = raw!.split('\n').findIndex((l) => l === 'Old line.') + 1;
    const r = await resolveReference(storage, { uri: `@mandate:mandate://specs/doc@${v1.slice(0, 7)}/sections/tokens#L${line}` });
    expect(r).toMatchObject({ uri: `mandate://specs/doc@${v1}/sections/tokens#L${line}`, commit: v1, sectionTitle: 'Tokens', existsAtHead: false, text: 'Old line.' });

    const latest = await resolveReference(storage, { uri: 'mandate://specs/doc/sections/keys' });
    expect(latest).toMatchObject({ uri: 'mandate://specs/doc/sections/keys', sectionTitle: 'Keys', existsAtHead: true });
    await expect(resolveReference(storage, { uri: 'mandate://specs/doc@deadbeef' })).rejects.toMatchObject({ statusCode: 404 });
    await expect(resolveReference(storage, { uri: 'nope' })).rejects.toMatchObject({ statusCode: 400 });
  });
});

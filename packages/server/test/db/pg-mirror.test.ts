/** The index mirror on its own: publish from a small SQLite build, incremental changes, schema drop per project. */
import { expect, it } from 'vitest';
import { openIndexDb } from '../../src/index/db.js';
import { dropIndexSchema, IndexMirror, indexDb } from '../../src/db/pg-index/mirror.js';
import type { PostgresDb } from '../../src/db/postgres.js';
import { BACKENDS, useBackendCleanup } from './backends.js';

useBackendCleanup();

for (const b of BACKENDS.filter((x) => x.name !== 'sqlite')) {
  for (const mode of [true, 'prefix'] as const) {
    it(`[${b.name}] publishes full then incremental, and drops the project's index (schemaPerProject: ${mode})`, async () => {
      const base = (await b.open()) as PostgresDb;
      const id = `p${Math.random().toString(36).slice(2, 7)}`;
      const build = openIndexDb(':memory:');
      const ins = build.prepare("INSERT INTO nodes (uri, kind, label, props, source, valid_from, valid_to) VALUES (?, 'spec', ?, '{}', 's', 1, NULL)");
      ins.run('mandate://specs/a', 'A');
      build.prepare("INSERT INTO fts_sections (uri, source, title, summary, body, symbols) VALUES ('mandate://specs/a', 's', 'Retry policy', '', 'body', '')").run();
      const db = indexDb(base, id, mode);
      const m = new IndexMirror(build, db, id);
      expect((await m.publish()).mode).toBe('full');
      ins.run('mandate://specs/b', 'B');
      build.prepare("UPDATE nodes SET valid_to = 2 WHERE uri = 'mandate://specs/a'").run();
      const r = await m.publish();
      expect(r.mode).toBe('incremental');
      expect(await db.all(`SELECT uri, valid_to FROM ${db.dialect.table('nodes')} ORDER BY uri`)).toEqual([
        { uri: 'mandate://specs/a', valid_to: 2 },
        { uri: 'mandate://specs/b', valid_to: null },
      ]);
      expect((await m.publish()).mode).toBe('none');
      expect(await db.get(`SELECT uri FROM ${db.dialect.table('fts_sections')} WHERE tsv @@ to_tsquery('english', 'retry')`)).toEqual({ uri: 'mandate://specs/a' });
      await dropIndexSchema(base, id, mode);
      const left = await base.get<{ n: number }>("SELECT COUNT(*) AS n FROM pg_class c JOIN pg_namespace s ON s.oid = c.relnamespace WHERE (s.nspname = ? OR c.relname LIKE ?) AND c.relkind = 'r'", [`mandate_${id}`, `p\\_${id}\\_%`]);
      expect(left!.n).toBe(0);
      build.close();
    });
  }
}

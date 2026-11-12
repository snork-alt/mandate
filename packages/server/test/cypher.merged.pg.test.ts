// The Cypher contract suite over merged history, on the Postgres index (see cypher.pg.test.ts).
process.env.MANDATE_FIXTURE_KIND = 'merged';
process.env.MANDATE_INDEX_BACKEND ??= 'pglite';
await import('./cypher.test.js');

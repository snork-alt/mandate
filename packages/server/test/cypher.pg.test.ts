// The Cypher contract suite on the Postgres index (PGlite; real Postgres with MANDATE_INDEX_BACKEND=postgres +
// MANDATE_TEST_PG_URL): the SQLite build is published to a project schema and every graph_query runs there.
process.env.MANDATE_INDEX_BACKEND ??= 'pglite';
await import('./cypher.test.js');

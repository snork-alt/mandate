// The same suite over merged history (two clones, a true merge, a fast-forward pull): see graph-fixture.ts.
process.env.MANDATE_FIXTURE_KIND = 'merged';
await import('./cypher.test.js');

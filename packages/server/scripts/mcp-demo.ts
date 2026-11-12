/**
 * MCP demo against a running server: `npx tsx scripts/mcp-demo.ts [http://127.0.0.1:4000/mcp]`.
 * Lists tools, runs one query of each search type, reads a resource from an `@mandate:` reference,
 * traverses the graph from a copied versioned reference and runs a Cypher query.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const url = new URL(process.argv[2] ?? 'http://127.0.0.1:4000/mcp');
const client = new Client({ name: 'mandate-demo', version: '0.1.0' });
await client.connect(new StreamableHTTPClientTransport(url));

type Json = Record<string, any>;
async function call(name: string, args: Json): Promise<Json> {
  const r = await client.callTool({ name, arguments: args });
  const body = r.structuredContent as Json;
  if (r.isError) throw new Error(`${name}: ${JSON.stringify(body.error)}`);
  return body;
}
const show = (label: string, v: unknown) => console.log(`\n# ${label}\n${typeof v === 'string' ? v : JSON.stringify(v, null, 1).slice(0, 700)}`);

const { tools } = await client.listTools();
show(`tools (${tools.length})`, tools.map((t) => t.name).join(', '));

const s = await call('search', { q: 'refresh token rotation', limit: 3 });
show('search (hybrid)', s.groups.map((g: Json) => `${g.docUri}: ${g.hits.map((h: Json) => `${h.sectionTitle ?? '(doc)'} [${h.matchedBy}]`).join('; ')}`));
const sem = await call('search', { q: 'how do users stay logged in', mode: 'semantic', limit: 3 });
show('search (semantic)', sem.groups.map((g: Json) => g.docUri));
const t = await call('text_search', { q: 'token', limit: 3 });
show('text_search', t.matches.slice(0, 3).map((m: Json) => `${m.uri}: ${m.text}`.slice(0, 140)));
const sym = await call('symbol_search', { name: 'authservce', match: 'fuzzy', limit: 3 });
show('symbol_search (fuzzy "authservce")', sym.symbols?.map((x: Json) => x.name ?? x.uri) ?? sym);
const code = await call('code_search', { repo: 'app', path: 'src/auth', limit: 5 });
show('code_search app src/auth', code.refs.map((h: Json) => `${h.sectionUri} -> ${h.uri}`));
const rel = await call('related', { uri: 'mandate://specs/user-sessions', limit: 3 });
show('related(user-sessions)', (rel.items ?? []).map((i: Json) => `${i.uri} ${Number(i.score).toFixed(2)}`));
const meta = await call('metadata_query', { kinds: ['spec'], status: ['ready'] });
show('metadata_query ready specs', (meta.items ?? []).map((i: Json) => i.uri));
const hist = await call('history_search', { changeKinds: ['status'], limit: 3 });
show('history_search status changes', (hist.commits ?? hist.items ?? []).map((c: Json) => `${String(c.sha ?? c.id).slice(0, 7)} ${c.subject}`));
const gs = await call('graph_search', { q: 'session store', limit: 3 });
show('graph_search', (gs.nodes ?? gs.items ?? []).map((n: Json) => n.ref ?? n.uri));

// A copied reference, versioned: pin the latest commit of login-sso.
const h = await call('history_get', { ref: 'mandate://specs/login-sso', limit: 1 });
const sha = String(h.entries[0].id ?? h.entries[0].commit).slice(0, 7);
const mention = `@mandate:mandate://specs/login-sso@${sha}/sections/auth-flow`;
const res = await client.readResource({ uri: mention.replace(/^@mandate:/, '') });
show(`resources/read ${mention}`, (res.contents[0] as { text: string }).text.slice(0, 500));

const node = await call('graph_node', { uri: mention });
show('graph_node (versioned ref)', { ref: node.node?.ref, kind: node.node?.kind, label: node.node?.label });
const nb = await call('graph_neighbors', { uri: mention, depth: 2, limit: 15 });
show('graph_neighbors depth 2 from the versioned ref', (nb.nodes ?? nb.groups ?? []).slice(0, 15).map((n: Json) => n.ref ?? n.uri ?? n.kind));

const q = await call('graph_query', {
  query: 'MATCH (d:Spec)-[:HAS_SECTION]->(s)-[:MENTIONS_SYMBOL]->(y:Symbol) RETURN d.ref AS spec, count(DISTINCT y) AS symbols ORDER BY symbols DESC LIMIT 5',
});
show('graph_query (Cypher)', { columns: q.columns, rows: q.rows });

await client.close();

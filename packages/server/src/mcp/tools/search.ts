/** Search tools: every kind of search over the index (thin wrappers over IndexService). */
import {
  codeSearchInputSchema,
  graphSearchInputSchema,
  historySearchInputSchema,
  metadataQueryInputSchema,
  relatedInputSchema,
  searchInputSchema,
  symbolSearchInputSchema,
  textSearchInputSchema,
} from '@mandate/shared';
import { defineTool, needIndex } from '../define.js';

const FILTERS = 'Filters: kinds (spec|standard|section|work_order|feedback), status, category, repo, tags, standards, sectionType, updatedSince/updatedUntil (ISO date), within (a doc or section reference: search inside it).';

export const searchTools = [
  defineTool({
    name: 'search',
    title: 'Search (hybrid)',
    kind: 'read',
    description: `Find specs, standards, sections, work orders and feedback. mode: hybrid (default: BM25 + vectors + symbols fused with RRF), text or semantic.
Returns groups by document (best first), each with up to 5 hits: uri with #Lx-Ly, section title, snippet (<mark> around matches), matchedBy (text|semantic|symbol); plus facet counts, total and nextCursor. limit = documents per page (≤50).
${FILTERS}
Start here, then follow refs with graph_* tools and read with spec_get / spec_section_get.
Example: {"q":"refresh token rotation","kinds":["section"],"status":["ready"]}`,
    input: searchInputSchema,
    run: (a, ctx) => needIndex(ctx).search(a),
  }),
  defineTool({
    name: 'text_search',
    title: 'Text search (literal / regex)',
    kind: 'read',
    description: `Exact matching over bodies, grep-style (no stemming): q is a literal phrase by default; regex: true for a JavaScript regex; caseSensitive; wholeWord. Returns each match with uri, line numbers and the matching line. ${FILTERS}
Example: {"q":"refresh-token rotation"} or {"q":"Session(Store|Manager)\\\\.\\\\w+","regex":true}`,
    input: textSearchInputSchema,
    run: (a, ctx) => needIndex(ctx).textSearch(a),
  }),
  defineTool({
    name: 'symbol_search',
    title: 'Symbol search',
    kind: 'read',
    description: `Find code symbols mentioned by sections (identifier-aware: camelCase / snake_case / dot parts). match: exact (default; also normalized and identifier-part matches), prefix, or fuzzy (trigram typo tolerance). Returns each symbol with the sections using it.
Example: {"name":"AuthService.login"} or {"name":"authservce","match":"fuzzy"}`,
    input: symbolSearchInputSchema,
    run: (a, ctx) => needIndex(ctx).symbolSearch(a),
  }),
  defineTool({
    name: 'code_search',
    title: 'Code reference search',
    kind: 'read',
    description: `Sections and documents referencing code: give repo and a path (file or directory), a glob, and optional lines (N or N-M; ranges match by overlap). Use it to find the specs governing code you are about to edit.
Example: {"repo":"app","path":"src/auth/session.ts","lines":"30-35"} or {"glob":"src/**/*.ts"}`,
    input: codeSearchInputSchema,
    run: (a, ctx) => needIndex(ctx).codeSearch(a),
  }),
  defineTool({
    name: 'related',
    title: 'Related items',
    kind: 'read',
    description: `Semantic nearest neighbours of any doc or section reference (duplicates, applicable standards, overlapping specs). kinds narrows the result kinds.
Example: {"uri":"mandate://specs/user-sessions/sections/overview","limit":5}`,
    input: relatedInputSchema,
    run: (a, ctx) => needIndex(ctx).related(a),
  }),
  defineTool({
    name: 'metadata_query',
    title: 'Metadata query',
    kind: 'read',
    description: `Purely structured listing over documents (no text query): kinds (spec|standard|work_order|feedback), status, category, repo, tags, owner, priority, standards, staleClaim (in_progress claims without heartbeat for 30 min), outdated (sections changed since implemented), minOpenFeedback, updatedSince/Until. Paginated.
Example: {"kinds":["spec"],"status":["ready","done"],"outdated":true}`,
    input: metadataQueryInputSchema,
    run: (a, ctx) => needIndex(ctx).metadataQuery(a),
  }),
  defineTool({
    name: 'history_search',
    title: 'History search',
    kind: 'read',
    description: `Search commits: q over messages and trailers, uri (a doc/section/any node reference), author, agent, branch, feedback (id in a Feedback trailer), changeKinds (text|metadata|status), since/until (ISO dates). Paginated.
Example: {"agent":"my-agent","changeKinds":["status"],"since":"2026-11-01"}`,
    input: historySearchInputSchema,
    run: (a, ctx) => needIndex(ctx).historySearch(a),
  }),
  defineTool({
    name: 'graph_search',
    title: 'Graph entry points',
    kind: 'read',
    description: `Search returning graph nodes (docs, sections, symbols, code files) as entry points for graph_neighbors / graph_path / graph_impact / graph_query.
Example: {"q":"session store"}`,
    input: graphSearchInputSchema,
    run: (a, ctx) => needIndex(ctx).graphSearch(a),
  }),
];

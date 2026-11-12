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

const FILTERS = 'Filters: kinds, status, category, repo, tags, standards, sectionType, updatedSince/Until, within (search inside a doc or section).';

export const searchTools = [
  defineTool({
    name: 'search',
    title: 'Search (hybrid)',
    kind: 'read',
    description: `Find specs, standards, sections, work orders and feedback. Start here.
mode: hybrid (default), text or semantic. Returns hits grouped by document (≤ 5 each: uri#Lx-Ly, title, snippet, matchedBy), facets, total, nextCursor; limit = documents per page. ${FILTERS}
Example: {"q":"refresh token rotation","kinds":["section"]}`,
    input: searchInputSchema,
    run: (a, ctx) => needIndex(ctx).search(a),
  }),
  defineTool({
    name: 'text_search',
    title: 'Text search (literal / regex)',
    kind: 'read',
    description: `Exact grep-style matching over bodies: q is a literal phrase (regex: true for a JS regex; caseSensitive, wholeWord). Returns uri, line numbers and line. ${FILTERS}
Example: {"q":"Session(Store|Manager)\\\\.\\\\w+","regex":true}`,
    input: textSearchInputSchema,
    run: (a, ctx) => needIndex(ctx).textSearch(a),
  }),
  defineTool({
    name: 'symbol_search',
    title: 'Symbol search',
    kind: 'read',
    description: `Find code symbols mentioned by sections, with the sections using them. match: exact (default; identifier-part aware), prefix or fuzzy.
Example: {"name":"AuthService.login"}`,
    input: symbolSearchInputSchema,
    run: (a, ctx) => needIndex(ctx).symbolSearch(a),
  }),
  defineTool({
    name: 'code_search',
    title: 'Code reference search',
    kind: 'read',
    description: `Sections and docs referencing code: repo + path (file or dir) or glob, optional lines (N or N-M, overlap). Use before editing code to find its specs.
Example: {"repo":"app","path":"src/auth/session.ts","lines":"30-35"}`,
    input: codeSearchInputSchema,
    run: (a, ctx) => needIndex(ctx).codeSearch(a),
  }),
  defineTool({
    name: 'related',
    title: 'Related items',
    kind: 'read',
    description: `Semantic nearest neighbours of a doc or section ref (duplicates, applicable standards, overlapping specs); kinds narrows result kinds.
Example: {"uri":"mandate://specs/user-sessions/sections/overview","limit":5}`,
    input: relatedInputSchema,
    run: (a, ctx) => needIndex(ctx).related(a),
  }),
  defineTool({
    name: 'metadata_query',
    title: 'Metadata query',
    kind: 'read',
    description: `Structured listing over documents (no text query): kinds, status, category, repo, tags, owner, priority, standards, staleClaim (no heartbeat for 30 min), outdated (changed since implemented), minOpenFeedback, updatedSince/Until. Paginated.
Example: {"kinds":["spec"],"outdated":true}`,
    input: metadataQueryInputSchema,
    run: (a, ctx) => needIndex(ctx).metadataQuery(a),
  }),
  defineTool({
    name: 'history_search',
    title: 'History search',
    kind: 'read',
    description: `Search commits: q (messages and trailers), uri, author, agent, branch, feedback id, changeKinds, since/until. Paginated.
Example: {"agent":"my-agent","changeKinds":["status"],"since":"2026-11-01"}`,
    input: historySearchInputSchema,
    run: (a, ctx) => needIndex(ctx).historySearch(a),
  }),
  defineTool({
    name: 'graph_search',
    title: 'Graph entry points',
    kind: 'read',
    description: `Search returning graph nodes (docs, sections, symbols, code files) as entry points for graph_* tools.
Example: {"q":"session store"}`,
    input: graphSearchInputSchema,
    run: (a, ctx) => needIndex(ctx).graphSearch(a),
  }),
];

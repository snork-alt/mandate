/**
 * `mandate://` URIs as MCP resources, so `@mandate:mandate://...` mentions in MCP clients (coding agents) resolve to content.
 * A doc resource returns the stored file (at the pinned commit for `@sha`); a section returns its markdown plus a
 * metadata header; `#Lx-Ly` returns that excerpt; work orders and feedback return their resolved JSON; other graph
 * nodes (symbols, code, commits, ...) return their graph node; `mandate://architecture[@sha][?focus=id]` the architecture view.
 */
import { McpError, ErrorCode, type ReadResourceResult, type Resource, type ResourceTemplate } from '@modelcontextprotocol/sdk/types.js';
import { buildRef, parseNodeUri, parseRef } from '@mandate/shared';
import type { ToolContext } from './define.js';
import { toToolError } from './errors.js';

const DOC_KINDS = [
  ['specs', 'spec'],
  ['standards', 'standard'],
  ['components', 'component'],
] as const;

export const RESOURCE_TEMPLATES: ResourceTemplate[] = [
  ...DOC_KINDS.flatMap(([k, label]) => [
    { uriTemplate: `mandate://${k}/{id}`, name: `${label}`, title: `A ${label} (markdown file)`, mimeType: 'text/markdown' },
    { uriTemplate: `mandate://${k}/{id}/sections/{section}`, name: `${label}-section`, title: `A ${label} section (markdown with a metadata header)`, mimeType: 'text/markdown' },
    { uriTemplate: `mandate://${k}/{id}@{sha}`, name: `${label}-version`, title: `A ${label} at a commit`, mimeType: 'text/markdown' },
    { uriTemplate: `mandate://${k}/{id}@{sha}/sections/{section}`, name: `${label}-section-version`, title: `A ${label} section at a commit`, mimeType: 'text/markdown' },
    { uriTemplate: `mandate://${k}/{id}/sections/{section}#L{start}-L{end}`, name: `${label}-excerpt`, title: `Lines of a ${label} file (excerpt)`, mimeType: 'text/markdown' },
  ]),
  { uriTemplate: 'mandate://architecture{?focus}', name: 'architecture', title: 'The architecture view (components, depends_on edges, overlays; JSON with a Mermaid flowchart)', mimeType: 'application/json' },
  { uriTemplate: 'mandate://architecture@{sha}{?focus}', name: 'architecture-version', title: 'The architecture view at a commit', mimeType: 'application/json' },
  { uriTemplate: 'mandate://work-orders/{id}', name: 'work-order', title: 'A work order (resolved, JSON)', mimeType: 'application/json' },
  { uriTemplate: 'mandate://feedback/{id}', name: 'feedback', title: 'A feedback item (resolved, JSON)', mimeType: 'application/json' },
  { uriTemplate: 'mandate://{kind}/{name}', name: 'graph-node', title: 'Any other graph node (symbols, code, commits, repos, agents, verifications) as JSON', mimeType: 'application/json' },
];

const MAX_LISTED = 2000;

/** Concrete resources: every live spec / standard and their sections, work orders and feedback. */
export async function listResources(ctx: ToolContext): Promise<Resource[]> {
  const out: Resource[] = [];
  for (const [kind, label] of DOC_KINDS) {
    const docs = kind === 'specs' ? await ctx.storage.specs.list() : kind === 'standards' ? await ctx.storage.standards.list() : await ctx.storage.components.list();
    for (const d of docs) {
      out.push({ uri: buildRef({ kind, id: d.id }), name: d.title, title: `${d.title} (${label})`, mimeType: 'text/markdown', ...(d.summary ? { description: d.summary } : {}) });
      for (const s of d.sections) {
        out.push({ uri: buildRef({ kind, id: d.id, sectionId: s.id }), name: `${d.title} › ${s.title}`, mimeType: 'text/markdown', ...(s.summary ? { description: s.summary } : {}) });
      }
    }
  }
  out.push({ uri: 'mandate://architecture', name: 'Architecture', title: 'Architecture (generated view)', mimeType: 'application/json' });
  for (const w of await ctx.storage.workOrderService.list()) {
    out.push({ uri: buildRef({ kind: 'work-orders', id: w.id }), name: `Work order ${w.id} (${w.kind} ${w.spec}, ${w.status})`, mimeType: 'application/json' });
  }
  for (const f of await ctx.storage.feedback.list()) {
    out.push({ uri: buildRef({ kind: 'feedback', id: f.id }), name: `Feedback ${f.id} (${f.kind}, ${f.status})`, mimeType: 'application/json' });
  }
  return out.slice(0, MAX_LISTED);
}

const yamlValue = (v: unknown) => (typeof v === 'string' && !/[:#\n]/.test(v) ? v : JSON.stringify(v));
const header = (fields: Record<string, unknown>) =>
  `---\n${Object.entries(fields)
    .filter(([, v]) => v !== undefined && v !== null && !(Array.isArray(v) && !v.length))
    .map(([k, v]) => `${k}: ${yamlValue(v)}`)
    .join('\n')}\n---\n`;

const json = (uri: string, value: unknown): ReadResourceResult => ({ contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(value, null, 2) }] });
const md = (uri: string, text: string): ReadResourceResult => ({ contents: [{ uri, mimeType: 'text/markdown', text }] });

function fail(e: unknown, uri: string): never {
  if (e instanceof McpError) throw e;
  const err = toToolError(e);
  // -32002: resource not found (MCP spec); other problems are invalid params.
  throw new McpError(err.code === 'not_found' ? -32002 : ErrorCode.InvalidParams, `${uri}: ${err.message}`, err);
}

export async function readResource(ctx: ToolContext, rawUri: string): Promise<ReadResourceResult> {
  const uri = rawUri.trim();
  try {
    const node = parseNodeUri(uri);
    if (!node) throw new McpError(ErrorCode.InvalidParams, `not a mandate:// reference: ${uri}`, { hint: 'e.g. mandate://specs/<id>/sections/<sid>' });
    if (node.kind === 'architecture') {
      const at = node.commit ? await ctx.reads.commitOf(node.commit, 'uri') : undefined;
      return json(uri, await ctx.storage.architecture.get({ ...(at ? { at } : {}), ...(node.focus ? { focus: node.focus } : {}), format: 'mermaid' }));
    }
    const ref = parseRef(uri) ?? (node.kind === 'specs' || node.kind === 'standards' || node.kind === 'work-orders' || node.kind === 'feedback' ? node : null);
    if (ref && (ref.kind === 'work-orders' || ref.kind === 'feedback')) {
      return json(uri, ref.kind === 'work-orders' ? await ctx.reads.workOrderGet({ ref: ref.id }) : await ctx.reads.feedbackGet({ ref: ref.id }));
    }
    if (ref && (ref.kind === 'specs' || ref.kind === 'standards' || ref.kind === 'components')) {
      const commit = ref.commit ? await ctx.reads.commitOf(ref.commit, 'uri') : null;
      const { doc, raw } = await ctx.reads.readDoc(ref.kind, ref.id, commit);
      const docUri = buildRef({ kind: ref.kind, id: ref.id, ...(commit ? { commit } : {}) });
      if (!ref.sectionId && !ref.lines) return md(uri, raw);
      if (ref.sectionId) {
        const sec = await ctx.reads[ref.kind === 'specs' ? 'specSectionGet' : ref.kind === 'standards' ? 'standardSectionGet' : 'componentSectionGet']({ ref: uri });
        const s = sec.section;
        const meta = s.meta as Record<string, unknown>;
        const head = header({
          uri: s.uri,
          document: `${doc.title} (${docUri})`,
          ...(ref.kind !== 'standards' ? { status: (doc as { status?: string }).status } : {}),
          section: s.id,
          title: s.title,
          type: s.type,
          summary: s.summary,
          lines: s.lines ? `${s.lines.start}-${s.lines.end}` : undefined,
          commit: commit ?? 'HEAD',
          standards: meta.standards,
          symbols: meta.symbols,
          refs: (meta.refs as { repo: string; path: string; lines?: string }[] | undefined)?.map((r) => `${r.repo}/${r.path}${r.lines ? `#L${r.lines}` : ''}`),
          links: (meta.links as { to: string; rel: string }[] | undefined)?.map((l) => `${l.rel} ${l.to}`),
          ...(sec.excerpt ? { excerpt: `L${sec.excerpt.lines.start}-L${sec.excerpt.lines.end}` } : {}),
        });
        const body = sec.excerpt ? sec.excerpt.text : `## ${s.title}\n\n${s.body ?? ''}`;
        return md(uri, `${head}\n${body}\n`);
      }
      // Doc-level line range.
      const lines = raw.split('\n');
      const { start, end } = ref.lines!;
      if (start > lines.length) throw new McpError(ErrorCode.InvalidParams, `${uri}: line ${start} is past the end of the file (${lines.length} lines)`);
      return md(uri, `${header({ uri, document: `${doc.title} (${docUri})`, lines: `${start}-${end}`, commit: commit ?? 'HEAD' })}\n${lines.slice(start - 1, end).join('\n')}\n`);
    }
    // Any other graph node.
    if (!ctx.index) throw new McpError(-32002, `${uri}: graph resources need the search index`);
    return json(uri, await ctx.index.graphNode({ uri }));
  } catch (e) {
    fail(e, uri);
  }
}

import { sectionLineRange, type DocFormat, type Section } from '@mandate/doc';
import { chunkDocument, contentHash, estimateTokens, type Chunk, type ChunkOptions } from '@mandate/doc/split';
import { EDGE_KINDS, NODE_KINDS, buildNodeUri, buildRef, parseNodeUri, parseRef, type EdgeKind, type GraphNodeKind } from '@mandate/shared';
import { identifierParts, normalizeSymbol } from './identifiers.js';

/** Everything one repo file contributes to the index. Rows are replaced as a unit when the file changes. */
export interface FileRecords {
  path: string;
  docs: DocRow[];
  sections: SectionRow[];
  nodes: NodeRow[];
  edges: EdgeRow[];
  symbols: { name: string; sectionUri: string }[];
  codeRefs: { repo: string; path: string; lineStart: number | null; lineEnd: number | null; commit: string | null; sectionUri: string }[];
  /** fts rows: indexable text per doc / section. */
  fts: { uri: string; title: string; summary: string; body: string; symbols: string; raw: string }[];
  chunks: (Chunk & { docUri: string })[];
  /** Problems while reading the file (it is still indexed as far as possible). */
  errors: string[];
}

export interface DocRow {
  uri: string;
  kind: 'spec' | 'standard' | 'component' | 'work_order' | 'feedback';
  id: string;
  title: string;
  summary: string | null;
  status: string | null;
  category: string | null;
  repo: string | null;
  tags: string[];
  standards: string[];
  owner: string | null;
  priority: string | null;
  props: Record<string, unknown>;
  lineStart: number;
  lineEnd: number;
}

export interface SectionRow {
  uri: string;
  docUri: string;
  id: string;
  ord: number;
  title: string;
  type: string;
  summary: string | null;
  lineStart: number | null;
  lineEnd: number | null;
  standards: string[];
  tokens: number;
}

export interface NodeRow {
  uri: string;
  kind: GraphNodeKind;
  label: string;
  props: Record<string, unknown>;
  /** Owned nodes are deleted with their file; shared ones (symbols, code, repos) are garbage-collected. */
  owned: boolean;
}

export interface EdgeRow {
  from: string;
  to: string;
  kind: EdgeKind;
  props?: Record<string, unknown>;
}

export interface ExtractContext {
  formats: { specs: DocFormat<unknown, unknown>; standards: DocFormat<unknown, unknown>; components: DocFormat<unknown, unknown> };
  chunk: ChunkOptions;
  /** History replay: nodes and edges only (no chunks). */
  graphOnly?: boolean;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : typeof v === 'number' ? String(v) : null);
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.map(str).filter((x): x is string => x !== null) : []);

/** Doc or section URI of a `mandate://` target, without commit / lines. */
export function baseUri(target: string): string | null {
  const r = parseRef(target);
  if (r) return buildRef({ kind: r.kind, id: r.id, sectionId: r.sectionId });
  // Other nodes (e.g. feedback on a verification result): their canonical uri.
  const n = parseNodeUri(target);
  return n ? buildNodeUri(n) : null;
}

/** Sectioned document kinds (directories) and their node kinds / labels. */
export type DocDir = 'specs' | 'standards' | 'components';
export const DOC_DIRS: DocDir[] = ['specs', 'standards', 'components'];
export const DOC_FILE_RE = /^(specs|standards|components)\/([a-z0-9]+(?:-[a-z0-9]+)*)\.md$/;
const DOC_KIND = { specs: 'spec', standards: 'standard', components: 'component' } as const;
const DOC_LABEL = { specs: 'Spec', standards: 'Standard', components: 'Component' } as const;

/** The document a doc / section uri belongs to. */
const docOf = (uri: string) => uri.replace(/\/sections\/.*$/, '');

function empty(path: string): FileRecords {
  return { path, docs: [], sections: [], nodes: [], edges: [], symbols: [], codeRefs: [], fts: [], chunks: [], errors: [] };
}

/** Index records for a repo file (`specs/*.md`, `standards/*.md`, `work-orders.jsonl`, `feedback.jsonl`, `verifications.jsonl`). */
export function extractFile(path: string, text: string, ctx: ExtractContext): FileRecords {
  const m = DOC_FILE_RE.exec(path);
  if (m) return extractDoc(path, m[1] as DocDir, m[2]!, text, ctx);
  if (path === 'work-orders.jsonl' || path === 'queue.jsonl') return extractJsonl('work-orders.jsonl', text, 'work-orders', ctx);
  if (path === 'feedback.jsonl') return extractJsonl(path, text, 'feedback', ctx);
  if (path === 'verifications.jsonl') return extractVerifications(path, text);
  return empty(path);
}

function extractDoc(path: string, dir: DocDir, id: string, text: string, ctx: ExtractContext): FileRecords {
  const out = empty(path);
  const kind = DOC_KIND[dir];
  const docUri = buildRef({ kind: dir, id });
  let fm: Record<string, unknown>;
  let sections: Section[];
  try {
    const doc = ctx.formats[dir].parse(text);
    fm = doc.frontmatter as Record<string, unknown>;
    sections = doc.sections;
  } catch (e) {
    out.errors.push(`${path}: ${(e as Error).message}`);
    // Still findable by id and raw text.
    out.docs.push({ uri: docUri, kind, id, title: id, summary: null, status: null, category: null, repo: null, tags: [], standards: [], owner: null, priority: null, props: { invalid: true }, lineStart: 1, lineEnd: text.split('\n').length });
    out.nodes.push({ uri: docUri, kind, label: id, props: { invalid: true }, owned: true });
    out.fts.push({ uri: docUri, title: id, summary: '', body: text, symbols: '', raw: text });
    return out;
  }

  const title = str(fm.title) ?? id;
  // Standards are linked at section level (`follows` / `deviates_from` to a standard or one of its sections).
  const sectionStandards = (sec: Section): string[] => {
    const links = (sec as { links?: unknown }).links;
    const ids = (Array.isArray(links) ? (links as { to?: unknown; rel?: unknown }[]) : [])
      .filter((l) => (l?.rel === 'follows' || l?.rel === 'deviates_from') && typeof l.to === 'string')
      .map((l) => baseUri(l.to as string))
      .filter((u): u is string => !!u && u.startsWith('mandate://standards/'))
      .map((u) => docOf(u).slice('mandate://standards/'.length));
    return [...new Set(ids)];
  };
  const standards = [...new Set(sections.flatMap(sectionStandards))].filter((id) => `mandate://standards/${id}` !== docUri);
  const linkedDocs = new Set<string>();
  const repo = str(fm.repo);
  const fmEnd = text.split('\n').findIndex((l, i) => i > 0 && l.trimEnd() === '---') + 1;
  const props: Record<string, unknown> = {};
  // Claims live on work orders; spec dependencies and standards are derived from section links.
  for (const k of ['appliesTo', 'implementedCommit', 'effectiveFrom', 'supersededBy', 'owns']) if (fm[k] !== undefined) props[k] = fm[k];
  // Components: their kind (service, module, ...) as componentKind (the node's kind is `component`).
  if (dir === 'components' && fm.kind !== undefined) props.componentKind = fm.kind;
  // Components: layer and containing component (the `contains` edge is materialised from it).
  if (dir === 'components') for (const k of ['layer', 'parent']) if (fm[k] !== undefined) props[k] = fm[k];
  const doc: DocRow = {
    uri: docUri,
    kind,
    id,
    title,
    summary: str(fm.summary),
    status: str(fm.status),
    category: str(fm.category),
    repo,
    tags: strs(fm.tags),
    standards,
    owner: str(fm.owner),
    priority: str(fm.priority),
    props,
    lineStart: 1,
    lineEnd: Math.max(1, fmEnd),
  };
  out.docs.push(doc);
  out.nodes.push({
    uri: docUri,
    kind,
    label: title,
    props: { id, title, status: doc.status, category: doc.category, repo, tags: doc.tags, owner: doc.owner, priority: doc.priority, summary: doc.summary, path, ...props },
    owned: true,
  });

  // Doc-level edges.
  // A component is in the repos it owns code in.
  for (const o of dir === 'components' && Array.isArray(fm.owns) ? (fm.owns as { repo?: string }[]) : []) {
    if (typeof o?.repo !== 'string') continue;
    const repoUri = buildNodeUri({ kind: 'repos', name: o.repo });
    out.nodes.push({ uri: repoUri, kind: 'repo', label: o.repo, props: {}, owned: false });
    out.edges.push({ from: docUri, to: repoUri, kind: 'in_repo' });
  }
  if (repo) {
    const repoUri = buildNodeUri({ kind: 'repos', name: repo });
    out.nodes.push({ uri: repoUri, kind: 'repo', label: repo, props: {}, owned: false });
    out.edges.push({ from: docUri, to: repoUri, kind: 'in_repo' });
  }

  out.fts.push({
    uri: docUri,
    title,
    summary: doc.summary ?? '',
    body: [doc.tags.join(' '), doc.category ?? '', sections.map((s) => s.summary ?? '').join(' ')].join('\n'),
    symbols: '',
    raw: text.split('\n').slice(0, Math.max(1, fmEnd)).join('\n'),
  });

  const chunks = ctx.graphOnly
    ? []
    : chunkDocument(
    { uri: docUri, kind: DOC_LABEL[dir], title, category: doc.category ?? undefined, summary: doc.summary ?? undefined, standards, sections, source: text },
    ctx.chunk,
  );
  out.chunks.push(...chunks.map((c) => ({ ...c, docUri })));
  const registry = ctx.chunk.registry;
  const lines = text.split('\n');

  sections.forEach((s, ord) => {
    const uri = buildRef({ kind: dir, id, sectionId: s.id });
    const range = sectionLineRange(text, s.id);
    const secStandards = sectionStandards(s);
    const def = registry?.get(s.type);
    const indexText = def?.toIndexText ? def.toIndexText(s) : s.body;
    const body = typeof indexText === 'string' ? indexText : indexText.map((l) => l.text).join('\n');
    out.sections.push({
      uri,
      docUri,
      id: s.id,
      ord,
      title: s.title,
      type: s.type,
      summary: s.summary ?? null,
      lineStart: range?.start ?? null,
      lineEnd: range?.end ?? null,
      standards: secStandards,
      tokens: estimateTokens(s.body),
    });
    out.nodes.push({
      uri,
      kind: 'section',
      label: `${title} › ${s.title}`,
      props: {
        id: s.id,
        title: s.title,
        type: s.type,
        summary: s.summary ?? null,
        docUri,
        lines: range,
        implementedCommit: s.implementedCommit ?? null,
        // Sections are archived, never deleted (ids are immutable).
        archived: Boolean((s as { archived?: unknown }).archived) || (s as { status?: unknown }).status === 'archived',
        // Rule sections: level, rationale, scope, check, examples (criteria of the standard).
        ...Object.fromEntries((['level', 'rationale', 'scope', 'check', 'examples', 'method'] as const).filter((k) => (s as Record<string, unknown>)[k] !== undefined).map((k) => [k, (s as Record<string, unknown>)[k]])),
      },
      owned: true,
    });
    out.edges.push({ from: docUri, to: uri, kind: 'has_section', props: { ord } });
    // Type-specific graph contributions (e.g. acceptance criteria). The registry of node and edge kinds is
    // closed: a hook node with an existing URI adds its kind as a `role`; unknown edge kinds become links.
    const sectionNode = out.nodes.find((n) => n.uri === uri)!;
    for (const n of def?.extractNodes?.(s, docUri) ?? []) {
      if (n.uri === uri) sectionNode.props.role = n.kind;
      else if ((NODE_KINDS as readonly string[]).includes(n.kind)) out.nodes.push({ uri: n.uri, kind: n.kind as GraphNodeKind, label: n.label, props: n.text ? { text: n.text } : {}, owned: true });
      else out.errors.push(`${path}: section type '${s.type}' produced a node of unknown kind '${n.kind}' (${n.uri}); ignored`);
    }
    for (const e of def?.extractEdges?.(s, docUri) ?? []) {
      const kind = e.kind.replace(/-/g, '_');
      if ((EDGE_KINDS as readonly string[]).includes(kind)) out.edges.push({ from: e.from, to: e.to, kind: kind as EdgeKind });
      else out.edges.push({ from: e.from, to: e.to, kind: 'links_to', props: { rel: kind } });
    }
    // Section-to-section links (`links: [{ to, rel, note? }]`), read defensively.
    const links = (s as { links?: unknown }).links;
    for (const l of Array.isArray(links) ? (links as { to?: unknown; rel?: unknown; note?: unknown }[]) : []) {
      const to = typeof l?.to === 'string' ? baseUri(l.to) : null;
      if (!to) continue;
      const rel = str(l.rel) ?? 'relates_to';
      const note = str(l.note);
      out.edges.push({ from: uri, to, kind: 'links_to', props: { rel, ...(note ? { note } : {}) } });
      // Derived document-level relations (precise ones stay on the section link).
      const target = docOf(to);
      // Same-kind dependencies (spec -> spec, component -> component) become derived document-level depends_on.
      if (rel === 'depends_on' && target.startsWith(`mandate://${dir}/`) && target !== docUri) linkedDocs.add(target);
      // Spec section -> component (or component section): affects.
      if (rel === 'affects') out.edges.push({ from: uri, to, kind: 'affects', ...(note ? { props: { note } } : {}) });
      // `deviates_from` is also its own edge for deviation queries.
      if (rel === 'deviates_from') out.edges.push({ from: uri, to, kind: 'deviates_from', ...(note ? { props: { note } } : {}) });
    }
    // Rule examples: code that shows the rule (example_of: code -> rule).
    for (const ex of (s as { examples?: string[] }).examples ?? []) {
      const n = parseNodeUri(ex);
      if (!n || n.kind !== 'code') continue;
      const fileUri = buildNodeUri({ kind: 'code', repo: n.repo, path: n.path });
      out.nodes.push({ uri: fileUri, kind: 'code_file', label: `${n.repo}:${n.path}`, props: { repo: n.repo, path: n.path }, owned: false });
      let target = fileUri;
      if (n.lines) {
        target = buildNodeUri({ kind: 'code', repo: n.repo, path: n.path, lines: n.lines });
        out.nodes.push({ uri: target, kind: 'code_range', label: `${n.repo}:${n.path}:${n.lines.start}-${n.lines.end}`, props: { repo: n.repo, path: n.path, lineStart: n.lines.start, lineEnd: n.lines.end }, owned: false });
        out.edges.push({ from: target, to: fileUri, kind: 'in_file' });
      }
      out.edges.push({ from: target, to: uri, kind: 'example_of' });
    }
    for (const sym of s.symbols) {
      const symUri = buildNodeUri({ kind: 'symbols', name: sym });
      out.nodes.push({ uri: symUri, kind: 'symbol', label: sym, props: { parts: identifierParts(sym), normalized: normalizeSymbol(sym) }, owned: false });
      out.edges.push({ from: uri, to: symUri, kind: 'mentions_symbol' });
      out.symbols.push({ name: sym, sectionUri: uri });
    }
    for (const ref of s.refs) {
      const [a, b] = ref.lines ? ref.lines.split('-').map(Number) : [];
      const lineStart = a ?? null;
      const lineEnd = b ?? a ?? null;
      const fileUri = buildNodeUri({ kind: 'code', repo: ref.repo, path: ref.path });
      const repoUri = buildNodeUri({ kind: 'repos', name: ref.repo });
      out.nodes.push({ uri: repoUri, kind: 'repo', label: ref.repo, props: {}, owned: false });
      out.nodes.push({ uri: fileUri, kind: 'code_file', label: `${ref.repo}:${ref.path}`, props: { repo: ref.repo, path: ref.path }, owned: false });
      out.edges.push({ from: fileUri, to: repoUri, kind: 'in_repo' });
      if (lineStart !== null) {
        const rangeUri = buildNodeUri({ kind: 'code', repo: ref.repo, path: ref.path, lines: { start: lineStart, end: lineEnd ?? lineStart } });
        out.nodes.push({
          uri: rangeUri,
          kind: 'code_range',
          label: `${ref.repo}:${ref.path}:${lineStart}-${lineEnd}`,
          props: { repo: ref.repo, path: ref.path, lineStart, lineEnd },
          owned: false,
        });
        out.edges.push({ from: rangeUri, to: fileUri, kind: 'in_file' });
        out.edges.push({ from: uri, to: rangeUri, kind: 'references_code', props: ref.commit ? { commit: ref.commit } : undefined });
      } else {
        out.edges.push({ from: uri, to: fileUri, kind: 'references_code', props: ref.commit ? { commit: ref.commit } : undefined });
      }
      out.codeRefs.push({ repo: ref.repo, path: ref.path, lineStart, lineEnd, commit: ref.commit ?? null, sectionUri: uri });
    }
    out.fts.push({
      uri,
      title: s.title,
      summary: s.summary ?? '',
      body,
      symbols: s.symbols.map((x) => `${x} ${identifierParts(x).join(' ')}`).join(' '),
      raw: range ? lines.slice(range.start - 1, range.end).join('\n') : s.body,
    });
  });
  // Standard lifecycle: a deprecated standard points at its successor.
  const successor = str(fm.supersededBy);
  if (kind === 'standard' && successor) out.edges.push({ from: docUri, to: buildRef({ kind: 'standards', id: successor }), kind: 'superseded_by' });
  // Derived document-level edges (impact uses the precise section links instead).
  for (const id of standards) out.edges.push({ from: docUri, to: buildRef({ kind: 'standards', id }), kind: 'uses_standard', props: { derived: true, via: 'links' } });
  for (const d of linkedDocs) out.edges.push({ from: docUri, to: d, kind: 'depends_on', props: { derived: true, via: 'links' } });
  return out;
}

/** Queue items and feedback: one doc per line, with text and edges. */
function extractJsonl(path: string, text: string, kind: 'work-orders' | 'feedback', ctx: ExtractContext): FileRecords {
  const out = empty(path);
  text.split('\n').forEach((line, i) => {
    if (!line.trim()) return;
    let item: Record<string, unknown>;
    try {
      item = JSON.parse(line) as Record<string, unknown>;
    } catch {
      out.errors.push(`${path}:${i + 1}: invalid JSON`);
      return;
    }
    const id = str(item.id);
    if (!id) return;
    const uri = buildRef({ kind, id });
    const lineNo = i + 1;
    let title: string;
    let body: string;
    let summary: string | null = null;
    const props: Record<string, unknown> = { createdAt: item.createdAt, updatedAt: item.updatedAt };
    if (kind === 'work-orders') {
      const spec = str(item.spec) ?? '?';
      const secs = Array.isArray(item.sections) ? (item.sections as { id?: string; status?: string }[]) : [];
      title = `${str(item.kind) ?? 'work'} ${spec} (${secs.map((s) => s.id).join(', ')})`;
      body = str(item.note) ?? '';
      summary = body || null;
      Object.assign(props, { spec, specCommit: item.specCommit, kind: item.kind, priority: item.priority, createdBy: item.createdBy, sections: secs });
      // The claim (which agent works on it, where) lives on the work order.
      const claim = item.claim && typeof item.claim === 'object' ? (item.claim as Record<string, unknown>) : null;
      if (claim) {
        props.claim = claim;
        const agent = str(claim.agent);
        const branch = str(claim.branch);
        if (agent) {
          const a = buildNodeUri({ kind: 'agents', name: agent });
          out.nodes.push({ uri: a, kind: 'agent', label: agent, props: { name: agent }, owned: false });
          out.edges.push({ from: uri, to: a, kind: 'claimed_by', props: { heartbeatAt: claim.heartbeatAt ?? null } });
        }
        if (branch) {
          const b = buildNodeUri({ kind: 'branches', name: branch });
          out.nodes.push({ uri: b, kind: 'branch', label: branch, props: { name: branch }, owned: false });
          out.edges.push({ from: uri, to: b, kind: 'on_branch' });
        }
      }
      const specUri = buildRef({ kind: 'specs', id: spec });
      out.edges.push({ from: uri, to: specUri, kind: 'covers' });
      for (const s of secs) {
        if (typeof s.id === 'string') out.edges.push({ from: uri, to: buildRef({ kind: 'specs', id: spec, sectionId: s.id }), kind: 'covers', props: { status: s.status } });
      }
    } else {
      body = [str(item.body) ?? '', str(item.quote) ? `> ${item.quote}` : '', str(item.resolutionNote) ?? ''].filter(Boolean).join('\n');
      title = `${str(item.kind) ?? 'feedback'}: ${(str(item.body) ?? '').replace(/\s+/g, ' ').slice(0, 80)}`;
      Object.assign(props, { kind: item.kind, resolution: item.resolution, duplicateOf: item.duplicateOf, targets: item.targets, quote: item.quote });
      for (const t of strs(item.targets)) {
        const to = baseUri(t);
        const lines = parseRef(t)?.lines;
        if (to) out.edges.push({ from: uri, to, kind: 'targets', props: lines ? { lines } : undefined });
      }
      const dup = str(item.duplicateOf);
      if (dup) out.edges.push({ from: uri, to: buildRef({ kind: 'feedback', id: dup }), kind: 'duplicate_of' });
      for (const r of strs(item.relatedTo)) out.edges.push({ from: uri, to: buildRef({ kind: 'feedback', id: r }), kind: 'related_to' });
    }
    const status = str(item.status);
    const priority = str(item.priority);
    const tags = strs(item.tags);
    const nodeKind = kind === 'work-orders' ? 'work_order' : 'feedback';
    out.docs.push({ uri, kind: nodeKind, id, title, summary, status, category: null, repo: null, tags, standards: [], owner: str(item.createdBy), priority, props, lineStart: lineNo, lineEnd: lineNo });
    out.nodes.push({ uri, kind: nodeKind, label: title, props: { id, status, priority, ...props }, owned: true });
    out.fts.push({ uri, title, summary: '', body, symbols: '', raw: line });
    const prefix = `${kind === 'work-orders' ? 'Work order' : 'Feedback'}: ${title}${status ? ` (${status})` : ''}`;
    if (!ctx.graphOnly) {
      const chunk = chunkDocument({ uri, kind: kind === 'work-orders' ? 'Work order' : 'Feedback', title, summary: body, sections: [] }, ctx.chunk)[0]!;
      const text = chunk.text;
      out.chunks.push({ ...chunk, contextPrefix: prefix, contentHash: contentHash(text, prefix), lineStart: lineNo, lineEnd: lineNo, docUri: uri });
    }
  });
  return out;
}

/** Verification results (append-only): result -> criterion section, spec, commit and agent. */
function extractVerifications(path: string, text: string): FileRecords {
  const out = empty(path);
  text.split('\n').forEach((line, i) => {
    if (!line.trim()) return;
    let v: Record<string, unknown>;
    try {
      v = JSON.parse(line) as Record<string, unknown>;
    } catch {
      out.errors.push(`${path}:${i + 1}: invalid JSON`);
      return;
    }
    const id = str(v.id);
    if (!id || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) return;
    const uri = buildNodeUri({ kind: 'verifications', id });
    const criterion = str(v.criterion) && baseUri(v.criterion as string);
    const appliedTo = str(v.appliedTo) && baseUri(v.appliedTo as string);
    const result = str(v.result) ?? '?';
    const by = str(v.by);
    out.nodes.push({
      uri,
      kind: 'verification',
      label: `${result} ${criterion ? criterion.replace(/^mandate:\/\//, '') : id}`,
      props: { id, result, method: v.method, criterion, appliedTo, specCommit: v.specCommit, code: v.code, evidence: v.evidence, by, at: v.at, line: i + 1 },
      owned: true,
    });
    if (criterion) out.edges.push({ from: uri, to: criterion, kind: 'verifies', props: { result } });
    if (appliedTo) out.edges.push({ from: uri, to: appliedTo, kind: 'applied_to', props: { result } });
    const commit = str(v.specCommit);
    if (commit && /^[0-9a-f]{4,40}$/.test(commit)) out.edges.push({ from: uri, to: buildNodeUri({ kind: 'commits', sha: commit }), kind: 'verified_at' });
    if (by) {
      const agent = buildNodeUri({ kind: 'agents', name: by });
      out.nodes.push({ uri: agent, kind: 'agent', label: by, props: { name: by }, owned: false });
      out.edges.push({ from: uri, to: agent, kind: 'authored_by' });
    }
  });
  return out;
}

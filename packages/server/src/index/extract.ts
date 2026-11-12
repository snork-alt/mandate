import { sectionLineRange, type DocFormat, type Section } from '@mandate/doc';
import { chunkDocument, contentHash, estimateTokens, type Chunk, type ChunkOptions } from '@mandate/doc/split';
import { EDGE_KINDS, LINK_EDGE_KINDS, NODE_KINDS, buildNodeUri, buildRef, buildUserRef, parseNodeUri, parseRef, replayQuestions, type QuestionLine, type EdgeKind, type GraphNodeKind } from '@mandate/shared';
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
  kind: 'spec' | 'standard' | 'component' | 'work_order' | 'feedback' | 'audit';
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
  formats: { specs: DocFormat<unknown, unknown>; standards: DocFormat<unknown, unknown>; components: DocFormat<unknown, unknown>; audits: DocFormat<unknown, unknown>; 'work-orders': DocFormat<unknown, unknown> };
  chunk: ChunkOptions;
  /** History replay: nodes and edges only (no chunks). */
  graphOnly?: boolean;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : typeof v === 'number' ? String(v) : null);
const ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
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
export type DocDir = 'specs' | 'standards' | 'components' | 'audits' | 'work-orders';
export const DOC_DIRS: DocDir[] = ['specs', 'standards', 'components', 'audits', 'work-orders'];
export const DOC_FILE_RE = /^(specs|standards|components|audits|work-orders)\/([a-z0-9]+(?:-[a-z0-9]+)*)\.md$/;
const DOC_KIND = { specs: 'spec', standards: 'standard', components: 'component', audits: 'audit', 'work-orders': 'work_order' } as const;
const DOC_LABEL = { specs: 'Spec', standards: 'Standard', components: 'Component', audits: 'Audit', 'work-orders': 'Work order' } as const;

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
  if (path === 'comments.jsonl') return extractComments(path, text);
  if (path === 'questions.jsonl') return extractQuestions(path, text);
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
  // Audits: target, commits, auditor, times and counts.
  if (dir === 'audits') for (const k of ['target', 'commit', 'code', 'auditor', 'startedAt', 'completedAt', 'abandonedAt', 'counts']) if (fm[k] !== undefined) props[k] = fm[k];
  // Work orders: what the jsonl lines carried (spec, pin, kind, claim, sections) plus the document fields.
  if (dir === 'work-orders') {
    for (const k of ['spec', 'specCommit', 'kind', 'createdBy', 'claim', 'claims', 'findings', 'reason', 'dependencies', 'fastPath', 'createdAt', 'updatedAt', 'completedAt', 'touched', 'git', 'note']) if (fm[k] !== undefined) props[k] = fm[k];
    props.sections = sections.filter((x) => x.type === 'wo-section').map((x) => ({ id: parseRef(String(x.target ?? ''))?.sectionId ?? x.id, status: x.status ?? 'pending' }));
  }
  const doc: DocRow = {
    uri: docUri,
    kind,
    id,
    title,
    summary: str(fm.summary) ?? (dir === 'work-orders' ? str(fm.note) : null),
    status: str(fm.status),
    category: str(fm.category),
    repo,
    tags: strs(fm.tags),
    standards,
    owner: str(fm.owner) ?? (dir === 'work-orders' ? str(fm.createdBy) : null),
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
    body: [doc.tags.join(' '), doc.category ?? '', sections.map((s) => s.summary ?? '').join(' '), ...(dir === 'work-orders' ? [workOrderSearchText(fm)] : [])].join('\n'),
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
      // Work-order sections: `covers` is written with the section's status below (workOrderEdges).
      if (kind === 'covers' && dir === 'work-orders') continue;
      // A link kind from a section type (acceptance `verified-by`) carries its rel like an authored link.
      if ((LINK_EDGE_KINDS as readonly string[]).includes(kind)) out.edges.push({ from: e.from, to: e.to, kind: kind as EdgeKind, props: { rel: kind } });
      else if ((EDGE_KINDS as readonly string[]).includes(kind)) out.edges.push({ from: e.from, to: e.to, kind: kind as EdgeKind });
      else out.edges.push({ from: e.from, to: e.to, kind: 'relates_to', props: { rel: kind } });
    }
    // Section-to-section links (`links: [{ to, rel, note? }]`), read defensively.
    const links = (s as { links?: unknown }).links;
    for (const l of Array.isArray(links) ? (links as { to?: unknown; rel?: unknown; note?: unknown; feedback?: unknown; pin?: unknown; by?: unknown; seenAt?: unknown }[]) : []) {
      const to = typeof l?.to === 'string' ? baseUri(l.to) : null;
      if (!to) continue;
      const rel = str(l.rel) ?? 'relates_to';
      const note = str(l.note);
      // G-2: the link's metadata (waiver approval: feedback, pin, by; upstream acknowledgement: seenAt) stays on the edge.
      const meta: Record<string, string> = {};
      for (const k of ['note', 'feedback', 'pin', 'by', 'seenAt'] as const) {
        const v = str(l[k]);
        if (v) meta[k] = v;
      }
      // P1: one edge kind per rel (`rel` stays readable on the edge for one release: the deprecated LINKS_TO alias).
      const linkKind: EdgeKind = (LINK_EDGE_KINDS as readonly string[]).includes(rel) ? (rel as EdgeKind) : 'relates_to';
      out.edges.push({ from: uri, to, kind: linkKind, props: { rel, ...meta } });
      // A waiver (deviation approved by feedback): section -> approving feedback.
      if (meta.feedback && ID_RE.test(meta.feedback)) out.edges.push({ from: uri, to: buildRef({ kind: 'feedback', id: meta.feedback }), kind: 'waived_by', props: { rel, target: to, ...(meta.pin ? { pin: meta.pin } : {}), ...(meta.by ? { by: meta.by } : {}) } });
      // Derived document-level relations (precise ones stay on the section link).
      const target = docOf(to);
      // Same-kind dependencies (spec -> spec, component -> component) become derived document-level spec_depends_on /
      // component_depends_on (P2).
      if (rel === 'depends_on' && (dir === 'specs' || dir === 'components') && target.startsWith(`mandate://${dir}/`) && target !== docUri) linkedDocs.add(target);
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
  if (dir === 'audits') auditEdges(out, docUri, fm, sections);
  if (dir === 'work-orders') workOrderEdges(out, docUri, fm, sections);
  // Standard lifecycle (G-15): the successor `supersedes` the deprecated standard (frontmatter `supersededBy`).
  const successor = str(fm.supersededBy);
  if (kind === 'standard' && successor) out.edges.push({ from: buildRef({ kind: 'standards', id: successor }), to: docUri, kind: 'supersedes', props: { via: 'supersededBy' } });
  // Derived document-level dependencies (P2; impact uses the precise section links instead). `uses_standard` is derived
  // over the whole model (links and appliesTo in one edge, indexer.ts standardEdges).
  const docDep: EdgeKind = dir === 'components' ? 'component_depends_on' : 'spec_depends_on';
  for (const d of linkedDocs) out.edges.push({ from: docUri, to: d, kind: docDep, props: { via: 'links' } });
  // GQ-9: the legacy spec-level `dependsOn: [spec ids]` (before section links) is a dependency too (time travel).
  if (dir === 'specs') {
    for (const d of [...strs(fm.dependsOn), ...legacyList(text, fmEnd, 'dependsOn')]) {
      const target = d.startsWith('mandate://') ? baseUri(d) && docOf(baseUri(d)!) : ID_RE.test(d) ? buildRef({ kind: 'specs', id: d }) : null;
      if (target && target.startsWith('mandate://specs/') && target !== docUri && !linkedDocs.has(target)) out.edges.push({ from: docUri, to: target, kind: 'spec_depends_on', props: { via: 'frontmatter' } });
    }
    // G-5d: exemptions (spec -> standard), approved by feedback (spec -> feedback `waived_by`).
    for (const e of Array.isArray(fm.exemptFrom) ? (fm.exemptFrom as Record<string, unknown>[]) : []) {
      const std = str(e?.standard);
      if (!std || !ID_RE.test(std)) continue;
      const fb = str(e.feedback);
      const by = str(e.by);
      const reason = str(e.reason);
      const stdUri = buildRef({ kind: 'standards', id: std });
      out.edges.push({ from: docUri, to: stdUri, kind: 'exempt_from', props: { ...(reason ? { reason } : {}), ...(fb ? { feedback: fb } : {}), ...(by ? { by } : {}) } });
      if (fb && ID_RE.test(fb)) out.edges.push({ from: docUri, to: buildRef({ kind: 'feedback', id: fb }), kind: 'waived_by', props: { rel: 'exempt_from', target: stdUri, ...(by ? { by } : {}) } });
    }
  }
  return out;
}

/**
 * A top-level list field of the raw frontmatter (`key: [a, b]` or a block list) that the current schema no longer
 * carries (it strips unknown keys), e.g. the legacy spec-level `dependsOn` (GQ-9).
 */
function legacyList(text: string, fmEnd: number, key: string): string[] {
  const lines = text.split('\n').slice(1, Math.max(1, fmEnd - 1));
  const i = lines.findIndex((l) => l.startsWith(`${key}:`));
  if (i < 0) return [];
  const rest = lines[i]!.slice(key.length + 1).trim();
  const unq = (x: string) => x.trim().replace(/^['"]|['"]$/g, '');
  if (rest.startsWith('[')) return rest.replace(/^\[|\]\s*(#.*)?$/g, '').split(',').map(unq).filter(Boolean);
  if (rest) return [];
  const out: string[] = [];
  for (const l of lines.slice(i + 1)) {
    const m = /^\s*-\s+(.+)$/.exec(l);
    if (!m) break;
    out.push(unq(m[1]!));
  }
  return out;
}

/** Code file (+ range) nodes for a repo path; returns the uris to link to (one per range, else the file). */
function codeTargets(out: FileRecords, repo: string, rawPath: string, lines?: string[]): string[] {
  const p = rawPath.replace(/^\.?\/+/, '');
  if (!p || p.split('/').some((x) => x === '..' || x === '.')) return [];
  const fileUri = buildNodeUri({ kind: 'code', repo, path: p });
  const repoUri = buildNodeUri({ kind: 'repos', name: repo });
  out.nodes.push({ uri: repoUri, kind: 'repo', label: repo, props: {}, owned: false });
  out.nodes.push({ uri: fileUri, kind: 'code_file', label: `${repo}:${p}`, props: { repo, path: p }, owned: false });
  out.edges.push({ from: fileUri, to: repoUri, kind: 'in_repo' });
  const ranges = (lines ?? []).map((l) => l.split('-').map(Number)).filter(([a]) => Number.isFinite(a) && a! >= 1);
  if (!ranges.length) return [fileUri];
  return ranges.map(([a, b]) => {
    const lineStart = a!;
    const lineEnd = Number.isFinite(b) && b! >= lineStart ? b! : lineStart;
    const rangeUri = buildNodeUri({ kind: 'code', repo, path: p, lines: { start: lineStart, end: lineEnd } });
    out.nodes.push({ uri: rangeUri, kind: 'code_range', label: `${repo}:${p}:${lineStart}-${lineEnd}`, props: { repo, path: p, lineStart, lineEnd }, owned: false });
    out.edges.push({ from: rangeUri, to: fileUri, kind: 'in_file' });
    return rangeUri;
  });
}

type Touched = { repo?: unknown; path?: unknown; lines?: unknown; change?: unknown; from?: unknown; commits?: unknown; symbols?: unknown };

/** G-14: symbols named on touched code become symbol nodes (`mentions_symbol` from the work order or its section). */
function symbolEdges(out: FileRecords, from: string, names: string[]): void {
  for (const sym of names) {
    const symUri = buildNodeUri({ kind: 'symbols', name: sym });
    out.nodes.push({ uri: symUri, kind: 'symbol', label: sym, props: { parts: identifierParts(sym), normalized: normalizeSymbol(sym) }, owned: false });
    out.edges.push({ from, to: symUri, kind: 'mentions_symbol' });
  }
}

/** The agent (author) node of a `by` / `createdBy` value and the edge to it. */
function authorEdge(out: FileRecords, from: string, name: string | null, props?: Record<string, unknown>): void {
  if (!name) return;
  const a = buildNodeUri({ kind: 'agents', name });
  out.nodes.push({ uri: a, kind: 'agent', label: name, props: { name }, owned: false });
  out.edges.push({ from, to: a, kind: 'authored_by', ...(props ? { props } : {}) });
}

/** Searchable work-order facts: claim agent / branch, git branches, commits, PR numbers / urls, touched paths. */
function workOrderSearchText(fm: Record<string, unknown>): string {
  const out: string[] = [str(fm.spec) ?? '', str(fm.kind) ?? ''];
  const claim = fm.claim as Record<string, unknown> | undefined;
  if (claim) out.push(str(claim.agent) ?? '', str(claim.branch) ?? '');
  for (const g of Array.isArray(fm.git) ? (fm.git as Record<string, any>[]) : []) {
    out.push(str(g.repo) ?? '', str(g.branch) ?? '', str(g.baseBranch) ?? '', str(g.headCommit) ?? '', ...strs(g.commits), str(g.mergedInto) ?? '');
    if (g.pr) out.push(`#${g.pr.number}`, `PR ${g.pr.number}`, String(g.pr.number ?? ''), str(g.pr.url) ?? '', str(g.pr.mergedCommit) ?? '');
  }
  for (const t of Array.isArray(fm.touched) ? (fm.touched as Touched[]) : []) out.push(`${str(t.repo) ?? ''}:${str(t.path) ?? ''}`, str(t.path) ?? '', ...strs(t.commits));
  return out.filter(Boolean).join(' ');
}

/**
 * Work orders (markdown): -> spec and spec sections (`covers`, with status), -> agent (`claimed_by`), -> branches
 * (`on_branch`: the claim branch and each git context branch), -> other work orders (`depends_on`), -> findings
 * (`from_finding`), -> code it touched (`touches`, file / range; wo-sections too), -> pull requests (`has_pr`; a PR is
 * `merged_as` a code commit), code commits -> work order (`implements`).
 */
function workOrderEdges(out: FileRecords, docUri: string, fm: Record<string, unknown>, sections: Section[]): void {
  // P4: `covers` is work-order section -> spec section only (work order -> section: through has_section).
  const woId = docUri.slice('mandate://work-orders/'.length);
  for (const s of sections) {
    if (s.type !== 'wo-section' || typeof s.target !== 'string') continue;
    const to = baseUri(s.target);
    if (to) out.edges.push({ from: buildRef({ kind: 'work-orders', id: woId, sectionId: s.id }), to, kind: 'covers', props: { status: s.status ?? 'pending' } });
  }
  const claim = fm.claim && typeof fm.claim === 'object' ? (fm.claim as Record<string, unknown>) : null;
  const branch = (name: string, repo?: string) => {
    const b = buildNodeUri({ kind: 'branches', name });
    out.nodes.push({ uri: b, kind: 'branch', label: name, props: { name }, owned: false });
    out.edges.push({ from: docUri, to: b, kind: 'on_branch', ...(repo ? { props: { repo } } : {}) });
  };
  if (claim) {
    const agent = str(claim.agent);
    if (agent) {
      const a = buildNodeUri({ kind: 'agents', name: agent });
      out.nodes.push({ uri: a, kind: 'agent', label: agent, props: { name: agent }, owned: false });
      out.edges.push({ from: docUri, to: a, kind: 'claimed_by', props: { startedAt: claim.startedAt ?? null } });
    }
    const b = str(claim.branch);
    if (b) branch(b);
  }
  for (const d of strs(fm.dependencies)) out.edges.push({ from: docUri, to: buildRef({ kind: 'work-orders', id: d }), kind: 'depends_on' });
  for (const f of strs(fm.findings)) {
    const n = parseNodeUri(f);
    if (n?.kind === 'findings') out.edges.push({ from: docUri, to: buildNodeUri(n), kind: 'from_finding' });
  }
  const touch =(from: string, list: unknown, section?: string) => {
    for (const t of Array.isArray(list) ? (list as Touched[]) : []) {
      const repo = str(t?.repo);
      const p = str(t?.path);
      if (!repo || !p) continue;
      for (const to of codeTargets(out, repo, p, strs(t.lines))) out.edges.push({ from, to, kind: 'touches', props: { change: str(t.change) ?? 'modified', ...(section ? { section } : {}), ...(str(t.from) ? { from: str(t.from) } : {}) } });
      symbolEdges(out, from, strs(t.symbols));
    }
  };
  // G-5a / L-2: the feedback a work order acts on (`reason`, its recorded cause: P5 `acts_on`); G-5c: who created it.
  for (const r of strs(fm.reason)) {
    const id = r.startsWith('mandate://') || r.startsWith('@mandate:') ? (parseNodeUri(r) as { id?: string } | null)?.id : r;
    if (id && ID_RE.test(id)) out.edges.push({ from: docUri, to: buildRef({ kind: 'feedback', id }), kind: 'acts_on' });
  }
  authorEdge(out, docUri, str(fm.createdBy), { role: 'created' });
  // G-5e: the criteria (or verification results) a work-order section names as its proof.
  for (const s of sections) {
    if (s.type !== 'wo-section') continue;
    const from = buildRef({ kind: 'work-orders', id: docUri.slice('mandate://work-orders/'.length), sectionId: s.id });
    for (const v of strs((s as { verifications?: unknown }).verifications)) {
      const to = v.startsWith('mandate://verifications/') ? v : baseUri(v);
      if (to && (to.startsWith('mandate://verifications/') || to.includes('/sections/'))) out.edges.push({ from, to, kind: 'proven_by' });
    }
  }
  touch(docUri, fm.touched);
  for (const s of sections) if (s.type === 'wo-section') touch(buildRef({ kind: 'work-orders', id: docUri.slice('mandate://work-orders/'.length), sectionId: s.id }), s.codeRefs, s.id);
  const codeCommit = (repo: string, sha: string) => {
    const uri = buildNodeUri({ kind: 'code-commits', repo, sha });
    out.nodes.push({ uri, kind: 'code_commit', label: `${repo}@${sha.slice(0, 7)}`, props: { repo, sha }, owned: false });
    return uri;
  };
  for (const g of Array.isArray(fm.git) ? (fm.git as Record<string, unknown>[]) : []) {
    const repo = str(g?.repo);
    if (!repo) continue;
    const b = str(g.branch);
    if (b) branch(b, repo);
    const shas = [...new Set([...strs(g.commits), ...(str(g.headCommit) ? [str(g.headCommit)!] : [])])].filter((x) => /^[0-9a-f]{4,64}$/.test(x));
    for (const sha of shas) out.edges.push({ from: codeCommit(repo, sha), to: docUri, kind: 'implements', props: { repo, ...(sha === str(g.headCommit) ? { head: true } : {}) } });
    const pr = g.pr && typeof g.pr === 'object' ? (g.pr as Record<string, unknown>) : null;
    const num = typeof pr?.number === 'number' ? pr.number : null;
    if (pr && num) {
      const uri = buildNodeUri({ kind: 'prs', repo, number: num });
      out.nodes.push({ uri, kind: 'pull_request', label: `${repo}#${num}`, props: { repo, number: num, url: pr.url ?? null, status: pr.status ?? null, mergedCommit: pr.mergedCommit ?? null, workOrder: docUri }, owned: true });
      out.edges.push({ from: docUri, to: uri, kind: 'has_pr', props: { status: str(pr.status) } });
      const merged = str(pr.mergedCommit);
      if (merged && /^[0-9a-f]{4,64}$/.test(merged)) {
        const c = codeCommit(repo, merged);
        out.edges.push({ from: uri, to: c, kind: 'merged_as' });
        out.edges.push({ from: c, to: docUri, kind: 'implements', props: { repo, merge: true } });
      }
    }
  }
}

/** Comments (append-only, replayed): comment -> target (`comments_on`), reply -> parent (`reply_to`), -> agent. */
function extractComments(path: string, text: string): FileRecords {
  const out = empty(path);
  const recs: Record<string, any>[] = [];
  text.split('\n').forEach((line, i) => {
    if (!line.trim()) return;
    try {
      recs.push(JSON.parse(line) as Record<string, any>);
    } catch {
      out.errors.push(`${path}:${i + 1}: invalid JSON`);
    }
  });
  const comments = recs.filter((r) => typeof r.id === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(r.id) && typeof r.target === 'string' && !r.type);
  const byId = new Map(comments.map((c) => [c.id as string, c]));
  const rootOf = (c: Record<string, any>) => {
    let cur = c;
    for (let i = 0; i < 100 && cur.parent && byId.has(cur.parent); i++) cur = byId.get(cur.parent)!;
    return cur.id as string;
  };
  const state = new Map<string, { status: string; by?: string; at?: string }>();
  for (const r of recs) {
    if ((r.type !== 'resolve' && r.type !== 'reopen') || !byId.has(r.commentId)) continue;
    state.set(rootOf(byId.get(r.commentId)!), r.type === 'resolve' ? { status: 'resolved', by: r.by, at: r.at } : { status: 'open' });
  }
  for (const c of comments) {
    const uri = buildNodeUri({ kind: 'comments', id: c.id });
    const root = rootOf(c);
    const st = state.get(root) ?? { status: 'open' };
    const agent = str(c.author?.agent);
    const body = String(c.body ?? '');
    out.nodes.push({
      uri,
      kind: 'comment',
      label: `${agent ?? 'comment'}: ${body.replace(/\s+/g, ' ').slice(0, 80)}`,
      props: { id: c.id, target: c.target, parent: c.parent ?? null, thread: root, author: c.author ?? null, blocking: !!c.blocking, status: st.status, resolvedBy: st.by ?? null, resolvedAt: st.at ?? null, mentions: c.mentions ?? [], createdAt: c.createdAt ?? null, body: body.slice(0, 2000) },
      owned: true,
    });
    const to = baseUri(c.target);
    if (to) out.edges.push({ from: uri, to, kind: 'comments_on', props: { blocking: !!c.blocking, status: st.status } });
    if (c.parent && byId.has(c.parent)) out.edges.push({ from: uri, to: buildNodeUri({ kind: 'comments', id: c.parent }), kind: 'reply_to' });
    if (agent) {
      const a = buildNodeUri({ kind: 'agents', name: agent });
      out.nodes.push({ uri: a, kind: 'agent', label: agent, props: { name: agent }, owned: false });
      out.edges.push({ from: uri, to: a, kind: 'authored_by' });
    }
  }
  return out;
}

/** Questions (append-only, replayed): question -> context element (`concerns`), -> asking agent / user. */
function extractQuestions(path: string, text: string): FileRecords {
  const out = empty(path);
  const lines: QuestionLine[] = [];
  text.split('\n').forEach((line, i) => {
    if (!line.trim()) return;
    try {
      lines.push(JSON.parse(line) as QuestionLine);
    } catch {
      out.errors.push(`${path}:${i + 1}: invalid JSON`);
    }
  });
  for (const q of replayQuestions(lines.filter((l) => typeof (l as { id?: unknown }).id === 'string'))) {
    if (!ID_RE.test(q.id)) continue;
    const uri = buildNodeUri({ kind: 'questions', id: q.id });
    const first = q.questions?.[0];
    out.nodes.push({
      uri,
      kind: 'question',
      label: `${q.id} ${(q.questions ?? []).map((x) => x.header).join(' · ')}: ${String(first?.question ?? '').slice(0, 80)}`,
      props: {
        id: q.id,
        purpose: q.purpose,
        status: q.status,
        blocking: !!q.blocking,
        asker: q.asker ?? null,
        context: q.context ?? [],
        questions: (q.questions ?? []).map((x) => ({ id: x.id, header: x.header, question: x.question, recommended: x.recommended })),
        answers: q.answer?.answers ?? null,
        answeredBy: q.answer ? (q.answer.by.user ?? q.answer.by.agent) : null,
        answeredAt: q.answer?.at ?? null,
        createdAt: q.createdAt ?? null,
      },
      owned: true,
    });
    for (const c of q.context ?? []) {
      const to = baseUri(c);
      if (to) out.edges.push({ from: uri, to, kind: 'concerns', props: { status: q.status } });
    }
    const agent = str(q.asker?.agent);
    if (agent) {
      const a = buildNodeUri({ kind: 'agents', name: agent });
      out.nodes.push({ uri: a, kind: 'agent', label: agent, props: { name: agent }, owned: false });
      out.edges.push({ from: uri, to: a, kind: 'authored_by' });
    }
    const user = str(q.asker?.user);
    if (user) {
      const u = buildUserRef(user);
      out.nodes.push({ uri: u, kind: 'user', label: user, props: { login: user }, owned: false });
      out.edges.push({ from: uri, to: u, kind: 'created_by' });
    }
  }
  return out;
}

/** Code node + edge for a `repo:path#Lx-Ly` audit code ref (finding -> found_in -> code range / file). */
function auditCodeEdge(out: FileRecords, from: string, ref: string, kind: 'found_in' | 'applies_at' | 'violated_at' = 'found_in', props?: Record<string, unknown>): void {
  const m = /^([A-Za-z0-9_.-]+):([^#\s:][^#\s]*)(?:#L(\d+)(?:-L?(\d+))?)?$/.exec(ref);
  if (!m) return;
  const repo = m[1]!;
  const p = m[2]!.replace(/^\/+/, '');
  const fileUri = buildNodeUri({ kind: 'code', repo, path: p });
  const repoUri = buildNodeUri({ kind: 'repos', name: repo });
  out.nodes.push({ uri: repoUri, kind: 'repo', label: repo, props: {}, owned: false });
  out.nodes.push({ uri: fileUri, kind: 'code_file', label: `${repo}:${p}`, props: { repo, path: p }, owned: false });
  out.edges.push({ from: fileUri, to: repoUri, kind: 'in_repo' });
  if (!m[3]) {
    out.edges.push({ from, to: fileUri, kind, ...(props ? { props } : {}) });
    return;
  }
  const lineStart = Number(m[3]);
  const lineEnd = m[4] ? Number(m[4]) : lineStart;
  const rangeUri = buildNodeUri({ kind: 'code', repo, path: p, lines: { start: lineStart, end: lineEnd } });
  out.nodes.push({ uri: rangeUri, kind: 'code_range', label: `${repo}:${p}:${lineStart}-${lineEnd}`, props: { repo, path: p, lineStart, lineEnd }, owned: false });
  out.edges.push({ from: rangeUri, to: fileUri, kind: 'in_file' });
  out.edges.push({ from, to: rangeUri, kind, ...(props ? { props } : {}) });
}

/**
 * Audit reports: audit -> target (`audits`), -> commit (`audited_at`), -> agent (`authored_by`); findings (nodes and `finding_of` ->
 * item edges from the `audit-item` type), -> criterion / rule (`concerns`), -> code (`found_in`), -> fix work order
 * (`fixed_by`), -> feedback (`reported_in`). Nothing links to an audit except work orders / feedback created from findings.
 */
function auditEdges(out: FileRecords, docUri: string, fm: Record<string, unknown>, sections: Section[]): void {
  const target = typeof fm.target === 'string' ? baseUri(fm.target) : null;
  // G-13: the audit's status lives on its node, not on the structural edge (no close / reopen on completion).
  if (target) out.edges.push({ from: docUri, to: target, kind: 'audits' });
  const commit = str(fm.commit);
  if (commit && /^[0-9a-f]{4,40}$/.test(commit)) out.edges.push({ from: docUri, to: buildNodeUri({ kind: 'commits', sha: commit }), kind: 'audited_at' });
  const agent = str((fm.auditor as { agent?: unknown } | undefined)?.agent);
  if (agent) {
    const a = buildNodeUri({ kind: 'agents', name: agent });
    out.nodes.push({ uri: a, kind: 'agent', label: agent, props: { name: agent }, owned: false });
    out.edges.push({ from: docUri, to: a, kind: 'authored_by' });
  }
  for (const s of sections) {
    if (s.type !== 'audit-item') continue;
    const sec = s as Section & { ref?: string; result?: string; level?: string; findings?: { id: string; title: string; severity: string; classification: string; codeRefs?: string[]; resolution?: { status?: string; workOrder?: string; feedback?: string } }[] };
    for (const f of sec.findings ?? []) {
      const fUri = buildNodeUri({ kind: 'findings', audit: docUri.slice('mandate://audits/'.length), id: f.id });
      const node = out.nodes.find((n) => n.uri === fUri);
      const props = { id: f.id, audit: docUri, item: buildRef({ kind: 'audits', id: docUri.slice('mandate://audits/'.length), sectionId: s.id }), ref: sec.ref ?? null, level: sec.level ?? null, severity: f.severity, classification: f.classification, status: f.resolution?.status ?? 'open', codeRefs: f.codeRefs ?? [] };
      if (node) Object.assign(node.props, props);
      else out.nodes.push({ uri: fUri, kind: 'finding', label: f.title, props, owned: true });
      if (sec.ref) {
        const to = baseUri(sec.ref);
        if (to) out.edges.push({ from: fUri, to, kind: 'concerns', props: { severity: f.severity } });
      }
      for (const c of f.codeRefs ?? []) auditCodeEdge(out, fUri, c);
      // Where standards are used: an open code_deviates finding places its rule (or criterion) as violated there.
      const fStatus = f.resolution?.status ?? 'open';
      const concerned = sec.ref ? baseUri(sec.ref) : null;
      if (concerned && fStatus === 'open' && f.classification === 'code_deviates') {
        for (const c of f.codeRefs ?? []) auditCodeEdge(out, concerned, c, 'violated_at', { source: fUri, severity: f.severity, at: str(fm.startedAt) ?? str(fm.completedAt) ?? null }); // G-10: stable (start)
      }
      if (f.resolution?.workOrder) out.edges.push({ from: fUri, to: buildRef({ kind: 'work-orders', id: f.resolution.workOrder }), kind: 'fixed_by' });
      if (f.resolution?.feedback) out.edges.push({ from: fUri, to: buildRef({ kind: 'feedback', id: f.resolution.feedback }), kind: 'reported_in' });
      const dup = str((f as { duplicateOf?: unknown }).duplicateOf);
      const dupRef = dup ? parseNodeUri(dup) : null;
      if (dupRef?.kind === 'findings' && buildNodeUri(dupRef) !== fUri) out.edges.push({ from: fUri, to: buildNodeUri(dupRef), kind: 'duplicate_finding_of' });
    }
  }
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
      // Legacy records have no wo-sections: the work order itself covers the spec sections (P4 exception).
      for (const s of secs) {
        if (typeof s.id === 'string') out.edges.push({ from: uri, to: buildRef({ kind: 'specs', id: spec, sectionId: s.id }), kind: 'covers', props: { status: s.status } });
      }
      // Fix work orders: the audit findings they fix (backlinks to the audit).
      for (const f of strs(item.findings)) {
        const n = parseNodeUri(f);
        if (n?.kind === 'findings') out.edges.push({ from: uri, to: buildNodeUri(n), kind: 'from_finding' });
      }
      if (Array.isArray(item.findings)) props.findings = item.findings;
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
      const ff = str(item.fromFinding) && parseNodeUri(item.fromFinding as string);
      if (ff && ff.kind === 'findings') {
        out.edges.push({ from: uri, to: buildNodeUri(ff), kind: 'from_finding' });
        props.fromFinding = item.fromFinding;
      }
      for (const r of strs(item.relatedTo)) out.edges.push({ from: uri, to: r.startsWith('mandate://') ? r : buildRef({ kind: 'feedback', id: r }), kind: 'related_to' });
    }
    // G-5c: who created the item; G-5a: the feedback a (legacy jsonl) work order acts on.
    authorEdge(out, uri, str(item.createdBy), { role: 'created' });
    if (kind === 'work-orders') for (const r of strs(item.reason)) if (ID_RE.test(r)) out.edges.push({ from: uri, to: buildRef({ kind: 'feedback', id: r }), kind: 'acts_on' });
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
      props: { id, result, method: v.method, criterion, appliedTo, specCommit: v.specCommit, code: v.code, evidence: v.evidence, by, ...(str(v.byUser) ? { byUser: v.byUser } : {}), ...(Array.isArray(v.codeRefs) ? { codeRefs: v.codeRefs } : {}), at: v.at, line: i + 1 },
      owned: true,
    });
    if (criterion) out.edges.push({ from: uri, to: criterion, kind: 'verifies', props: { result } });
    if (appliedTo) out.edges.push({ from: uri, to: appliedTo, kind: 'applied_to', props: { result } });
    const commit = str(v.specCommit);
    if (commit && /^[0-9a-f]{4,40}$/.test(commit)) out.edges.push({ from: uri, to: buildNodeUri({ kind: 'commits', sha: commit }), kind: 'verified_at' });
    // G-5b: the code commit the result was obtained at.
    const code = v.code && typeof v.code === 'object' ? (v.code as Record<string, unknown>) : null;
    const codeRepo = str(code?.repo);
    const codeSha = str(code?.commit);
    if (codeRepo && codeSha && /^[0-9a-f]{4,40}$/.test(codeSha)) {
      const cc = buildNodeUri({ kind: 'code-commits', repo: codeRepo, sha: codeSha });
      out.nodes.push({ uri: cc, kind: 'code_commit', label: `${codeRepo}@${codeSha.slice(0, 7)}`, props: { repo: codeRepo, sha: codeSha }, owned: false });
      out.edges.push({ from: uri, to: cc, kind: 'verified_at_code', ...(str(code?.branch) ? { props: { branch: str(code?.branch) } } : {}) });
    }
    if (by) {
      const agent = buildNodeUri({ kind: 'agents', name: by });
      out.nodes.push({ uri: agent, kind: 'agent', label: by, props: { name: by }, owned: false });
      out.edges.push({ from: uri, to: agent, kind: 'authored_by' });
    }
    // Where standards (and criteria) are used in code: explicit code refs of the result (pass / fail).
    const codeRefs = Array.isArray(v.codeRefs) ? (v.codeRefs as unknown[]).filter((c): c is string => typeof c === 'string') : [];
    if (criterion && codeRefs.length && (result === 'pass' || result === 'fail')) {
      for (const c of codeRefs) auditCodeEdge(out, criterion, c, result === 'pass' ? 'applies_at' : 'violated_at', { source: uri, at: v.at ?? null, result });
    }
  });
  return out;
}

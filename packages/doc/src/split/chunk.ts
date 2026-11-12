import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import type { Code, List, Nodes, Root, RootContent, Table } from 'mdast';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { gfm } from 'micromark-extension-gfm';
import { sectionLineRange } from '../quote.js';
import type { SectionTypeRegistry } from '../registry.js';
import type { Section } from '../schema.js';
import { estimateTokens, type Tokenizer } from '../tokens.js';
import { createDefaultRegistry } from '../types/index.js';
import type { IndexLine } from './extract.js';

/** Document-level input for chunking. */
export interface ChunkDoc {
  /** `mandate://specs/<id>` (no section, commit or lines). */
  uri: string;
  /** Kind label used in the context prefix ("Spec", "Standard"). */
  kind: string;
  title: string;
  category?: string;
  summary?: string;
  /** Document-level standards (merged with each section's standards in the prefix). */
  standards?: string[];
  sections: Section[];
  /** The stored `.md` file; needed for line numbers in the file (else lines are body-relative). */
  source?: string;
}

export interface ChunkOptions {
  /** Target size of `prefix + text` (default 350). */
  chunkTargetTokens?: number;
  /** Approximate overlap between consecutive chunks of a section (default 50), on sentence / block boundaries. */
  chunkOverlapTokens?: number;
  /** Defaults to `estimateTokens` (chars / 4 + 15%). */
  tokenizer?: Tokenizer;
  /** Section types (for `toIndexText` / `split` hooks and fences); defaults to the built-ins. */
  registry?: SectionTypeRegistry;
}

export type ChunkKind = 'doc' | 'section' | 'summary';

export interface Chunk {
  /** Section URI (`mandate://specs/x/sections/y`) or, for the doc chunk, the document URI. */
  uri: string;
  sectionId?: string;
  /** 0.. within a section; -1 for the section summary chunk; 0 for the doc chunk. */
  chunkIndex: number;
  kind: ChunkKind;
  text: string;
  contextPrefix: string;
  /** 1-based inclusive lines in the `.md` file. */
  lineStart: number;
  lineEnd: number;
  /** sha256(text + contextPrefix), hex. */
  contentHash: string;
  /** Token count of `contextPrefix + "\n\n" + text`. */
  tokens: number;
}

/** What gets embedded / shown for a chunk. */
export const chunkInput = (c: Pick<Chunk, 'contextPrefix' | 'text'>): string => (c.text ? `${c.contextPrefix}\n\n${c.text}` : c.contextPrefix);

export const contentHash = (text: string, prefix: string): string => bytesToHex(sha256(utf8ToBytes(text + prefix)));

/* ------------------------------------------------------------------ pieces */

interface Wrap {
  id: string;
  open: string;
  close: string;
}

/** A unit of text that may be broken further (`children`) when it does not fit. */
interface Unit {
  text: string;
  start: number;
  end: number;
  /** Subheading path within the section. */
  path: string[];
  /** Separator placed before this unit when it follows another one. */
  sep: string;
  /** Consecutive pieces with the same wrap are enclosed once (code fences, table header). */
  wrap?: Wrap;
  /** Prose (paragraphs, sentences, list items) may be repeated as overlap. */
  prose: boolean;
  /** Set on the first unit of a subheading group: tokens of the whole group. */
  groupTokens?: number;
  children?: () => Unit[];
}

function render(pieces: Unit[]): string {
  let out = '';
  let open: Wrap | undefined;
  pieces.forEach((p, i) => {
    if (open && p.wrap?.id !== open.id) {
      if (open.close) out += `\n${open.close}`;
      open = undefined;
    }
    if (i > 0) out += p.sep;
    if (p.wrap && !open) {
      out += `${p.wrap.open}\n`;
      open = p.wrap;
    }
    out += p.text;
  });
  if (open?.close) out += `\n${open.close}`;
  return out;
}

const SENTENCES = new Intl.Segmenter('en', { granularity: 'sentence' });

function sentences(text: string): { text: string; offset: number }[] {
  const out: { text: string; offset: number }[] = [];
  for (const s of SENTENCES.segment(text)) {
    const t = s.segment.trim();
    if (t) out.push({ text: t, offset: s.index + (s.segment.length - s.segment.trimStart().length) });
  }
  return out;
}

/* ------------------------------------------------------------------ chunker */

interface Ctx {
  count: Tokenizer;
  target: number;
  overlap: number;
  /** Tokens available for text under a given subheading path. */
  avail(path: string[]): number;
}

/** Last resort: windows of whole words that fit the budget. */
function tokenSplit(u: Unit, budget: number, ctx: Ctx): Unit[] {
  const words = u.text.split(/(\s+)/);
  const out: Unit[] = [];
  let cur = '';
  for (const w of words) {
    if (cur && ctx.count(cur + w) > budget && w.trim()) {
      out.push({ ...u, text: cur.trim(), sep: out.length ? ' ' : u.sep, children: undefined, groupTokens: out.length ? undefined : u.groupTokens });
      cur = '';
    }
    if (!cur && !w.trim()) continue;
    // A single word larger than the budget: cut it by characters.
    if (!cur && ctx.count(w) > budget) {
      const step = Math.max(1, Math.floor((budget * 4) / 1.3));
      for (let k = 0; k < w.length; k += step) out.push({ ...u, text: w.slice(k, k + step), sep: out.length ? '' : u.sep, children: undefined });
      continue;
    }
    cur += w;
  }
  if (cur.trim()) out.push({ ...u, text: cur.trim(), sep: out.length ? ' ' : u.sep, children: undefined, groupTokens: out.length ? undefined : u.groupTokens });
  return out;
}

const measure = (u: Unit, ctx: Ctx) => ctx.count(render([u]));

/** Break units until each fits its budget (subheadings -> blocks -> sentences -> words). */
function fit(units: Unit[], ctx: Ctx): Unit[] {
  const out: Unit[] = [];
  for (const u of units) {
    const budget = ctx.avail(u.path);
    if (measure(u, ctx) <= budget) out.push(u);
    else if (u.children) {
      const kids = u.children();
      if (kids.length) {
        kids[0] = { ...kids[0]!, sep: u.sep, groupTokens: u.groupTokens };
        out.push(...fit(kids, ctx));
      } else out.push(...tokenSplit(u, budget, ctx));
    } else out.push(...tokenSplit(u, budget, ctx));
  }
  return out;
}

/** Trailing prose of a chunk to repeat at the start of the next one (whole blocks or sentences only). */
function overlapFrom(prev: Unit[], ctx: Ctx): Unit[] {
  if (ctx.overlap <= 0) return [];
  const out: Unit[] = [];
  let used = 0;
  for (let i = prev.length - 1; i >= 0; i--) {
    const p = prev[i]!;
    if (!p.prose || p.wrap) break;
    const t = ctx.count(p.text);
    if (used + t > ctx.overlap) {
      if (out.length === 0) {
        // Take trailing sentences of the last block instead.
        const ss = sentences(p.text);
        const keep: string[] = [];
        for (let k = ss.length - 1; k > 0; k--) {
          const next = [ss[k]!.text, ...keep].join(' ');
          if (ctx.count(next) > ctx.overlap) break;
          keep.unshift(ss[k]!.text);
        }
        if (keep.length) out.unshift({ ...p, text: keep.join(' '), groupTokens: undefined, children: undefined });
      }
      break;
    }
    out.unshift({ ...p, groupTokens: undefined, children: undefined });
    used += t;
  }
  return out;
}

/** Greedy packing of fitted pieces into chunks; subheading groups start a new chunk when they do not fit the current one. */
function pack(pieces: Unit[], ctx: Ctx): { pieces: Unit[]; path: string[] }[] {
  const chunks: { pieces: Unit[]; path: string[] }[] = [];
  let cur: Unit[] = [];
  let path: string[] = [];
  let fresh = 0; // index of the first non-overlap piece in cur
  const flush = () => {
    if (cur.length > fresh) chunks.push({ pieces: cur, path });
  };
  for (const p of pieces) {
    if (cur.length > fresh) {
      const budget = ctx.avail(path);
      const tooBig = ctx.count(render([...cur, p])) > budget;
      const groupBreak = p.groupTokens !== undefined && ctx.count(render(cur)) + p.groupTokens > budget;
      if (tooBig || groupBreak) {
        flush();
        const prev = cur;
        cur = groupBreak ? [] : overlapFrom(prev, ctx);
        if (cur.length && ctx.count(render([...cur, p])) > ctx.avail(p.path)) cur = [];
        fresh = cur.length;
      }
    }
    if (cur.length === fresh) path = p.path;
    cur.push(p);
  }
  flush();
  return chunks;
}

/* ------------------------------------------------------------------ markdown units */

function markdownUnits(body: string, lineOf: (offset: number) => number, ctx: Ctx): Unit[] {
  const tree: Root = fromMarkdown(body, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });
  const off = (n: Nodes) => [n.position!.start.offset!, n.position!.end.offset!] as const;
  const slice = (n: Nodes) => {
    const [a, b] = off(n);
    return body.slice(a, b);
  };
  let wrapSeq = 0;

  const sentenceUnits = (n: Nodes, path: string[]): Unit[] => {
    const [a] = off(n);
    return sentences(slice(n)).map((s) => ({
      text: s.text,
      start: lineOf(a + s.offset),
      end: lineOf(a + s.offset + s.text.length - 1),
      path,
      sep: ' ',
      prose: true,
    }));
  };

  const blockUnit = (n: RootContent, path: string[], sep: string): Unit => {
    const [a, b] = off(n as Nodes);
    const base: Unit = { text: slice(n as Nodes), start: lineOf(a), end: lineOf(Math.max(a, b - 1)), path, sep, prose: false };
    switch (n.type) {
      case 'paragraph':
      case 'heading':
        return { ...base, prose: true, children: () => sentenceUnits(n, path) };
      case 'blockquote':
        return { ...base, prose: true, children: () => n.children.map((c, i) => blockUnit(c, path, i ? '\n\n' : sep)) };
      case 'list':
        return {
          ...base,
          prose: true,
          children: () =>
            (n as List).children.map((item, i) => ({
              ...blockUnit(item as unknown as RootContent, path, i ? '\n' : sep),
              prose: true,
              children: () => item.children.map((c, k) => blockUnit(c, path, k ? '\n\n' : '\n')),
            })),
        };
      case 'table': {
        const t = n as Table;
        const [header, ...rows] = t.children;
        if (!header || !rows.length) return base;
        const lines = base.text.split('\n');
        const wrap: Wrap = { id: `table-${wrapSeq++}`, open: `${lines[0]}\n${lines[1] ?? ''}`, close: '' };
        return {
          ...base,
          children: () =>
            rows.map((r, i) => {
              const [ra, rb] = off(r);
              return { text: body.slice(ra, rb), start: lineOf(ra), end: lineOf(Math.max(ra, rb - 1)), path, sep: i ? '\n' : sep, wrap, prose: false };
            }),
        };
      }
      case 'code': {
        const lines = base.text.split('\n');
        if (lines.length < 3) return base;
        const wrap: Wrap = { id: `code-${wrapSeq++}`, open: lines[0]!, close: lines[lines.length - 1]! };
        const inner = lines.slice(1, -1);
        const first = base.start + 1;
        const lineUnits = (from: number, to: number, sep0: string): Unit[] =>
          inner.slice(from, to).map((l, k) => ({ text: l, start: first + from + k, end: first + from + k, path, sep: k ? '\n' : sep0, wrap, prose: false }));
        // Blocks separated by blank lines.
        const blocks: [number, number][] = [];
        let s = -1;
        inner.forEach((l, k) => {
          if (l.trim() === '') {
            if (s >= 0) blocks.push([s, k]);
            s = -1;
          } else if (s < 0) s = k;
        });
        if (s >= 0) blocks.push([s, inner.length]);
        return {
          ...base,
          children: () =>
            blocks.map(([from, to], i) => ({
              text: inner.slice(from, to).join('\n'),
              start: first + from,
              end: first + to - 1,
              path,
              sep: i ? '\n\n' : sep,
              wrap,
              prose: false,
              children: () => lineUnits(from, to, i ? '\n\n' : sep),
            })),
        };
      }
      default:
        return base;
    }
  };

  // Top level: subheading groups (a heading and the blocks up to the next heading).
  const units: Unit[] = [];
  const stack: { depth: number; title: string }[] = [];
  let groupStart = -1;
  const closeGroup = () => {
    if (groupStart >= 0) units[groupStart]!.groupTokens = ctx.count(render(units.slice(groupStart)));
  };
  tree.children.forEach((n, i) => {
    const sep = i ? '\n\n' : '';
    if (n.type === 'heading') {
      closeGroup();
      while (stack.length && stack[stack.length - 1]!.depth >= n.depth) stack.pop();
      stack.push({ depth: n.depth, title: slice(n).replace(/^#+\s*/, '').replace(/\s*#*$/, '') });
      groupStart = units.length;
    }
    units.push(blockUnit(n, stack.map((h) => h.title), sep));
  });
  closeGroup();
  return units;
}

/* ------------------------------------------------------------------ public */

/** 1-based file line where a section's body starts (after marker, `##` heading and opening fence). */
export function bodyStartLine(source: string, sectionId: string, fenced: boolean): number | null {
  const range = sectionLineRange(source, sectionId);
  if (!range) return null;
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  let i = range.start; // 0-based index of the line after the marker
  const skipBlank = () => {
    while (i < lines.length && lines[i]!.trim() === '') i++;
  };
  skipBlank();
  if (/^##[ \t]/.test(lines[i] ?? '')) i++;
  skipBlank();
  if (fenced && /^(`{3,}|~{3,})/.test(lines[i] ?? '')) i++;
  return i + 1;
}

function sectionPrefix(doc: ChunkDoc, section: Section, path: string[]): string {
  const head = `${doc.kind}: ${doc.title}${doc.category ? ` (${doc.category})` : ''} › ${[section.title, ...path].join(' › ')}`;
  // Standards come from the section's follows links (whole standard or one of its sections).
  const followed = section.links.filter((l) => l.rel === 'follows' && l.to.startsWith('mandate://standards/')).map((l) => l.to.split('/')[3]!);
  const standards = [...new Set([...(doc.standards ?? []), ...followed])];
  return [head, standards.length ? `Standards: ${standards.join(', ')}` : '', section.symbols.length ? `Symbols: ${section.symbols.join(', ')}` : '']
    .filter(Boolean)
    .join('\n');
}

const sectionUri = (doc: ChunkDoc, section: Section) => `${doc.uri}/sections/${section.id}`;

function resolveOptions(opts: ChunkOptions) {
  const count = opts.tokenizer ?? ((t: string) => estimateTokens(t));
  return {
    count,
    target: opts.chunkTargetTokens ?? 350,
    overlap: opts.chunkOverlapTokens ?? 50,
    registry: opts.registry ?? createDefaultRegistry(),
  };
}

/** Chunks for one section: an optional summary chunk (index -1), then the body split to fit `chunkTargetTokens`. */
export function chunkSection(doc: ChunkDoc, section: Section, opts: ChunkOptions = {}): Chunk[] {
  const { count, target, overlap, registry } = resolveOptions(opts);
  const def = registry.get(section.type);
  const fenced = Boolean(def?.fence);
  const uri = sectionUri(doc, section);
  const range = doc.source ? sectionLineRange(doc.source, section.id) : null;
  const start = (doc.source && bodyStartLine(doc.source, section.id, fenced)) || 1;
  const bodyLines = section.body ? section.body.split('\n').length : 0;
  const bodyEnd = bodyLines ? start + bodyLines - 1 : (range?.end ?? start);
  const prefixFor = (path: string[]) => sectionPrefix(doc, section, path);
  const ctx: Ctx = {
    count,
    target,
    overlap,
    avail: (path) => Math.max(16, target - count(`${prefixFor(path)}\n\n`)),
  };
  const make = (kind: ChunkKind, chunkIndex: number, text: string, prefix: string, lineStart: number, lineEnd: number): Chunk => ({
    uri,
    sectionId: section.id,
    chunkIndex,
    kind,
    text,
    contextPrefix: prefix,
    lineStart,
    lineEnd: Math.max(lineStart, lineEnd),
    contentHash: contentHash(text, prefix),
    tokens: count(chunkInput({ contextPrefix: prefix, text })),
  });

  const out: Chunk[] = [];
  const basePrefix = prefixFor([]);
  if (section.summary) out.push(make('summary', -1, section.summary, basePrefix, range?.start ?? start, range?.end ?? bodyEnd));

  const raw = def?.toIndexText ? def.toIndexText(section) : section.body;
  const lines: IndexLine[] | null = typeof raw === 'string' ? null : raw;
  const text = typeof raw === 'string' ? raw : raw.map((l) => l.text).join('\n');

  if (count(chunkInput({ contextPrefix: basePrefix, text })) <= target) {
    out.push(make('section', 0, text, basePrefix, start, bodyEnd));
    return out;
  }

  let units: Unit[];
  if (def?.split) {
    units = def.split(section, { tokens: ctx.avail([]), count }).map((p, i) => ({
      text: p.text,
      start: p.lineStart ? start + p.lineStart - 1 : start,
      end: p.lineEnd ? start + p.lineEnd - 1 : bodyEnd,
      path: [],
      sep: i ? '\n\n' : '',
      prose: true,
    }));
  } else if (!fenced && typeof raw === 'string' && raw === section.body) {
    const nl: number[] = [];
    for (let k = section.body.indexOf('\n'); k >= 0; k = section.body.indexOf('\n', k + 1)) nl.push(k);
    const lineOf = (offset: number) => {
      let lo = 0;
      let hi = nl.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (nl[mid]! < offset) lo = mid + 1;
        else hi = mid;
      }
      return start + lo;
    };
    units = markdownUnits(section.body, lineOf, ctx);
  } else {
    const ls = lines ?? text.split('\n').map((t, k) => ({ text: t, line: k + 1 }));
    units = ls
      .filter((l) => l.text.trim())
      .map((l, i) => ({ text: l.text, start: start + l.line - 1, end: start + l.line - 1, path: [], sep: i ? '\n' : '', prose: true, children: undefined }));
  }

  pack(fit(units, ctx), ctx).forEach((c, i) => {
    const prefix = prefixFor(c.path);
    out.push(
      make(
        'section',
        i,
        render(c.pieces),
        prefix,
        Math.min(...c.pieces.map((p) => p.start)),
        Math.max(...c.pieces.map((p) => p.end)),
      ),
    );
  });
  return out;
}

/** The doc-level chunk: title, summary, section titles and section summaries. */
export function docChunk(doc: ChunkDoc, opts: ChunkOptions = {}): Chunk {
  const { count } = resolveOptions(opts);
  const standards = doc.standards ?? [];
  const prefix = [`${doc.kind}: ${doc.title}${doc.category ? ` (${doc.category})` : ''}`, standards.length ? `Standards: ${standards.join(', ')}` : '']
    .filter(Boolean)
    .join('\n');
  const text = [
    doc.title,
    doc.summary ?? '',
    doc.sections.length ? `Sections:\n${doc.sections.map((s) => `- ${s.title}${s.summary ? `: ${s.summary}` : ''}`).join('\n')}` : '',
  ]
    .filter(Boolean)
    .join('\n');
  let lineEnd = 1;
  if (doc.source) {
    const lines = doc.source.split('\n');
    const end = lines.findIndex((l, i) => i > 0 && l.trimEnd() === '---');
    lineEnd = end > 0 ? end + 1 : 1;
  }
  return {
    uri: doc.uri,
    chunkIndex: 0,
    kind: 'doc',
    text,
    contextPrefix: prefix,
    lineStart: 1,
    lineEnd,
    contentHash: contentHash(text, prefix),
    tokens: count(chunkInput({ contextPrefix: prefix, text })),
  };
}

/** Every chunk of a document: the doc chunk followed by each section's chunks. */
export function chunkDocument(doc: ChunkDoc, opts: ChunkOptions = {}): Chunk[] {
  return [docChunk(doc, opts), ...doc.sections.flatMap((s) => chunkSection(doc, s, opts))];
}

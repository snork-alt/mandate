import { diffLines, diffWordsWithSpace } from 'diff';
import { parseDocument } from 'yaml';
import type { DocFormat } from './format.js';
import type { ItemChange, SectionTypeRegistry, TextOp } from './registry.js';
import type { Doc, Section } from './schema.js';

export type DiffMode = 'words' | 'lines';

/** Word-level (prose) or line-level (code) diff as a list of equal / insert / delete runs. */
export function diffText(before: string, after: string, mode: DiffMode = 'words'): TextOp[] {
  if (before === after) return before ? [{ op: 'equal', text: before }] : [];
  // Terminate the last line so an appended line does not show the previous one as changed.
  const nl = (t: string) => (t && !t.endsWith('\n') ? `${t}\n` : t);
  const changes = mode === 'lines' ? diffLines(nl(before), nl(after)) : diffWordsWithSpace(before, after);
  const ops: TextOp[] = [];
  for (const c of changes) {
    const op: TextOp['op'] = c.added ? 'insert' : c.removed ? 'delete' : 'equal';
    const last = ops[ops.length - 1];
    if (last && last.op === op) last.text += c.value;
    else ops.push({ op, text: c.value });
  }
  return ops;
}

/** A changed field. Lists get `addedItems` / `removedItems` in addition to before/after. */
export interface ValueChange {
  key: string;
  kind: 'added' | 'removed' | 'changed';
  before?: unknown;
  after?: unknown;
  addedItems?: unknown[];
  removedItems?: unknown[];
}

const isEmpty = (v: unknown) => v === undefined || v === null || (Array.isArray(v) && v.length === 0);
const key = (v: unknown) => JSON.stringify(v);

/** Field-by-field comparison of two flat records (key order: `after` first, then removed keys). */
export function diffValues(before: Record<string, unknown>, after: Record<string, unknown>, ignore: string[] = []): ValueChange[] {
  const keys = [...new Set([...Object.keys(after), ...Object.keys(before)])].filter((k) => !ignore.includes(k));
  const out: ValueChange[] = [];
  for (const k of keys) {
    const b = before[k];
    const a = after[k];
    if (key(b) === key(a) || (isEmpty(a) && isEmpty(b))) continue;
    const kind = isEmpty(b) ? 'added' : isEmpty(a) ? 'removed' : 'changed';
    const change: ValueChange = { key: k, kind, before: b, after: a };
    if ((Array.isArray(a) || a === undefined) && (Array.isArray(b) || b === undefined)) {
      const bs = new Set(((b as unknown[]) ?? []).map(key));
      const as = new Set(((a as unknown[]) ?? []).map(key));
      change.addedItems = ((a as unknown[]) ?? []).filter((x) => !bs.has(key(x)));
      change.removedItems = ((b as unknown[]) ?? []).filter((x) => !as.has(key(x)));
    }
    out.push(change);
  }
  return out;
}

export interface SectionDiff {
  id: string;
  status: 'added' | 'removed' | 'modified' | 'unchanged';
  /** Position relative to the other sections changed (only for sections present on both sides). */
  moved: boolean;
  before?: Section;
  after?: Section;
  title?: { before: string; after: string };
  /** Changes to type, archived, refs and symbols. */
  meta: ValueChange[];
  /** Body diff; for added/removed sections it is a single insert/delete run. */
  body?: { mode: DiffMode; ops: TextOp[] };
  /** Per-item changes from the type's `diffItems` hook (e.g. acceptance criteria). */
  items?: ItemChange[];
}

export interface DocDiff<F = Record<string, unknown>> {
  status: 'added' | 'removed' | 'modified' | 'unchanged';
  frontmatter: ValueChange[];
  /** Sections in reading order: `after` order, with removed sections at their former position. */
  sections: SectionDiff[];
  stats: { added: number; removed: number; modified: number; moved: number; unchanged: number };
  before: Doc<F> | null;
  after: Doc<F> | null;
}

/** Longest common subsequence of two id lists (used to tell moved sections from stable ones). */
function lcs(a: string[], b: string[]): Set<string> {
  const dp = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--) dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
  const out = new Set<string>();
  for (let i = 0, j = 0; i < a.length && j < b.length; ) {
    if (a[i] === b[j]) {
      out.add(a[i]!);
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) i++;
    else j++;
  }
  return out;
}

function bodyMode(type: string, registry?: SectionTypeRegistry): DiffMode {
  const def = registry?.get(type);
  return def?.diffMode ?? (def?.fence ? 'lines' : 'words');
}

function diffBody(type: string, before: string, after: string, registry?: SectionTypeRegistry) {
  const mode = bodyMode(type, registry);
  const custom = registry?.get(type)?.diff;
  return { mode, ops: custom ? custom(before, after) : diffText(before, after, mode) };
}

const META_KEYS = ['type', 'summary', 'archived', 'level', 'rationale', 'scope', 'check', 'examples', 'refs', 'symbols', 'links', 'verifiedBy', 'method', 'threshold', 'implementedCommit'] as const;

/** Structured diff of two parsed documents (either side may be null for creation / deletion). */
export function diffParsedDocs<F>(before: Doc<F> | null, after: Doc<F> | null, registry?: SectionTypeRegistry): DocDiff<F> {
  const fb = (before?.frontmatter ?? {}) as Record<string, unknown>;
  const fa = (after?.frontmatter ?? {}) as Record<string, unknown>;
  const bs = before?.sections ?? [];
  const as = after?.sections ?? [];
  const bIdx = new Map(bs.map((s, i) => [s.id, i]));
  const aIds = new Set(as.map((s) => s.id));
  const stable = lcs(
    bs.filter((s) => aIds.has(s.id)).map((s) => s.id),
    as.filter((s) => bIdx.has(s.id)).map((s) => s.id),
  );

  const removed = (s: Section): SectionDiff => ({
    id: s.id,
    status: 'removed',
    moved: false,
    before: s,
    meta: [],
    body: s.body ? { mode: bodyMode(s.type, registry), ops: [{ op: 'delete', text: s.body }] } : undefined,
  });

  const sections: SectionDiff[] = [];
  let bi = 0;
  const flushRemovedUntil = (end: number) => {
    for (; bi < end; bi++) if (!aIds.has(bs[bi]!.id)) sections.push(removed(bs[bi]!));
  };
  for (const a of as) {
    const i = bIdx.get(a.id);
    if (i === undefined) {
      sections.push({
        id: a.id,
        status: 'added',
        moved: false,
        after: a,
        meta: [],
        body: a.body ? { mode: bodyMode(a.type, registry), ops: [{ op: 'insert', text: a.body }] } : undefined,
      });
      continue;
    }
    if (stable.has(a.id)) {
      flushRemovedUntil(i);
      bi = Math.max(bi, i + 1);
    }
    const b = bs[i]!;
    const meta = diffValues(
      Object.fromEntries(META_KEYS.map((k) => [k, b[k]])),
      Object.fromEntries(META_KEYS.map((k) => [k, a[k]])),
    );
    const title = b.title !== a.title ? { before: b.title, after: a.title } : undefined;
    const bodyChanged = b.body !== a.body;
    const moved = !stable.has(a.id);
    const itemsHook = bodyChanged ? registry?.get(a.type)?.diffItems : undefined;
    let items: ItemChange[] | undefined;
    try {
      items = itemsHook?.(b.body, a.body);
    } catch {
      items = undefined; // unparsable body: the text diff still applies
    }
    sections.push({
      id: a.id,
      status: title || meta.length || bodyChanged ? 'modified' : 'unchanged',
      moved,
      before: b,
      after: a,
      title,
      meta,
      body: bodyChanged ? diffBody(a.type, b.body, a.body, registry) : undefined,
      ...(items ? { items } : {}),
    });
  }
  flushRemovedUntil(bs.length);

  const frontmatter = diffValues(fb, fa);
  const stats = { added: 0, removed: 0, modified: 0, moved: 0, unchanged: 0 };
  for (const s of sections) {
    stats[s.status]++;
    if (s.moved) stats.moved++;
  }
  const changed = frontmatter.length > 0 || sections.some((s) => s.status !== 'unchanged' || s.moved);
  return {
    status: !before && after ? 'added' : before && !after ? 'removed' : changed ? 'modified' : 'unchanged',
    frontmatter,
    sections,
    stats,
    before,
    after,
  };
}

/** Parse both versions with `format` and diff them. Throws DocError if a version does not parse. */
export function diffDocs<F, FIn>(format: DocFormat<F, FIn>, before: string | null, after: string | null): DocDiff<F> {
  return diffParsedDocs(before === null ? null : format.parse(before), after === null ? null : format.parse(after), format.registry);
}

/**
 * Lenient parse of plain "frontmatter + markdown" files (no section markers) into a one-section doc,
 * so simple documents (e.g. standards) can use the same diff view.
 */
export function parsePlainMarkdown(md: string, sectionTitle = 'Content'): Doc<Record<string, unknown>> {
  const text = md.replace(/\r\n?/g, '\n');
  let data: Record<string, unknown> = {};
  let body = text;
  const m = /^---\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(text);
  if (m) {
    const js: unknown = parseDocument(m[1]!, { schema: 'core' }).toJS();
    if (js && typeof js === 'object' && !Array.isArray(js)) data = js as Record<string, unknown>;
    body = text.slice(m[0].length);
  }
  return {
    frontmatter: data,
    sections: [{ id: 'content', title: sectionTitle, type: 'markdown', refs: [], symbols: [], links: [], verifiedBy: [], body: body.trim() }],
  };
}

export function diffPlainMarkdown(before: string | null, after: string | null): DocDiff<Record<string, unknown>> {
  return diffParsedDocs(before === null ? null : parsePlainMarkdown(before), after === null ? null : parsePlainMarkdown(after));
}

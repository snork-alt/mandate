/**
 * Idempotent, reversible file edits. Every operation computes a `Change` (before / after text); `applyChanges`
 * writes them, or with `dryRun` only prints a diff. User content is never clobbered:
 * - JSON configs: one key is set / removed; the rest of the document, key order and indentation are kept. Files with
 *   comments (JSONC) are refused with manual instructions instead of being rewritten without their comments.
 * - Markdown / TOML / shell rc: a block between `mandate:begin` / `mandate:end` markers.
 * - Whole files (skills, commands): carry MANAGED_MARK; removal only deletes files that still carry it.
 */
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { c, type Out } from './ui.js';

export const MANAGED_MARK = 'managed by mandate';

export interface Change {
  file: string;
  /** null = file does not exist. */
  before: string | null;
  /** null = delete the file. */
  after: string | null;
  summary: string;
  /** Written with mode 0600 (key material). */
  private?: boolean;
}

export const readText = (file: string): string | null => (existsSync(file) ? readFileSync(file, 'utf8') : null);

export function change(file: string, after: string | null, summary: string, opts: { private?: boolean } = {}): Change | null {
  const before = readText(file);
  if (before === after) return null;
  return { file, before, after, summary, ...(opts.private ? { private: true } : {}) };
}

/* ------------------------------------------------------------------ JSON */

export class JsoncError extends Error {
  constructor(readonly file: string) {
    super(`${file} has comments (JSONC); edit it by hand`);
  }
}

/** True when the text has // or /* comments outside strings. */
export function hasComments(text: string): boolean {
  let inStr = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (ch === '\\') i++;
      else if (ch === '"') inStr = false;
    } else if (ch === '"') inStr = true;
    else if (ch === '/' && (text[i + 1] === '/' || text[i + 1] === '*')) return true;
  }
  return false;
}

function detectIndent(text: string): string | number {
  const m = /^[ \t]+(?=")/m.exec(text);
  return m ? (m[0].includes('\t') ? '\t' : m[0].length) : 2;
}

function parseJson(file: string, text: string | null): Record<string, unknown> {
  if (text === null || !text.trim()) return {};
  if (hasComments(text)) throw new JsoncError(file);
  const v = JSON.parse(text) as unknown;
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error(`${file}: expected a JSON object`);
  return v as Record<string, unknown>;
}

const stringify = (v: unknown, indent: string | number, eol: boolean) => JSON.stringify(v, null, indent) + (eol ? '\n' : '');

/** Set `keyPath` (objects created as needed) to `value`. */
export function jsonSet(file: string, text: string | null, keyPath: string[], value: unknown): string {
  const doc = parseJson(file, text);
  let o = doc;
  for (const k of keyPath.slice(0, -1)) {
    const next = o[k];
    if (!next || typeof next !== 'object' || Array.isArray(next)) o[k] = {};
    o = o[k] as Record<string, unknown>;
  }
  o[keyPath[keyPath.length - 1]!] = value;
  return stringify(doc, text ? detectIndent(text) : 2, text ? text.endsWith('\n') : true);
}

/** Remove `keyPath`; parents left empty by the removal are pruned. Returns the text unchanged when absent. */
export function jsonRemove(file: string, text: string | null, keyPath: string[]): string | null {
  if (text === null) return null;
  const doc = parseJson(file, text);
  const chain: Record<string, unknown>[] = [doc];
  for (const k of keyPath.slice(0, -1)) {
    const next = chain[chain.length - 1]![k];
    if (!next || typeof next !== 'object') return text;
    chain.push(next as Record<string, unknown>);
  }
  const last = keyPath[keyPath.length - 1]!;
  if (!(last in chain[chain.length - 1]!)) return text;
  delete chain[chain.length - 1]![last];
  for (let i = chain.length - 1; i > 0; i--) {
    if (Object.keys(chain[i]!).length) break;
    delete chain[i - 1]![keyPath[i - 1]!];
  }
  return stringify(doc, detectIndent(text), text.endsWith('\n'));
}

export function jsonGet(file: string, text: string | null, keyPath: string[]): unknown {
  let o: unknown = parseJson(file, text);
  for (const k of keyPath) {
    if (!o || typeof o !== 'object') return undefined;
    o = (o as Record<string, unknown>)[k];
  }
  return o;
}

/* ------------------------------------------------------------------ marker blocks */

export type CommentStyle = 'html' | 'hash';
const markers = (id: string, style: CommentStyle) =>
  style === 'html'
    ? { begin: `<!-- mandate:begin ${id} (${MANAGED_MARK}; edits inside are replaced) -->`, end: `<!-- mandate:end ${id} -->`, beginRe: new RegExp(`<!-- mandate:begin ${id}\\b[^\\n]*-->`), endRe: new RegExp(`<!-- mandate:end ${id} -->`) }
    : { begin: `# >>> mandate:begin ${id} (${MANAGED_MARK}; edits inside are replaced) >>>`, end: `# <<< mandate:end ${id} <<<`, beginRe: new RegExp(`# >>> mandate:begin ${id}\\b[^\\n]*`), endRe: new RegExp(`# <<< mandate:end ${id} <<<`) };

/** Insert or replace the block `id` (appended at the end when new). */
export function upsertBlock(text: string | null, id: string, body: string, style: CommentStyle): string {
  const m = markers(id, style);
  const block = `${m.begin}\n${body.replace(/\n+$/, '')}\n${m.end}`;
  const t = text ?? '';
  const b = m.beginRe.exec(t);
  const e = m.endRe.exec(t);
  if (b && e && e.index > b.index) return t.slice(0, b.index) + block + t.slice(e.index + e[0].length);
  if (!t.trim()) return `${block}\n`;
  return `${t.replace(/\n*$/, '')}\n\n${block}\n`;
}

/** Remove the block `id` (and the blank line before it). Returns the text unchanged when absent. */
export function removeBlock(text: string | null, id: string, style: CommentStyle): string | null {
  if (text === null) return null;
  const m = markers(id, style);
  const b = m.beginRe.exec(text);
  const e = m.endRe.exec(text);
  if (!b || !e || e.index < b.index) return text;
  const head = text.slice(0, b.index).replace(/\n*$/, '');
  const tail = text.slice(e.index + e[0].length).replace(/^\n+/, '');
  const out = head && tail ? `${head}\n\n${tail}` : head ? `${head}\n` : tail;
  return out;
}

export const hasBlock = (text: string | null, id: string, style: CommentStyle) => !!text && markers(id, style).beginRe.test(text);

/* ------------------------------------------------------------------ apply */

/** A short line diff (changed region only). */
export function diff(before: string | null, after: string | null): string[] {
  const a = before === null ? [] : before.split('\n');
  const b = after === null ? [] : after.split('\n');
  let s = 0;
  while (s < a.length && s < b.length && a[s] === b[s]) s++;
  let ea = a.length;
  let eb = b.length;
  while (ea > s && eb > s && a[ea - 1] === b[eb - 1]) {
    ea--;
    eb--;
  }
  return [...a.slice(s, ea).map((l) => c.red(`- ${l}`)), ...b.slice(s, eb).map((l) => c.green(`+ ${l}`))];
}

/** Hide key-looking values in previews. */
export const redact = (s: string) => s.replace(/mnd_[A-Za-z0-9_-]{8,}/g, 'mnd_***');

export function applyChanges(changes: (Change | null)[], opts: { dryRun: boolean; out: Out; maxDiffLines?: number; home?: string }): Change[] {
  const real = changes.filter((x): x is Change => !!x);
  const show = (f: string) => (opts.home && f.startsWith(opts.home + path.sep) ? `~${f.slice(opts.home.length)}` : f);
  const verbOf = (ch: Change) => (ch.after === null ? 'remove' : ch.before === null ? 'create' : 'update');
  // Without --dry-run, files of one kind in one folder are listed on one line.
  const groups = new Map<string, Change[]>();
  for (const ch of real) {
    const k = opts.dryRun ? `${ch.file}` : `${verbOf(ch)}|${path.dirname(ch.file)}|${ch.summary}`;
    groups.set(k, [...(groups.get(k) ?? []), ch]);
  }
  for (const g of groups.values()) {
    const ch = g[0]!;
    const verb = verbOf(ch);
    const where = g.length > 1 ? `${show(path.dirname(ch.file))}/{${g.map((x) => path.basename(x.file)).join(',')}}` : show(ch.file);
    opts.out.log(`  ${c.dim(opts.dryRun ? `would ${verb}` : verb)} ${g.length > 4 ? `${show(path.dirname(ch.file))}/ ${c.dim(`(${g.length} files)`)}` : where} ${c.dim(`(${ch.summary})`)}`);
    if (!opts.dryRun) continue;
    const lines = diff(ch.before, ch.after);
    const max = opts.maxDiffLines ?? (ch.before === null ? 8 : 40);
    for (const l of lines.slice(0, max)) opts.out.log(`      ${redact(l)}`);
    if (lines.length > max) opts.out.log(c.dim(`      … ${lines.length - max} more lines`));
  }
  if (!opts.dryRun) {
    for (const ch of real) {
      if (ch.after === null) {
        rmSync(ch.file, { force: true });
        pruneEmptyDirs(path.dirname(ch.file));
      } else {
        mkdirSync(path.dirname(ch.file), { recursive: true });
        writeFileSync(ch.file, ch.after, ch.private ? { mode: 0o600 } : {});
        if (ch.private) chmodSync(ch.file, 0o600);
      }
    }
  }
  return real;
}

/** Remove now-empty directories we created (only those named for Mandate). */
const PRUNABLE = new Set(['.codex', '.cursor', '.vscode', '.gemini', '.devin']);
function pruneEmptyDirs(dir: string): void {
  let d = dir;
  while ((/mandate/i.test(path.basename(d)) || PRUNABLE.has(path.basename(d))) && existsSync(d) && readdirSync(d).length === 0) {
    rmdirSync(d);
    d = path.dirname(d);
  }
}

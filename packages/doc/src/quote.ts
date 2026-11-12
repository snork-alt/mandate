/**
 * Map a quote selected in rendered markdown back to lines of the source file.
 * Matching ignores whitespace and markdown syntax (emphasis, code ticks, headings,
 * list / task / quote markers, link targets), so "Tokens are issued by AuthService.login"
 * finds "Tokens are **issued** by `AuthService.login`".
 */
export interface QuoteLocation {
  /** 1-based, inclusive lines in the source file. */
  start: number;
  end: number;
}

const MARKER_RE = /^<!--\s*@section\s+(\S+)\s*-->\s*$/;

/** Characters dropped from both sides before comparing. */
const SYNTAX = new Set(['*', '_', '`', '~', '#', '>', '[', ']', '|', '\\']);

interface Stream {
  text: string;
  /** Source line (1-based) of each character in `text`. */
  lines: number[];
}

/** Normalize a range of source lines into a comparable character stream with line mapping. */
function normalizeSource(sourceLines: string[], from: number, to: number): Stream {
  let text = '';
  const lines: number[] = [];
  const push = (ch: string, line: number) => {
    if (/\s/.test(ch)) {
      if (text && !text.endsWith(' ')) {
        text += ' ';
        lines.push(line);
      }
      return;
    }
    text += ch.toLowerCase();
    lines.push(line);
  };
  for (let i = from; i < to; i++) {
    let line = sourceLines[i]!;
    if (MARKER_RE.test(line) || /^\s*(```|~~~)/.test(line) || /^-{3,}\s*$/.test(line)) {
      push(' ', i + 1);
      continue;
    }
    line = line
      .replace(/^\s*#{1,6}\s+/, '') // headings
      .replace(/^\s*>\s?/, '') // block quotes
      .replace(/^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/, '') // list and task markers
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1') // links / images: keep the text only
      .replace(/<[^>]+>/g, ' '); // inline HTML tags
    for (const ch of line) if (!SYNTAX.has(ch)) push(ch, i + 1);
    push(' ', i + 1);
  }
  return { text, lines };
}

function normalizeQuote(quote: string): string {
  let out = '';
  for (const ch of quote) {
    if (SYNTAX.has(ch)) continue;
    if (/\s/.test(ch)) {
      if (out && !out.endsWith(' ')) out += ' ';
    } else out += ch.toLowerCase();
  }
  return out.trim();
}

/** Line range of a section's block (marker line through the line before the next marker). */
export function sectionLineRange(source: string, sectionId: string): QuoteLocation | null {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const start = lines.findIndex((l) => MARKER_RE.exec(l)?.[1] === sectionId);
  if (start < 0) return null;
  let end = lines.findIndex((l, i) => i > start && MARKER_RE.test(l));
  if (end < 0) end = lines.length;
  while (end - 1 > start && lines[end - 1]!.trim() === '') end--;
  return { start: start + 1, end };
}

/**
 * Find `quote` in `source` (optionally only inside section `sectionId`).
 * Returns the source lines when the quote occurs exactly once, else null.
 */
export function locateQuote(source: string, quote: string, sectionId?: string): QuoteLocation | null {
  const needle = normalizeQuote(quote);
  if (needle.length < 2) return null;
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  let from = 0;
  let to = lines.length;
  if (sectionId) {
    const range = sectionLineRange(source, sectionId);
    if (!range) return null;
    from = range.start - 1;
    to = range.end;
  }
  const stream = normalizeSource(lines, from, to);
  const first = stream.text.indexOf(needle);
  if (first < 0 || stream.text.indexOf(needle, first + 1) >= 0) return null;
  return { start: stream.lines[first]!, end: stream.lines[first + needle.length - 1]! };
}

const FENCE_RE = /^\s*(`{3,}|~{3,})/;

/** Lines of a section's body (after the `## title` heading, blank lines trimmed); for fenced types: fence open to close. */
export function sectionBodyRange(source: string, sectionId: string): QuoteLocation | null {
  const range = sectionLineRange(source, sectionId);
  if (!range) return null;
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  let start = range.start; // marker line (1-based)
  // skip marker, heading and blank lines
  start++;
  while (start <= range.end && (/^##\s/.test(lines[start - 1]!) || lines[start - 1]!.trim() === '')) start++;
  if (start > range.end) return null;
  return { start, end: range.end };
}

/**
 * Lines of the fenced code block inside a section whose content equals `code` (fence open to
 * close, 1-based). Falls back to the first fenced block when `code` is not given.
 */
export function codeBlockRange(source: string, sectionId: string, code?: string): QuoteLocation | null {
  const range = sectionLineRange(source, sectionId);
  if (!range) return null;
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const want = code?.replace(/\n$/, '').trim();
  for (let i = range.start; i < range.end; i++) {
    const open = FENCE_RE.exec(lines[i]!);
    if (!open) continue;
    const fence = open[1]!;
    let j = i + 1;
    while (j < range.end && !lines[j]!.trimStart().startsWith(fence)) j++;
    const body = lines.slice(i + 1, j).join('\n').trim();
    if (!want || body === want) return { start: i + 1, end: Math.min(j + 1, range.end) };
    i = j;
  }
  return null;
}

/**
 * References for a selection spanning one or more sections: each picked text is located in its
 * section (whitespace / markdown insensitive); unlocatable picks fall back to the whole section.
 */
export function selectionRanges(source: string, picks: { sectionId: string; text: string }[]): { sectionId: string; lines: QuoteLocation | null }[] {
  return picks.map((p) => ({ sectionId: p.sectionId, lines: locateQuote(source, p.text, p.sectionId) }));
}

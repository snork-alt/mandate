import type { DocWarning } from './errors.js';
import type { Section } from './schema.js';
import { estimateTokens, type Tokenizer } from './tokens.js';

const MARKER_RE = /^<!--\s*@section\s+(\S+)\s*-->\s*$/;
const STOP = new Set(
  'about above after again against because before being below between could does doing during each from further having here into itself more most other ought same should some such than that their theirs them then there these they this those through under until very were what when where which while whom with would your yours also must only uses using used'.split(
    ' ',
  ),
);

/** Lowercased content words (5+ letters, no stop words), crudely stemmed. */
function contentWords(text: string): Set<string> {
  const out = new Set<string>();
  for (const w of text.toLowerCase().match(/[a-z][a-z0-9]{4,}/g) ?? []) {
    if (!STOP.has(w)) out.add(w.slice(0, 5));
  }
  return out;
}

/** True when a summary probably no longer describes its section: none of its content words occur in the title or body. */
export function isSummaryLikelyStale(section: Pick<Section, 'title' | 'body' | 'summary'>): boolean {
  if (!section.summary || !section.body.trim()) return false;
  const words = contentWords(section.summary);
  if (words.size < 3) return false;
  const have = contentWords(`${section.title}\n${section.body}`);
  for (const w of words) if (have.has(w)) return false;
  return true;
}

function markerLines(md: string): Map<string, number> {
  const out = new Map<string, number>();
  md.replace(/\r\n?/g, '\n')
    .split('\n')
    .forEach((l, i) => {
      const m = MARKER_RE.exec(l);
      if (m && !out.has(m[1]!)) out.set(m[1]!, i + 1);
    });
  return out;
}

/** `summary-missing` / `summary-stale` warnings for parsed sections (line = section marker when `md` is given). */
export function sectionSummaryWarnings(sections: Pick<Section, 'id' | 'title' | 'body' | 'summary'>[], md?: string): DocWarning[] {
  const lines = md ? markerLines(md) : new Map<string, number>();
  const out: DocWarning[] = [];
  for (const s of sections) {
    const line = lines.get(s.id);
    if (!s.summary) {
      out.push({ code: 'summary-missing', message: `section '${s.id}' has no summary; add a one-sentence summary`, sectionId: s.id, line });
    } else if (isSummaryLikelyStale(s)) {
      out.push({
        code: 'summary-stale',
        message: `section '${s.id}': the summary shares no key words with the section text; is it still accurate?`,
        sectionId: s.id,
        line,
      });
    }
  }
  return out;
}

export interface SectionAdviceOptions {
  /** Sections above this size get a `section-too-long` warning (default 600). */
  sectionSoftLimitTokens?: number;
  tokenizer?: Tokenizer;
}

/** Non-blocking authoring advice for a set of sections: missing / stale summaries and oversized sections. */
export function sectionAdvice(sections: Pick<Section, 'id' | 'title' | 'body' | 'summary'>[], opts: SectionAdviceOptions = {}): DocWarning[] {
  const limit = opts.sectionSoftLimitTokens ?? 600;
  const count = opts.tokenizer ?? ((t: string) => estimateTokens(t));
  const out = sectionSummaryWarnings(sections);
  for (const s of sections) {
    const tokens = count(s.body);
    if (tokens > limit) {
      out.push({
        code: 'section-too-long',
        message: `section '${s.id}' is ${tokens} tokens (soft limit ${limit}); consider splitting it into one concept per section`,
        sectionId: s.id,
      });
    }
  }
  return out;
}

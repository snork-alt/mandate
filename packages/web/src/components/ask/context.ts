import { buildQuestionRef, buildRef, type RefKind } from '@mandate/shared/refs';
import type { AskChip } from './types';

export interface PageSelection {
  sectionId: string;
  text: string;
}

const KINDS: Record<string, { ref: RefKind; kind: AskChip['kind'] }> = {
  specs: { ref: 'specs', kind: 'spec' },
  standards: { ref: 'standards', kind: 'standard' },
  'work-orders': { ref: 'work-orders', kind: 'work_order' },
  feedback: { ref: 'feedback', kind: 'feedback' },
};

/**
 * Context chips for the page at this location: the document (pinned to `?version=<sha>` when viewing a version)
 * and the selected section: a text selection, else the `#section-<id>` anchor (with `?lines=a-b` as `#L`); on a question
 * page (/questions/:id), the question.
 */
export function chipsFromLocation(loc: { pathname: string; search: string; hash: string }, selection?: PageSelection | null): AskChip[] {
  // A question a coding agent asked (/questions/:id): ask about it in the Ask pane.
  const qm = /^\/questions\/([^/]+)$/.exec(loc.pathname);
  if (qm) {
    const id = decodeURIComponent(qm[1]!);
    return [{ uri: buildQuestionRef(id), kind: 'question', label: id }];
  }
  const m = /^\/(specs|standards|work-orders|feedback)\/([^/@]+)/.exec(loc.pathname);
  if (!m) return [];
  const { ref, kind } = KINDS[m[1]!]!;
  const id = decodeURIComponent(m[2]!);
  const params = new URLSearchParams(loc.search);
  const commit = params.get('version') || undefined;
  const chips: AskChip[] = [{ uri: buildRef({ kind: ref, id, commit }), kind, label: commit ? `${id} @${commit.slice(0, 7)}` : id }];
  if (ref === 'specs' || ref === 'standards') {
    const hashSection = decodeURIComponent(loc.hash.replace(/^#(section-)?/, ''));
    const sectionId = selection?.sectionId ?? (/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(hashSection) ? hashSection : '');
    if (sectionId) {
      const lm = !selection && /^(\d+)-(\d+)$/.exec(params.get('lines') ?? '');
      const lines = lm ? { start: Number(lm[1]), end: Number(lm[2]) } : undefined;
      chips.push({
        uri: buildRef({ kind: ref, id, sectionId, commit, lines }),
        kind: 'section',
        label: `${id} › ${sectionId}${lines ? ` L${lines.start}-${lines.end}` : ''}`,
        quote: selection?.text,
      });
    }
  }
  return chips;
}

const strip = (uri: string) => uri.trim().replace(/^@mandate:/, '');

/** Chips with the same reference collapse into one (quotes are merged). */
export function dedupeChips(chips: AskChip[]): AskChip[] {
  const map = new Map<string, AskChip>();
  for (const c of chips) {
    const key = strip(c.uri);
    const prev = map.get(key);
    if (!prev) map.set(key, { ...c, uri: key });
    else if (c.quote && c.quote !== prev.quote) map.set(key, { ...prev, quote: prev.quote ? `${prev.quote}\n${c.quote}` : c.quote });
  }
  return [...map.values()];
}

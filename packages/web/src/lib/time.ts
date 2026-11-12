const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto', style: 'short' });
const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 365 * 24 * 3600],
  ['month', 30 * 24 * 3600],
  ['week', 7 * 24 * 3600],
  ['day', 24 * 3600],
  ['hour', 3600],
  ['minute', 60],
];

/** "3 min. ago", "yesterday", "just now". */
export function relativeTime(iso: string, now = Date.now()): string {
  const diff = (new Date(iso).getTime() - now) / 1000;
  if (Number.isNaN(diff)) return '';
  for (const [unit, secs] of UNITS) {
    if (Math.abs(diff) >= secs) return rtf.format(Math.round(diff / secs), unit);
  }
  return 'just now';
}

export function absoluteTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

/** First meaningful line of a markdown body, stripped of markup, for list excerpts. */
export function excerpt(body: string, max = 140): string {
  for (const raw of body.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('```') || line.startsWith('---')) continue;
    const text = line.replace(/^[-*>]\s+|^\d+\.\s+|[*_`[\]]|\(http[^)]*\)/g, '').trim();
    if (text) return text.length > max ? `${text.slice(0, max)}…` : text;
  }
  return '';
}

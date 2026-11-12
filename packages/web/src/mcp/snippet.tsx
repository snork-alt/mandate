import type { ReactNode } from 'react';

const ENTITIES: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&#x27;': "'" };
const decode = (s: string) => s.replace(/&(?:amp|lt|gt|quot|#39|#x27);/g, (m) => ENTITIES[m]!);

/**
 * Render a server snippet (HTML-escaped except `<mark>`) as React nodes: no innerHTML, so the only
 * element that can appear is <mark>; everything else is decoded and rendered as plain text.
 */
export function renderSnippet(html: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /<mark>([\s\S]*?)<\/mark>/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    if (m.index > last) out.push(decode(html.slice(last, m.index)));
    out.push(<mark key={m.index}>{decode(m[1]!)}</mark>);
    last = m.index + m[0].length;
  }
  if (last < html.length) out.push(decode(html.slice(last)));
  return out;
}

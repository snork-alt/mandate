const OPEN = /^\s*(`{3,}|~{3,})[ \t]*([\w+-]*)[^\n]*$/;

/** The language of a body wrapped in one code fence (``` / ```mermaid / ~~~html ...), or null when it is not wrapped. */
export function wrappingFence(body: string): { lang: string } | null {
  const lines = body.replace(/\r\n?/g, '\n').trim().split('\n');
  if (lines.length < 2) return null;
  const open = OPEN.exec(lines[0]!);
  if (!open) return null;
  const marker = open[1]!;
  const close = lines[lines.length - 1]!.trim();
  // The closing fence uses the same character, at least as long as the opening one.
  if (close[0] !== marker[0] || close.length < marker.length || !/^(`+|~+)$/.test(close)) return null;
  return { lang: open[2] ?? '' };
}

/**
 * Strip ONE leading fence line and its matching trailing fence (agents sometimes wrap a mermaid or
 * html body in its own ```mermaid / ```html fence). Anything else is returned unchanged.
 */
export function stripWrappingFence(body: string): string {
  if (!wrappingFence(body)) return body;
  const lines = body.replace(/\r\n?/g, '\n').trim().split('\n');
  return lines.slice(1, -1).join('\n');
}

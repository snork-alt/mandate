/** Unified diff text (`--- a/x`, `+++ b/x`, +/- lines with 3 lines of context); the diff engine loads lazily. */
export async function unifiedDiff(before: string, after: string, path: string): Promise<string> {
  const { diffText } = await import('@mandate/doc');
  const rows: string[] = [];
  for (const op of diffText(before, after, 'lines')) {
    const sign = op.op === 'insert' ? '+' : op.op === 'delete' ? '-' : ' ';
    for (const l of op.text.replace(/\n$/, '').split('\n')) rows.push(sign + l);
  }
  // Keep 3 lines of context around changes.
  const keep = rows.map((r, i) => r[0] !== ' ' || rows.slice(Math.max(0, i - 3), i + 4).some((x) => x[0] !== ' '));
  const out = [`--- a/${path}`, `+++ b/${path}`];
  let skipping = false;
  rows.forEach((r, i) => {
    if (keep[i]) {
      out.push(r);
      skipping = false;
    } else if (!skipping) {
      out.push('@@ … @@');
      skipping = true;
    }
  });
  return out.join('\n');
}

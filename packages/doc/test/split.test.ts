import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createDocFormat, estimateTokens, isSummaryLikelyStale, sectionAdvice, type Section } from '../src/index.js';
import { bodyStartLine, chunkDocument, chunkInput, chunkSection, docChunk, htmlToLines, mermaidToLines, type ChunkDoc } from '../src/split/index.js';

const fmt = createDocFormat(z.object({ title: z.string(), category: z.string().optional(), summary: z.string().optional() }));

/** Build a canonical document source and its ChunkDoc from sections. */
function makeDoc(sections: Partial<Section>[], extra: Partial<ChunkDoc> = {}): ChunkDoc {
  const source = fmt.serialize({
    frontmatter: { title: 'Sessions', category: 'auth', summary: 'Session handling.' },
    sections: sections.map((s, i) => ({ id: s.id ?? `s${i}`, title: s.title ?? `Section ${i}`, ...s })) as never,
  });
  const parsed = fmt.parse(source);
  return {
    uri: 'mandate://specs/sessions',
    kind: 'Spec',
    title: 'Sessions',
    category: 'auth',
    summary: 'Session handling.',
    standards: ['security-baseline'],
    sections: parsed.sections,
    source,
    ...extra,
  };
}

const sentence = (i: number) => `Sentence number ${i} explains one rule about refresh tokens and how they rotate.`;
const para = (from: number, n: number) => Array.from({ length: n }, (_, k) => sentence(from + k)).join(' ');

/** Every chunk's text (minus wrappers) should be found within its line range in the source. */
function linesOf(doc: ChunkDoc, start: number, end: number): string {
  return doc.source!.split('\n').slice(start - 1, end).join('\n');
}

describe('estimateTokens', () => {
  it('is ceil(chars/4) with a 15% margin', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('abcd')).toBe(2); // ceil(1 * 1.15)
    expect(estimateTokens('x'.repeat(400))).toBe(115);
    expect(estimateTokens('x'.repeat(400), 0)).toBe(100);
  });
});

describe('chunkSection', () => {
  it('keeps a small section as one chunk with prefix, lines and hash', () => {
    const doc = makeDoc([{ id: 'overview', title: 'Overview', body: 'Access tokens live 15 minutes.', symbols: ['AuthService.login'], links: [{ to: 'mandate://standards/api-conventions', rel: 'follows' }] }]);
    const [c, ...rest] = chunkSection(doc, doc.sections[0]!);
    expect(rest).toHaveLength(0);
    expect(c!.chunkIndex).toBe(0);
    expect(c!.kind).toBe('section');
    expect(c!.uri).toBe('mandate://specs/sessions/sections/overview');
    expect(c!.text).toBe('Access tokens live 15 minutes.');
    expect(c!.contextPrefix).toBe(
      'Spec: Sessions (auth) › Overview\nStandards: security-baseline, api-conventions\nSymbols: AuthService.login',
    );
    expect(linesOf(doc, c!.lineStart, c!.lineEnd)).toBe('Access tokens live 15 minutes.');
    expect(c!.contentHash).toBe(createHash('sha256').update(c!.text + c!.contextPrefix).digest('hex'));
  });

  it('adds the summary as chunk -1', () => {
    const doc = makeDoc([{ id: 'a', title: 'A', summary: 'Tokens rotate on every use.', body: 'Body.' }]);
    const chunks = chunkSection(doc, doc.sections[0]!);
    expect(chunks.map((c) => [c.chunkIndex, c.kind])).toEqual([
      [-1, 'summary'],
      [0, 'section'],
    ]);
    expect(chunks[0]!.text).toBe('Tokens rotate on every use.');
  });

  it('splits long sections so prefix + text fits the target, with valid line ranges', () => {
    const body = [para(0, 6), '### Rotation', para(10, 8), '### Reuse detection', para(20, 8), '- item one about revocation\n- item two about families\n- item three'].join('\n\n');
    const doc = makeDoc([{ id: 'big', title: 'Big', body }]);
    const chunks = chunkSection(doc, doc.sections[0]!, { chunkTargetTokens: 120 });
    expect(chunks.length).toBeGreaterThan(3);
    for (const c of chunks) {
      expect(c.tokens).toBeLessThanOrEqual(120);
      expect(estimateTokens(chunkInput(c))).toBe(c.tokens);
      // Every sentence of the chunk occurs in the lines it claims.
      const src = linesOf(doc, c.lineStart, c.lineEnd);
      for (const s of c.text.split(/(?<=\.)\s+|\n+/).filter((x) => x.trim())) expect(src).toContain(s.trim());
    }
    // Subheading path in the prefix.
    expect(chunks.some((c) => c.contextPrefix.startsWith('Spec: Sessions (auth) › Big › Rotation'))).toBe(true);
    expect(chunks.some((c) => c.contextPrefix.startsWith('Spec: Sessions (auth) › Big › Reuse detection'))).toBe(true);
    // Indices are consecutive.
    expect(chunks.map((c) => c.chunkIndex)).toEqual(chunks.map((_, i) => i));
  });

  it('starts a new chunk at a subheading when the group does not fit', () => {
    const body = [para(0, 2), '### Second', para(10, 2)].join('\n\n');
    const doc = makeDoc([{ id: 'g', title: 'G', body }]);
    const chunks = chunkSection(doc, doc.sections[0]!, { chunkTargetTokens: 90, chunkOverlapTokens: 0 });
    const second = chunks.find((c) => c.text.includes('### Second'))!;
    expect(second.text.startsWith('### Second')).toBe(true);
    expect(second.contextPrefix).toContain('› G › Second');
  });

  it('repeats the table header in every chunk of a split table', () => {
    const rows = Array.from({ length: 30 }, (_, i) => `| row${i} | value number ${i} for the session table | note ${i} |`);
    const body = ['| Name | Value | Notes |', '|---|---|---|', ...rows].join('\n');
    const doc = makeDoc([{ id: 't', title: 'T', body }]);
    const chunks = chunkSection(doc, doc.sections[0]!, { chunkTargetTokens: 150 });
    expect(chunks.length).toBeGreaterThan(2);
    const seen: string[] = [];
    for (const c of chunks) {
      const lines = c.text.split('\n');
      expect(lines[0]).toBe('| Name | Value | Notes |');
      expect(lines[1]).toBe('|---|---|---|');
      for (const l of lines.slice(2)) {
        expect(l).toMatch(/^\| row\d+ \|/);
        seen.push(l);
      }
      expect(c.tokens).toBeLessThanOrEqual(150);
      // Line range covers the rows (header lines are repeated, not counted).
      expect(linesOf(doc, c.lineStart, c.lineEnd)).toContain(lines[2]);
    }
    // Every row appears; rows are never cut (tables are not prose, so no overlap).
    expect(new Set(seen)).toEqual(new Set(rows));
  });

  it('never splits a code block that fits', () => {
    const code = ['```ts', ...Array.from({ length: 12 }, (_, i) => `const value${i} = compute(${i});`), '```'].join('\n');
    const body = [para(0, 4), code, para(10, 4)].join('\n\n');
    const doc = makeDoc([{ id: 'c', title: 'C', body }]);
    const chunks = chunkSection(doc, doc.sections[0]!, { chunkTargetTokens: 200, chunkOverlapTokens: 0 });
    const withCode = chunks.filter((c) => c.text.includes('const value'));
    expect(withCode).toHaveLength(1);
    expect(withCode[0]!.text).toContain(code);
  });

  it('splits an oversized code block at blank lines, then lines, re-fencing each part', () => {
    const blocks = Array.from({ length: 6 }, (_, b) => Array.from({ length: 4 }, (_, i) => `  step${b}_${i}(session, token);`).join('\n'));
    const longLine = Array.from({ length: 3 }, (_, i) => `  veryLongStatementNumber${i}(argumentOne, argumentTwo, argumentThree);`);
    const code = ['```ts', 'function rotate() {', blocks.join('\n\n'), ...longLine, '}', '```'].join('\n');
    const doc = makeDoc([{ id: 'c', title: 'C', body: code }]);
    const chunks = chunkSection(doc, doc.sections[0]!, { chunkTargetTokens: 90 });
    expect(chunks.length).toBeGreaterThan(2);
    for (const c of chunks) {
      expect(c.text.startsWith('```ts\n')).toBe(true);
      expect(c.text.endsWith('\n```')).toBe(true);
      expect(c.tokens).toBeLessThanOrEqual(90);
      // No blank-line block is broken unless it alone exceeds the budget: each stepN group stays together.
      for (const b of [0, 1, 2, 3, 4, 5]) {
        const n = (c.text.match(new RegExp(`step${b}_`, 'g')) ?? []).length;
        expect([0, 4]).toContain(n);
      }
    }
    expect(chunks.map((c) => c.text).join('\n')).toContain('step5_3(session, token);');
  });

  it('splits lists between items', () => {
    const items = Array.from({ length: 20 }, (_, i) => `- Item ${i}: ${sentence(i)}`);
    const doc = makeDoc([{ id: 'l', title: 'L', body: items.join('\n') }]);
    const chunks = chunkSection(doc, doc.sections[0]!, { chunkTargetTokens: 120, chunkOverlapTokens: 0 });
    expect(chunks.length).toBeGreaterThan(2);
    for (const c of chunks) for (const l of c.text.split('\n')) expect(items).toContain(l);
  });

  it('overlaps consecutive chunks on sentence boundaries', () => {
    const doc = makeDoc([{ id: 'o', title: 'O', body: para(0, 20) }]);
    const chunks = chunkSection(doc, doc.sections[0]!, { chunkTargetTokens: 140, chunkOverlapTokens: 30 });
    expect(chunks.length).toBeGreaterThan(2);
    for (let i = 1; i < chunks.length; i++) {
      const prevLast = chunks[i - 1]!.text.split(/(?<=\.)\s+/).pop()!;
      const first = chunks[i]!.text.split(/(?<=\.)\s+/)[0]!;
      expect(first).toBe(prevLast);
      expect(first).toMatch(/^Sentence number \d+ .*\.$/);
    }
    const none = chunkSection(doc, doc.sections[0]!, { chunkTargetTokens: 140, chunkOverlapTokens: 0 });
    const all = none.map((c) => c.text).join(' ');
    expect(all).toBe(para(0, 20));
  });

  it('falls back to word windows for a single huge sentence', () => {
    const words = Array.from({ length: 400 }, (_, i) => `word${i}`).join(' ');
    const doc = makeDoc([{ id: 'w', title: 'W', body: words }]);
    const chunks = chunkSection(doc, doc.sections[0]!, { chunkTargetTokens: 100, chunkOverlapTokens: 0 });
    expect(chunks.length).toBeGreaterThan(5);
    for (const c of chunks) expect(c.tokens).toBeLessThanOrEqual(100);
    expect(chunks.map((c) => c.text).join(' ')).toBe(words);
  });

  it('accepts an injected tokenizer', () => {
    const doc = makeDoc([{ id: 'o', title: 'O', body: para(0, 10) }]);
    const words = (t: string) => t.split(/\s+/).filter(Boolean).length;
    const chunks = chunkSection(doc, doc.sections[0]!, { chunkTargetTokens: 60, chunkOverlapTokens: 0, tokenizer: words });
    for (const c of chunks) expect(c.tokens).toBeLessThanOrEqual(60);
    expect(chunks.length).toBeGreaterThan(2);
  });

  it('indexes mermaid labels and maps lines to the diagram source', () => {
    const body = ['sequenceDiagram', '  actor U as User', '  participant A as App', '  U->>A: Click sign in', '  A-->>U: Set session cookie'].join('\n');
    const doc = makeDoc([{ id: 'm', title: 'Flow', type: 'mermaid', body }]);
    const [c] = chunkSection(doc, doc.sections[0]!);
    expect(c!.text).toBe('Actor: User\nParticipant: App\nUser → App: Click sign in\nApp → User: Set session cookie');
    expect(linesOf(doc, c!.lineStart, c!.lineEnd)).toBe(body);
    expect(bodyStartLine(doc.source!, 'm', true)).toBe(c!.lineStart);
  });

  it('maps lines of split mermaid sections to the diagram lines', () => {
    const body = ['flowchart TD', ...Array.from({ length: 30 }, (_, i) => `  N${i}[Step number ${i} of the long checkout flow] --> N${i + 1}`)].join('\n');
    const doc = makeDoc([{ id: 'm', title: 'Flow', type: 'mermaid', body }]);
    const chunks = chunkSection(doc, doc.sections[0]!, { chunkTargetTokens: 120 });
    expect(chunks.length).toBeGreaterThan(2);
    for (const c of chunks) {
      const first = c.text.split('\n')[0]!;
      const n = /Step number (\d+)/.exec(first)![1];
      expect(linesOf(doc, c.lineStart, c.lineStart)).toContain(`N${n}[Step number ${n} `);
    }
  });

  it('indexes the visible text of html sections', () => {
    const body = '<div class="card">\n  <h2>Team</h2>\n  <p>&euro;12 &middot; per seat</p>\n  <script>track()</script>\n  <style>.card{}</style>\n</div>';
    const doc = makeDoc([{ id: 'h', title: 'Card', type: 'html', body }]);
    const [c] = chunkSection(doc, doc.sections[0]!);
    expect(c!.text).toBe('## Team\n&euro;12 · per seat');
  });
});

describe('doc chunks', () => {
  it('summarises the document and its sections', () => {
    const doc = makeDoc([
      { id: 'a', title: 'Alpha', summary: 'First part.', body: 'x' },
      { id: 'b', title: 'Beta', body: 'y' },
    ]);
    const d = docChunk(doc);
    expect(d.uri).toBe('mandate://specs/sessions');
    expect(d.kind).toBe('doc');
    expect(d.text).toBe('Sessions\nSession handling.\nSections:\n- Alpha: First part.\n- Beta');
    expect(d.contextPrefix).toBe('Spec: Sessions (auth)\nStandards: security-baseline');
    expect(linesOf(doc, d.lineStart, d.lineEnd).split('\n').pop()).toBe('---');
    const all = chunkDocument(doc);
    expect(all.map((c) => `${c.kind}:${c.sectionId ?? ''}:${c.chunkIndex}`)).toEqual(['doc::0', 'summary:a:-1', 'section:a:0', 'section:b:0']);
  });
});

describe('extractors', () => {
  it('reads flowchart nodes and edge labels', () => {
    const lines = mermaidToLines(['flowchart LR', '  A[Checkout page] -->|pay| B{Payment ok?}', '  B -- yes --> C((Done))', '  B -->|no| A', '  style A fill:#fff', '  %% comment'].join('\n'));
    expect(lines).toEqual([
      { text: 'Checkout page → (pay) Payment ok?', line: 2 },
      { text: 'Payment ok? → (yes) Done', line: 3 },
      { text: 'Payment ok? → (no) Checkout page', line: 4 },
    ]);
  });

  it('reads state diagrams, notes and blocks', () => {
    const text = mermaidToLines(
      ['stateDiagram-v2', '  [*] --> Active: login', '  Active --> Revoked: reuse', '  Revoked --> [*]', '  note right of Active: rotates'].join('\n'),
    ).map((l) => l.text);
    expect(text).toEqual(['start → Active: login', 'Active → Revoked: reuse', 'Revoked → end', 'Note (Active): rotates']);
    const seq = mermaidToLines(['sequenceDiagram', '  participant S as Server', '  loop Every minute', '    S->>S: Flush usage', '  end'].join('\n'));
    expect(seq.map((l) => l.text)).toEqual(['Participant: Server', 'Loop: Every minute', 'Server → Server: Flush usage']);
  });

  it('strips html tags, scripts, styles and comments, keeping headings and alt text', () => {
    const lines = htmlToLines(
      '<section>\n<h1>Plans &amp; pricing</h1>\n<!-- hidden -->\n<p>Pay <b>yearly</b>,\nsave 2 months</p>\n<img src="x.png" alt="Logo">\n<input placeholder="Email address">\n<script>alert("x")</script><style>p{}</style>\n</section>',
    );
    expect(lines).toEqual([
      { text: '# Plans & pricing', line: 2 },
      { text: 'Pay yearly, save 2 months', line: 4 },
      { text: 'Logo Email address', line: 6 },
    ]);
  });
});

describe('summary warnings', () => {
  const doc = (summary?: string) =>
    fmt.serialize({
      frontmatter: { title: 'T' },
      sections: [{ id: 'a', title: 'Rotation', summary, body: 'Refresh tokens rotate on every use; reuse revokes the session family.' }],
    });

  it('round-trips the summary in frontmatter', () => {
    const md = doc('Refresh tokens rotate on every use.');
    expect(md).toContain('    summary: Refresh tokens rotate on every use.');
    expect(fmt.parse(md).sections[0]!.summary).toBe('Refresh tokens rotate on every use.');
  });

  it('warns (without failing) when a summary is missing or looks stale', () => {
    const missing = fmt.validate(doc());
    expect(missing.ok).toBe(true);
    expect(missing.warnings).toMatchObject([{ code: 'summary-missing', sectionId: 'a', line: expect.any(Number) }]);
    expect(fmt.validate(doc('Refresh tokens rotate whenever they are used.')).warnings).toEqual([]);
    const stale = fmt.validate(doc('Invoices render through Postmark templates daily.'));
    expect(stale.ok).toBe(true);
    expect(stale.warnings.map((w) => w.code)).toEqual(['summary-stale']);
    expect(isSummaryLikelyStale({ title: 'x', body: '', summary: 'anything goes here really' })).toBe(false);
  });

  it('sectionAdvice flags long sections', () => {
    const w = sectionAdvice([{ id: 'tokens', title: 'Tokens', summary: 'Tokens rotate.', body: 'Tokens rotate. '.repeat(400) }], { sectionSoftLimitTokens: 600 });
    expect(w).toHaveLength(1);
    expect(w[0]!.message).toMatch(/^section 'tokens' is \d+ tokens \(soft limit 600\); consider splitting/);
  });
});

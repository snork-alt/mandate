import { Document, isMap, isScalar, isSeq, parseDocument, type Node } from 'yaml';
import { z } from 'zod';
import { DocError, type DocIssue, type ValidationResult } from './errors.js';
import { checkBody, type SectionTypeRegistry } from './registry.js';
import { sectionMetaSchema, sectionSchema, type Doc, type Section, type SectionInput } from './schema.js';
import { createDefaultRegistry } from './types/index.js';
import { sectionSummaryWarnings } from './warnings.js';

/** `<!-- @section <id> -->` on its own line starts a section. */
const MARKER_RE = /^<!--\s*@section\s+(\S+)\s*-->\s*$/;
const HEADING_RE = /^##[ \t]+(.+?)[ \t]*$/;
const FENCE_OPEN_RE = /^(`{3,}|~{3,})[ \t]*([\w-]*)[ \t]*$/;
const RESERVED_KEY = 'sections';

export const markerFor = (id: string): string => `<!-- @section ${id} -->`;

/* ------------------------------------------------------------------ scan */

interface RawBlock {
  id: string;
  /** 1-based line of the marker. */
  line: number;
  heading: string | null;
  content: string;
}

interface Scan {
  issues: DocIssue[];
  data?: Record<string, unknown>;
  blocks: RawBlock[];
}

const isBlank = (l: string) => l.trim() === '';

function trimBlankLines(lines: string[]): string[] {
  let a = 0;
  let b = lines.length;
  while (a < b && isBlank(lines[a]!)) a++;
  while (b > a && isBlank(lines[b - 1]!)) b--;
  return lines.slice(a, b);
}

/** Split into YAML data and body blocks, tracking fences so markers inside code blocks are ignored. */
function scan(md: string): Scan {
  const issues: DocIssue[] = [];
  const lines = md.replace(/\r\n?/g, '\n').split('\n');
  if (lines[0] !== '---') {
    return { issues: [{ code: 'frontmatter-missing', message: 'document must start with a "---" frontmatter block', line: 1 }], blocks: [] };
  }
  const end = lines.findIndex((l, i) => i > 0 && l.trimEnd() === '---');
  if (end < 0) {
    return { issues: [{ code: 'frontmatter-missing', message: 'frontmatter block is not closed with "---"', line: 1 }], blocks: [] };
  }

  let data: Record<string, unknown> | undefined;
  const yamlDoc = parseDocument(lines.slice(1, end).join('\n'), { schema: 'core', uniqueKeys: true });
  if (yamlDoc.errors.length) {
    for (const e of yamlDoc.errors) {
      issues.push({ code: 'yaml-invalid', message: `invalid YAML: ${e.message.split('\n')[0]}`, line: (e.linePos?.[0]?.line ?? 0) + 1 });
    }
  } else {
    const js: unknown = yamlDoc.toJS() ?? {};
    if (typeof js !== 'object' || js === null || Array.isArray(js)) {
      issues.push({ code: 'yaml-invalid', message: 'frontmatter must be a YAML mapping', line: 2 });
    } else data = js as Record<string, unknown>;
  }

  const blocks: RawBlock[] = [];
  let current: { id: string; line: number; lines: string[] } | null = null;
  const preamble: number[] = [];
  let fence: string | null = null;
  const flush = () => {
    if (!current) return;
    const body = trimBlankLines(current.lines);
    const h = body[0] !== undefined ? HEADING_RE.exec(body[0]) : null;
    blocks.push({
      id: current.id,
      line: current.line,
      heading: h ? h[1]! : null,
      content: trimBlankLines(h ? body.slice(1) : body).join('\n'),
    });
  };
  for (let i = end + 1; i < lines.length; i++) {
    const line = lines[i]!;
    const lineNo = i + 1;
    if (fence === null) {
      const m = MARKER_RE.exec(line);
      if (m) {
        flush();
        current = { id: m[1]!, line: lineNo, lines: [] };
        continue;
      }
      const f = FENCE_OPEN_RE.exec(line.trimStart());
      if (f) fence = f[1]!;
    } else if (line.trimStart().startsWith(fence[0]!.repeat(fence.length)) && line.trim().replace(/[`~]/g, '') === '') {
      fence = null;
    }
    if (current) current.lines.push(line);
    else if (!isBlank(line)) preamble.push(lineNo);
  }
  flush();
  if (preamble.length) {
    issues.push({
      code: 'content-before-first-section',
      message: `content before the first section marker (line ${preamble[0]}); every block must start with ${markerFor('<id>')}`,
      line: preamble[0],
    });
  }
  return { issues, data, blocks };
}

/** Unwrap a ```lang fenced body for mermaid / html sections. */
function unwrapFence(content: string, lang: string): { body: string } | { error: 'fence-missing' | 'fence-mismatch'; found?: string } {
  const lines = content.split('\n');
  const open = lines.length >= 2 ? FENCE_OPEN_RE.exec(lines[0]!) : null;
  const last = lines[lines.length - 1]!.trimEnd();
  if (!open || last !== open[1]) return { error: 'fence-missing' };
  if (open[2] !== lang) return { error: 'fence-mismatch', found: open[2] || '(none)' };
  return { body: lines.slice(1, -1).join('\n') };
}

function fenceFor(body: string): string {
  let longest = 0;
  for (const m of body.matchAll(/^[ \t]*(`{3,})/gm)) longest = Math.max(longest, m[1]!.length);
  return '`'.repeat(Math.max(3, longest + 1));
}

/* ------------------------------------------------------------------ yaml emit */

function prune(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(prune);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (v === undefined || v === null || (Array.isArray(v) && v.length === 0)) continue;
      out[k] = prune(v);
    }
    return out;
  }
  return value;
}

const scalarMap = (n: unknown) => isMap(n) && n.items.every((p) => isScalar(p.value));

/** Scalar lists and nested lists of flat maps (e.g. refs) use flow style; everything else is block style. */
function styleNode(node: Node | null | undefined, seqDepth: number): void {
  if (isSeq(node)) {
    if (node.items.every((i) => isScalar(i)) || (seqDepth >= 1 && node.items.every(scalarMap))) {
      node.flow = true;
      return;
    }
    for (const item of node.items) styleNode(item as Node, seqDepth + 1);
  } else if (isMap(node)) {
    for (const pair of node.items) {
      // Small flat maps inside list items (e.g. a criterion's threshold) stay on one line.
      if (seqDepth >= 1 && scalarMap(pair.value)) (pair.value as { flow?: boolean }).flow = true;
      else styleNode(pair.value as Node, seqDepth);
    }
  }
}

function toYaml(data: Record<string, unknown>): string {
  const doc = new Document(prune(data));
  styleNode(doc.contents as Node, 0);
  return doc.toString({ lineWidth: 0, flowCollectionPadding: false, indentSeq: true });
}

/* ------------------------------------------------------------------ format */

export interface DocFormat<F, FIn = F> {
  /** Zod schema for the document-level frontmatter (without `sections`). */
  readonly schema: z.ZodType<F, FIn>;
  /** Parse a document; throws DocError listing every problem. */
  parse(md: string): Doc<F>;
  /** Render a document in canonical form; throws DocError if the result would not parse back identically. */
  serialize(doc: { frontmatter: FIn | F; sections: SectionInput[] }): string;
  /** Check a markdown source without throwing. */
  validate(md: string): ValidationResult;
  /**
   * Lenient parse for display (e.g. old versions written under an earlier schema): returns the
   * document whenever its structure is readable, with every problem as `issues` instead of throwing.
   * Frontmatter that fails the schema is kept as-is; sections with an unknown type or a bad fence
   * are dropped. `doc` is absent only when the file has no readable frontmatter.
   */
  inspect(md: string): { doc?: Doc<F>; issues: DocIssue[] };
  /** Section types this format accepts. */
  readonly registry: SectionTypeRegistry;
}

export interface DocFormatOptions {
  /** Section types to accept; defaults to the built-ins (markdown, mermaid, html). */
  registry?: SectionTypeRegistry;
}

function normalizeBody(body: string): string {
  return trimBlankLines(body.replace(/\r\n?/g, '\n').split('\n')).join('\n');
}

/** Create a parser/serializer for documents whose frontmatter matches `schema`. */
export function createDocFormat<S extends z.ZodType<Record<string, unknown>, Record<string, unknown>>>(
  schema: S,
  options: DocFormatOptions = {},
): DocFormat<z.output<S>, z.input<S>> {
  type F = z.output<S>;
  const registry = options.registry ?? createDefaultRegistry();
  const typeList = () => registry.list().map((t) => t.id).join(', ');
  function analyze(md: string): { issues: DocIssue[]; doc?: Doc<F>; partial?: Doc<F> } {
    const { issues, data, blocks } = scan(md);
    if (!data) return { issues };

    const { [RESERVED_KEY]: rawSectionsValue, ...rest } = data;
    const rawSections = rawSectionsValue ?? [];
    const fm = schema.safeParse(rest);
    if (!fm.success) {
      for (const i of fm.error.issues) {
        issues.push({ code: 'frontmatter-invalid', message: `frontmatter.${i.path.join('.') || '(root)'}: ${i.message}` });
      }
    }

    const metas: z.output<typeof sectionMetaSchema>[] = [];
    if (!Array.isArray(rawSections)) {
      issues.push({ code: 'sections-invalid', message: 'frontmatter.sections must be a list' });
    } else {
      rawSections.forEach((raw: unknown, idx) => {
        const id = typeof (raw as { id?: unknown } | null)?.id === 'string' ? (raw as { id: string }).id : undefined;
        const parsed = sectionMetaSchema.safeParse(raw);
        if (!parsed.success) {
          for (const i of parsed.error.issues) {
            issues.push({
              code: 'sections-invalid',
              message: `frontmatter.sections[${idx}].${i.path.join('.')}: ${i.message}`,
              sectionId: id,
            });
          }
        } else metas.push(parsed.data);
      });
    }

    const dupes = (ids: string[]) => ids.filter((id, i) => ids.indexOf(id) !== i);
    for (const id of new Set(dupes(metas.map((m) => m.id)))) {
      issues.push({ code: 'duplicate-id', message: `duplicate section id "${id}" in frontmatter`, sectionId: id });
    }
    for (const id of new Set(dupes(blocks.map((b) => b.id)))) {
      const line = blocks.filter((b) => b.id === id)[1]?.line;
      issues.push({ code: 'duplicate-id', message: `duplicate section marker "${id}"`, sectionId: id, line });
    }

    const metaIds = new Set(metas.map((m) => m.id));
    const blockIds = new Set(blocks.map((b) => b.id));
    for (const b of blocks) {
      if (!metaIds.has(b.id)) {
        issues.push({ code: 'marker-without-metadata', message: `section marker "${b.id}" has no entry in frontmatter.sections`, sectionId: b.id, line: b.line });
      }
    }
    for (const m of metas) {
      if (!blockIds.has(m.id)) {
        issues.push({ code: 'metadata-without-marker', message: `frontmatter section "${m.id}" has no ${markerFor(m.id)} in the body`, sectionId: m.id });
      }
    }
    const common = (ids: string[], keep: Set<string>) => ids.filter((id) => keep.has(id));
    const metaOrder = common(metas.map((m) => m.id), blockIds);
    const blockOrder = common(blocks.map((b) => b.id), metaIds);
    if (metaOrder.join('\n') !== blockOrder.join('\n')) {
      issues.push({ code: 'order-mismatch', message: `section order differs: frontmatter [${metaOrder.join(', ')}] vs body [${blockOrder.join(', ')}]` });
    }

    const sections: Section[] = [];
    for (const b of blocks) {
      const meta = metas.find((m) => m.id === b.id);
      if (!meta) continue;
      if (b.heading === null) {
        issues.push({ code: 'heading-missing', message: `section "${b.id}" must start with "## ${meta.title}"`, sectionId: b.id, line: b.line + 1 });
      } else if (b.heading !== meta.title) {
        issues.push({
          code: 'heading-mismatch',
          message: `section "${b.id}": heading "${b.heading}" does not match title "${meta.title}"`,
          sectionId: b.id,
          line: b.line + 1,
        });
      }
      const def = registry.get(meta.type);
      if (!def) {
        issues.push({ code: 'unknown-type', message: `section "${b.id}": unknown type "${meta.type}" (registered: ${typeList()})`, sectionId: b.id });
        continue;
      }
      let body = b.content;
      if (def.fence && b.content !== '') {
        const r = unwrapFence(b.content, def.fence);
        if ('error' in r) {
          issues.push({
            code: r.error,
            message:
              r.error === 'fence-missing'
                ? `${meta.type} section "${b.id}" must be wrapped in a \`\`\`${def.fence} fence`
                : `${meta.type} section "${b.id}" is fenced as "${r.found}" (expected "${def.fence}")`,
            sectionId: b.id,
            line: b.line,
          });
          continue;
        }
        body = r.body;
      }
      if (body !== '') {
        for (const problem of checkBody(def, body)) {
          issues.push({ code: 'body-invalid', message: `${meta.type} section "${b.id}": ${problem}`, sectionId: b.id, line: b.line });
        }
      }
      // Type-specific frontmatter entry (e.g. `method` for acceptance criteria).
      if (def.metaSchema) {
        const r = def.metaSchema.safeParse(meta);
        if (!r.success) {
          for (const i of r.error.issues) {
            issues.push({ code: 'sections-invalid', message: `${meta.type} section "${b.id}": ${i.path.join('.') || 'entry'}: ${i.message}`, sectionId: b.id });
          }
        }
      }
      sections.push({ ...meta, body });
    }

    // Links: no duplicate (to, rel) on a section.
    for (const sec of sections) {
      const seen = new Set<string>();
      for (const l of sec.links) {
        // Exact duplicates are a format error; one relation per target (contradictory pairs) is a
        // write-time link rule (checkLinks), so existing files stay readable.
        const key = `${l.to} ${l.rel}`;
        if (seen.has(key)) issues.push({ code: 'sections-invalid', message: `section "${sec.id}": duplicate link ${l.rel} ${l.to}`, sectionId: sec.id });
        seen.add(key);
      }
    }

    // verifiedBy must point at acceptance-like sections of the same document.
    const byId = new Map(sections.map((x) => [x.id, x]));
    for (const sec of sections) {
      for (const ref of sec.verifiedBy) {
        const target = byId.get(ref);
        if (!target) {
          issues.push({ code: 'sections-invalid', message: `section "${sec.id}": verifiedBy "${ref}" is not a section of this document`, sectionId: sec.id });
        } else if (!registry.get(target.type)?.verifies) {
          issues.push({ code: 'sections-invalid', message: `section "${sec.id}": verifiedBy "${ref}" is a ${target.type} section, not a criterion`, sectionId: sec.id });
        }
      }
    }

    const partial = { frontmatter: (fm.success ? fm.data : rest) as F, sections: sections.filter((x, i) => sections.findIndex((y) => y.id === x.id) === i) };
    if (issues.length || !fm.success) return { issues, partial };
    return { issues, doc: { frontmatter: fm.data as F, sections }, partial };
  }

  function render(frontmatter: F, sections: Section[]): string {
    const data: Record<string, unknown> = { ...frontmatter };
    delete data[RESERVED_KEY];
    if (sections.length) {
      data[RESERVED_KEY] = sections.map(({ id, title, type, summary, archived, provenance, confidence, refs, symbols, links, verifiedBy, method, threshold, level, rationale, scope, check, examples, implementedCommit, ref, kind, result, hash, findings, itemRechecks, target, status, verifications, codeRefs, deviations }) => ({
        id,
        title,
        type,
        summary,
        archived,
        provenance,
        confidence,
        ref,
        kind,
        level,
        result,
        hash,
        findings,
        itemRechecks,
        target,
        status,
        verifications,
        codeRefs,
        deviations,
        rationale,
        scope,
        check,
        examples,
        method,
        threshold,
        refs,
        symbols,
        links,
        verifiedBy,
        implementedCommit,
      }));
    }
    let out = `---\n${toYaml(data)}---\n`;
    for (const s of sections) {
      out += `\n${markerFor(s.id)}\n## ${s.title}\n`;
      const lang = registry.get(s.type)?.fence;
      if (!lang) {
        if (s.body) out += `\n${s.body}\n`;
      } else {
        const fence = fenceFor(s.body);
        out += `\n${fence}${lang}\n${s.body ? `${s.body}\n` : ''}${fence}\n`;
      }
    }
    return out;
  }

  return {
    schema: schema as unknown as z.ZodType<F, z.input<S>>,
    registry,
    validate(md) {
      const { issues, doc } = analyze(md);
      return { ok: issues.length === 0, issues, warnings: doc ? sectionSummaryWarnings(doc.sections, md) : [] };
    },
    inspect(md) {
      const { issues, partial } = analyze(md);
      return partial ? { doc: partial, issues } : { issues };
    },
    parse(md) {
      const { issues, doc } = analyze(md);
      if (!doc) throw new DocError(issues);
      return doc;
    },
    serialize(input) {
      const fm = schema.safeParse(input.frontmatter);
      const issues: DocIssue[] = [];
      if (!fm.success) {
        for (const i of fm.error.issues) issues.push({ code: 'frontmatter-invalid', message: `frontmatter.${i.path.join('.')}: ${i.message}` });
      }
      const sections: Section[] = [];
      input.sections.forEach((s, idx) => {
        const r = sectionSchema.safeParse(s);
        if (!r.success) {
          for (const i of r.error.issues) issues.push({ code: 'sections-invalid', message: `sections[${idx}].${i.path.join('.')}: ${i.message}`, sectionId: s.id });
        } else if (!registry.has(r.data.type)) {
          issues.push({ code: 'unknown-type', message: `section "${r.data.id}": unknown type "${r.data.type}" (registered: ${typeList()})`, sectionId: r.data.id });
        } else sections.push({ ...r.data, body: normalizeBody(r.data.body) });
      });
      if (issues.length || !fm.success) throw new DocError(issues);

      const md = render(fm.data as F, sections);
      const back = analyze(md);
      if (!back.doc) throw new DocError(back.issues);
      if (JSON.stringify(back.doc.sections) !== JSON.stringify(sections)) {
        const bad = sections.find((s, i) => JSON.stringify(s) !== JSON.stringify(back.doc!.sections[i]));
        throw new DocError([
          {
            code: 'round-trip-mismatch',
            message: `section "${bad?.id ?? '?'}" would not parse back identically (does its body contain a section marker or an unbalanced fence?)`,
            sectionId: bad?.id,
          },
        ]);
      }
      return md;
    },
  };
}

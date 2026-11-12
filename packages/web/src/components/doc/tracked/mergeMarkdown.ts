/**
 * Tracked-changes markdown: align the block trees (mdast) of two versions, then word-diff inside
 * matched blocks so inline formatting of the new version is kept. The result is a single mdast
 * tree whose change marks are custom nodes / classes rendered as <ins>, <del> and change bars.
 */
import { diffText } from '@mandate/doc';
import type { Nodes, Parent, PhrasingContent, Root, RootContent } from 'mdast';
import { toString } from 'mdast-util-to-string';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import { unified } from 'unified';

const processor = unified().use(remarkParse).use(remarkGfm);

export function parseMarkdown(md: string): Root {
  return processor.runSync(processor.parse(md)) as Root;
}

type AnyNode = Nodes & { data?: { hName?: string; hProperties?: Record<string, unknown> }; children?: AnyNode[] };

const text = (node: Nodes) => toString(node, { includeImageAlt: false, includeHtml: false });

function withClass<T extends AnyNode>(node: T, ...classes: string[]): T {
  const props = node.data?.hProperties ?? {};
  const existing = props.className;
  const list = Array.isArray(existing) ? (existing as string[]) : existing ? [String(existing)] : [];
  return { ...node, data: { ...node.data, hProperties: { ...props, className: [...list, ...classes] } } };
}

const custom = (hName: string, className: string[], children: unknown[]) =>
  ({ type: 'tcMark', data: { hName, hProperties: { className } }, children }) as unknown as PhrasingContent;

const insNode = (children: PhrasingContent[]) => custom('ins', ['tc-ins'], children);
const delNode = (value: string) => custom('del', ['tc-del'], [{ type: 'text', value }]);

const INLINE_BLOCKS = new Set(['paragraph', 'heading', 'tableCell']);
const CONTAINERS = new Set(['list', 'listItem', 'blockquote', 'table', 'tableRow']);

/** Word diff inside an inline block, rebuilding the new version's leaves with <ins>/<del> marks. */
function mergeInline(before: Parent, after: Parent): AnyNode {
  const bt = text(before as Nodes);
  const at = text(after as Nodes);
  const inserted = new Uint8Array(at.length);
  const dels = new Map<number, string>();
  let pos = 0;
  for (const op of diffText(bt, at, 'words')) {
    if (op.op === 'equal') pos += op.text.length;
    else if (op.op === 'insert') {
      inserted.fill(1, pos, pos + op.text.length);
      pos += op.text.length;
    } else dels.set(pos, (dels.get(pos) ?? '') + op.text);
  }

  let offset = 0;
  const takeDel = (at: number, out: PhrasingContent[]) => {
    const d = dels.get(at);
    if (d !== undefined) {
      out.push(delNode(d));
      dels.delete(at);
    }
  };
  const rebuild = (nodes: PhrasingContent[]): PhrasingContent[] => {
    const out: PhrasingContent[] = [];
    for (const node of nodes) {
      if (node.type === 'text' || node.type === 'inlineCode') {
        const value = node.value;
        let segStart = 0;
        const flush = (end: number) => {
          if (end <= segStart) return;
          const seg = { ...node, value: value.slice(segStart, end) } as PhrasingContent;
          out.push(inserted[offset + segStart] ? insNode([seg]) : seg);
          segStart = end;
        };
        for (let i = 0; i < value.length; i++) {
          if (dels.has(offset + i)) {
            flush(i);
            takeDel(offset + i, out);
          }
          if (i > segStart && inserted[offset + i] !== inserted[offset + i - 1]) flush(i);
        }
        flush(value.length);
        offset += value.length;
      } else if ('children' in node && Array.isArray(node.children)) {
        out.push({ ...node, children: rebuild(node.children as PhrasingContent[]) } as PhrasingContent);
      } else out.push(node);
    }
    return out;
  };
  const children = rebuild((after.children ?? []) as PhrasingContent[]);
  for (const [at] of [...dels]) takeDel(at, children);
  return withClass({ ...(after as AnyNode), children } as AnyNode, 'tc-block', 'tc-mod', 'tc-mark');
}

/** Line diff for code blocks, rendered as <pre> with per-line marks. */
function mergeCode(before: AnyNode & { value: string }, after: AnyNode & { value: string; lang?: string | null }): AnyNode {
  const lines: unknown[] = [];
  for (const op of diffText(before.value, after.value, 'lines')) {
    for (const line of op.text.replace(/\n$/, '').split('\n')) {
      lines.push({
        type: 'tcMark',
        data: { hName: 'span', hProperties: { className: ['tc-line', `tc-line-${op.op}`] } },
        children: [{ type: 'text', value: `${line}\n` }],
      });
    }
  }
  return {
    type: 'tcMark',
    data: { hName: 'pre', hProperties: { className: ['tc-code', 'tc-block', 'tc-mod', 'tc-mark'] } },
    children: [{ type: 'tcMark', data: { hName: 'code', hProperties: { className: after.lang ? [`language-${after.lang}`] : [] } }, children: lines }],
  } as unknown as AnyNode;
}

const added = (n: AnyNode) => withClass(n, 'tc-block', 'tc-added', 'tc-mark');
const removed = (n: AnyNode) => withClass(n, 'tc-block', 'tc-removed', 'tc-mark');
const key = (n: AnyNode) => `${n.type}\u0000${'checked' in n ? String(n.checked) : ''}\u0000${'lang' in n ? String(n.lang) : ''}\u0000${'value' in n ? String(n.value) : text(n as Nodes)}\u0000${'depth' in n ? n.depth : ''}`;

/** LCS alignment of two node lists by content key. */
function align(bs: AnyNode[], as: AnyNode[]) {
  const dp = Array.from({ length: bs.length + 1 }, () => new Array<number>(as.length + 1).fill(0));
  const kb = bs.map(key);
  const ka = as.map(key);
  for (let i = bs.length - 1; i >= 0; i--)
    for (let j = as.length - 1; j >= 0; j--) dp[i]![j] = kb[i] === ka[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
  const ops: ({ op: 'eq'; a: AnyNode } | { op: 'del'; b: AnyNode } | { op: 'ins'; a: AnyNode })[] = [];
  let i = 0;
  let j = 0;
  while (i < bs.length || j < as.length) {
    if (i < bs.length && j < as.length && kb[i] === ka[j]) {
      ops.push({ op: 'eq', a: as[j]! });
      i++;
      j++;
    } else if (j < as.length && (i >= bs.length || dp[i]![j + 1]! >= dp[i + 1]![j]!)) ops.push({ op: 'ins', a: as[j++]! });
    else ops.push({ op: 'del', b: bs[i++]! });
  }
  return ops;
}

function mergeNode(b: AnyNode, a: AnyNode): AnyNode | null {
  if (b.type !== a.type) return null;
  if (INLINE_BLOCKS.has(a.type) && (a.type !== 'heading' || (a as { depth: number }).depth === (b as { depth: number }).depth))
    return mergeInline(b as Parent, a as Parent);
  if (a.type === 'code') return mergeCode(b as AnyNode & { value: string }, a as AnyNode & { value: string });
  if (CONTAINERS.has(a.type) && a.children && b.children) {
    const merged = { ...a, children: mergeChildren(b.children, a.children) } as AnyNode;
    // A task list item that only changed its checkbox.
    if (a.type === 'listItem' && (a as { checked?: boolean | null }).checked !== (b as { checked?: boolean | null }).checked)
      return withClass(merged, 'tc-block', 'tc-mod', 'tc-mark', 'tc-checked-changed');
    return merged;
  }
  return null;
}

/** Merge two child lists: unchanged kept, changed pairs merged, the rest marked added / removed in place. */
export function mergeChildren(bs: AnyNode[], as: AnyNode[]): AnyNode[] {
  const out: AnyNode[] = [];
  const ops = align(bs, as);
  for (let k = 0; k < ops.length; ) {
    const op = ops[k]!;
    if (op.op === 'eq') {
      out.push(op.a);
      k++;
      continue;
    }
    // A run of deletions / insertions between unchanged nodes: pair same-typed nodes in order.
    const dels: AnyNode[] = [];
    const inss: AnyNode[] = [];
    while (k < ops.length && ops[k]!.op !== 'eq') {
      const o = ops[k++]!;
      if (o.op === 'del') dels.push(o.b);
      else if (o.op === 'ins') inss.push(o.a);
    }
    const used = new Set<number>();
    const pairs = new Map<number, AnyNode>();
    inss.forEach((a, ai) => {
      const bi = dels.findIndex((b, x) => !used.has(x) && b.type === a.type);
      if (bi >= 0) {
        const merged = mergeNode(dels[bi]!, a);
        if (merged) {
          used.add(bi);
          pairs.set(ai, merged);
        }
      }
    });
    dels.forEach((b, x) => !used.has(x) && out.push(removed(b)));
    inss.forEach((a, ai) => out.push(pairs.get(ai) ?? added(a)));
  }
  return out;
}

/** Tracked-changes tree for a markdown body. */
export function mergeMarkdown(before: string, after: string): Root {
  const b = parseMarkdown(before);
  const a = parseMarkdown(after);
  return { ...a, children: mergeChildren(b.children as AnyNode[], a.children as AnyNode[]) as RootContent[] };
}

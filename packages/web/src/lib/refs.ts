import type { WorkOrder, ResolvedWorkOrder, Section } from '@mandate/shared';
import { buildCodeRef, buildCommitRef, buildQuestionRef, buildRef, buildSymbolRef, mentionOf, refMention, type MandateRef } from '@mandate/shared/refs';
import { sectionHref } from './links';
import { api } from '../api';
import { feedbackMarkdown } from './feedback';
import type { Feedback } from '@mandate/shared';
import { appOrigin } from '../project';

/** Something that can be copied as a reference, as markdown and as a link. */
export interface CopyTarget {
  /** What it is, for menus and aria labels ("section", "spec"...). */
  label: string;
  /** `@mandate:` mention(s). */
  ref: string;
  /** Content as markdown (may be fetched lazily). */
  markdown?: () => string | Promise<string>;
  /** UI URL. */
  link?: string;
  /** Second option: the latest (unversioned) reference when viewing an old version, or a pinned one otherwise. */
  alt?: { label: string; ref: string };
  /** Raw values offered after the reference (e.g. "Copy path", "Copy hash"). */
  extras?: { label: string; value: () => string | Promise<string> }[];
}

const M = mentionOf;

/** Code reference chip (versioned when the ref carries a commit). */
export function codeTarget(r: { repo: string; path: string; lines?: string; commit?: string }): CopyTarget {
  return { label: 'code reference', ref: M(buildCodeRef(r)), extras: [{ label: 'Copy path', value: () => codeRefText(r) }] };
}

/** Symbol chip reference. */
export function symbolTarget(name: string): CopyTarget {
  return { label: 'symbol', ref: M(buildSymbolRef(name)), extras: [{ label: 'Copy symbol name', value: () => name }] };
}

/** Commit hash reference. */
export function commitTarget(sha: string): CopyTarget {
  return { label: 'commit', ref: M(buildCommitRef(sha)), extras: [{ label: 'Copy hash', value: () => sha }] };
}

/** A question a coding agent asked through Mandate. */
export function questionTarget(id: string): CopyTarget {
  return { label: 'question', ref: M(buildQuestionRef(id)), link: `${origin()}/questions/${id}` };
}

/** Any section / doc URI (link and standard chips). */
export function uriTarget(uri: string, label = 'section'): CopyTarget {
  return { label, ref: M(uri), link: `${origin()}${sectionHref(uri)}` };
}

export type DocKind = 'specs' | 'standards' | 'components' | 'audits' | 'work-orders';

/** Absolute links point into the current project (`/p/<id>/...`). */
const origin = appOrigin;

/** Alternate reference: latest when `commit` is set, else pinned to `head` (when known). */
function altRef(r: MandateRef, commit?: string, head?: string): CopyTarget['alt'] {
  if (commit) return { label: 'Copy reference to latest', ref: refMention({ ...r, commit: undefined }) };
  if (head) return { label: 'Copy pinned reference (this version)', ref: refMention({ ...r, commit: head }) };
  return undefined;
}

export function docTarget(kind: DocKind | 'work-orders' | 'feedback', id: string, commit?: string, head?: string): CopyTarget {
  if (kind === 'work-orders') return workOrderTarget(id);
  if (kind === 'feedback') return { label: 'request', ref: refMention({ kind: 'feedback', id }), link: `${origin()}/requests/${id}` };
  return {
    label: kind === 'specs' ? 'spec' : kind === 'standards' ? 'standard' : kind === 'audits' ? 'audit' : 'component',
    ref: refMention({ kind, id, commit }),
    alt: altRef({ kind, id }, commit, head),
    markdown: async () => (await api.raw(kind, id)) ?? '',
    link: `${origin()}/${kind}/${id}${commit ? `?version=${commit}` : ''}`,
  };
}

const FENCED = new Set(['mermaid', 'html']);

/** A section as markdown: heading, body (fenced for code-like types) and a metadata line. */
export function sectionMarkdown(kind: DocKind, docId: string, section: Section): string {
  const links = (section.links ?? []).map((l) => `- ${l.rel.replace('_', ' ')} ${M(l.to)}${l.note ? ` — ${l.note}` : ''}`);
  const uri = buildRef({ kind, id: docId, sectionId: section.id });
  const body = FENCED.has(section.type) ? `\`\`\`${section.type}\n${section.body}\n\`\`\`` : section.body;
  const meta = [
    uri,
    section.archived ? 'archived' : '',
    section.refs.length ? `refs: ${section.refs.map(codeRefText).join(', ')}` : '',
    section.symbols.length ? `symbols: ${section.symbols.join(', ')}` : '',
  ].filter(Boolean);
  return `## ${section.title}\n\n${body}\n\n${links.length ? `Links:\n${links.join('\n')}\n\n` : ''}_${meta.join(' · ')}_\n`;
}

export function sectionTarget(kind: DocKind, docId: string, section: Section, commit?: string, head?: string): CopyTarget {
  return {
    label: 'section',
    ref: refMention({ kind, id: docId, sectionId: section.id, commit }),
    alt: altRef({ kind, id: docId, sectionId: section.id }, commit, head),
    markdown: () => sectionMarkdown(kind, docId, section),
    link: `${origin()}/${kind}/${docId}${commit ? `?version=${commit}` : ''}#section-${section.id}`,
  };
}

/** Agent-ready brief for a work order: spec, note and every targeted section with its reference and content. */
export function workOrderBrief(r: ResolvedWorkOrder): string {
  const { item, spec } = r;
  const pin = item.specCommit;
  const lines = [
    `# ${item.kind}: ${spec?.title ?? item.spec} (${item.id})`,
    '',
    `${refMention({ kind: 'work-orders', id: item.id })} · spec ${refMention({ kind: 'specs', id: item.spec, commit: pin })} · status ${item.status}`,
  ];
  if (item.note) lines.push('', `> ${item.note}`);
  for (const s of r.sections) {
    lines.push('', `## ${s.section?.title ?? s.id} (${s.status})`, refMention({ kind: 'specs', id: item.spec, sectionId: s.id, commit: pin }), '');
    if (s.section) lines.push(FENCED.has(s.section.type) ? `\`\`\`${s.section.type}\n${s.section.body}\n\`\`\`` : s.section.body);
  }
  return `${lines.join('\n')}\n`;
}

export function workOrderTarget(item: WorkOrder | string): CopyTarget {
  const id = typeof item === 'string' ? item : item.id;
  return {
    label: 'work order',
    ref: refMention({ kind: 'work-orders', id }),
    markdown: async () => workOrderBrief(await api.workOrder(id)),
    link: `${origin()}/work-orders/${id}`,
  };
}

export function codeRefText(r: { repo: string; path: string; lines?: string }): string {
  return `${r.repo}/${r.path}${r.lines ? `:${r.lines}` : ''}`;
}

export function mention(ref: MandateRef): string {
  return refMention(ref);
}

export function feedbackTarget(f: Feedback): CopyTarget {
  return {
    label: 'request',
    ref: refMention({ kind: 'feedback', id: f.id }),
    markdown: () => feedbackMarkdown(f),
    link: `${origin()}/requests/${f.id}`,
  };
}

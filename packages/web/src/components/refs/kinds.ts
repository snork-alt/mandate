import { IconBraces, IconBox, IconClipboardList, IconCode, IconFileText, IconGitBranch, IconGitCommit, IconHash, IconHistory, IconMessageReport, IconQuote, IconRobot, IconRuler2, IconShieldCheck, IconSitemap } from '@tabler/icons-react';
import { nodeKindOf, parseNodeUri, refLabel, type NodeKind } from '@mandate/shared';
import { sectionHref } from '../../lib/links';

export const KIND_ICON: Record<NodeKind, typeof IconHash> = {
  spec: IconFileText,
  standard: IconRuler2,
  section: IconHash,
  version: IconHistory,
  excerpt: IconQuote,
  work_order: IconClipboardList,
  feedback: IconMessageReport,
  symbol: IconBraces,
  code_file: IconCode,
  code_range: IconCode,
  repo: IconBox,
  commit: IconGitCommit,
  agent: IconRobot,
  branch: IconGitBranch,
  verification: IconShieldCheck,
  component: IconBox,
  architecture: IconSitemap,
};

/** Node kind of a reference, null when it is not a valid reference. */
export function refKind(uri: string): NodeKind | null {
  const r = parseNodeUri(uri);
  return r ? nodeKindOf(r) : null;
}

/** Readable label from the reference alone (before / without resolving it). */
export function fallbackLabel(uri: string): string {
  const r = parseNodeUri(uri);
  if (!r) return refLabel(uri);
  switch (r.kind) {
    case 'specs':
    case 'standards':
    case 'components':
      return r.sectionId ? `${r.id} › ${r.sectionId}${r.commit ? ` @${r.commit.slice(0, 7)}` : ''}` : `${r.id}${r.commit ? ` @${r.commit.slice(0, 7)}` : ''}`;
    case 'work-orders':
    case 'feedback':
      return r.id;
    case 'symbols':
    case 'repos':
    case 'agents':
    case 'branches':
      return r.name;
    case 'code':
      return `${r.path.split('/').pop()}${r.lines ? `:${r.lines.start}-${r.lines.end}` : ''}`;
    case 'commits':
      return r.sha.slice(0, 7);
    case 'verifications':
      return r.id;
    case 'architecture':
      return r.focus ? `architecture › ${r.focus}` : 'architecture';
  }
}

/** UI route of a reference (docs, sections, versions, excerpts); null for nodes without a page (symbols, code, agents...). */
export function refHref(uri: string): string | null {
  const r = parseNodeUri(uri);
  if (!r) return null;
  if (r.kind === 'specs' || r.kind === 'standards' || r.kind === 'components' || r.kind === 'work-orders' || r.kind === 'feedback') return sectionHref(uri);
  return null;
}

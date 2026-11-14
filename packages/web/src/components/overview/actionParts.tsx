/** Small pieces shared by the Actions tabs (Feedback, Blocked, Must findings). */
import { useMemo } from 'react';
import { Link } from 'react-router';
import { IconChevronRight } from '@tabler/icons-react';
import { parseRef } from '@mandate/shared/refs';
import { useSpecs, useStandards } from '../../lib/queries';
import { fallbackLabel, refHref, refKind } from '../refs/kinds';
import { KindIcon } from '../refs/KindIcon';

export interface DocEntry {
  title: string;
  sections: Map<string, string>;
}

/** Spec and standard titles with their section titles (from the cached lists), keyed by `specs/<id>` / `standards/<id>`. */
export function useDocIndex(): Map<string, DocEntry> {
  const specs = useSpecs();
  const standards = useStandards();
  return useMemo(() => {
    const out = new Map<string, DocEntry>();
    const add = (kind: string, list: unknown) => {
      if (!Array.isArray(list)) return;
      for (const d of list as { id: string; title: string; sections?: { id: string; title: string }[] }[])
        out.set(`${kind}/${d.id}`, { title: d.title, sections: new Map((d.sections ?? []).map((s) => [s.id, s.title])) });
    };
    add('specs', specs.data);
    add('standards', standards.data);
    return out;
  }, [specs.data, standards.data]);
}

/** "Spec › Section" of a reference, from the doc index (falls back to the ids). */
export function locOf(uri: string, docs: Map<string, DocEntry>): { doc: string; section?: string } {
  const r = parseRef(uri);
  if (!r || (r.kind !== 'specs' && r.kind !== 'standards')) return { doc: fallbackLabel(uri) };
  const d = docs.get(`${r.kind}/${r.id}`);
  const section = r.sectionId ? (d?.sections.get(r.sectionId) ?? r.sectionId) : undefined;
  return { doc: d?.title ?? r.id, ...(section ? { section } : {}) };
}

/** A "Spec › Section" chip linking to the section. */
export function LocChip({ uri, docs }: { uri: string; docs: Map<string, DocEntry> }) {
  const { doc, section } = locOf(uri, docs);
  const kind = refKind(uri);
  const docKind = uri.includes('://standards/') ? 'standard' : 'spec';
  return (
    <Link to={refHref(uri) ?? '#'} className="act-loc" data-testid="act-loc" title={section ? `${doc} › ${section}` : doc}>
      <KindIcon kind={kind === 'section' || !kind ? docKind : kind} size={12} />
      <span className={section ? 'act-loc-doc' : undefined}>{doc}</span>
      {section && (
        <>
          <IconChevronRight size={11} className="act-loc-sep" aria-hidden />
          <span className="act-loc-sec">{section}</span>
        </>
      )}
    </Link>
  );
}

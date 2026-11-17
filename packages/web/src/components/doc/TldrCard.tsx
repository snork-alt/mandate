import { Markdown } from '../Markdown';
import { TrackedValue, useFieldChange } from './tracked';

/** "TL;DR": the plain-language overview of a spec, standard or component, above its summary and sections. */
export function TldrCard({ tldr }: { tldr?: string | null }) {
  const change = useFieldChange('tldr');
  if (!tldr && !change) return null;
  return (
    <aside className="doc-tldr" aria-label="TL;DR">
      <div className="doc-tldr-label">TL;DR</div>
      <div className="doc-tldr-body">
        <TrackedValue field="tldr" value={tldr ?? ''} render={(v) => <Markdown>{v}</Markdown>} />
      </div>
    </aside>
  );
}

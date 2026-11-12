import { useQuery } from '@tanstack/react-query';
import { IconGitCommit } from '@tabler/icons-react';
import { Skeleton } from '@mantine/core';
import type { Section } from '@mandate/shared';
import { api } from '../../api';
import { SectionBlock } from '../doc';
import { TrackedSection } from '../doc/tracked';
import { sectionTarget } from '../../lib/refs';

/** For `update` items: Word-style changes of a section from its implementedCommit to the item's specCommit. */
export function UpdateDiff({ spec, specCommit, section, badge, standardTitles }: { spec: string; specCommit: string; section: Section; badge: React.ReactNode; standardTitles: Map<string, string> }) {
  const base = section.implementedCommit;
  const types = useQuery({ queryKey: ['section-types'], queryFn: api.sectionTypes, staleTime: Infinity });
  const tracked = useQuery({
    queryKey: ['specs', spec, 'tracked-base', specCommit, base],
    enabled: !!base && !!types.data,
    staleTime: Infinity,
    queryFn: async () => {
      const version = await api.version('specs', spec, specCommit, 'parent', base);
      return (await import('../doc/tracked/compute')).computeTracked('specs', version, types.data!);
    },
  });
  const plain = <SectionBlock section={section} standardTitles={standardTitles} badge={badge} target={sectionTarget('specs', spec, section, specCommit)} />;
  if (!base) return plain;
  if (tracked.isPending) return <Skeleton height={160} radius="md" my="md" />;
  const diff = tracked.data?.diff.sections.find((s) => s.id === section.id);
  // Only text changes matter for an update (implementedCommit metadata always differs).
  if (!diff || diff.status === 'unchanged' || (!diff.body && !diff.title && diff.status === 'modified')) return plain;
  return (
    <div>
      <div className="q-update-note">
        <IconGitCommit size={13} /> Changes since implemented at <span className="mono">{base}</span> {badge}
      </div>
      <TrackedSection diff={diff} tree={tracked.data?.trees.get(section.id)} standardTitles={standardTitles} target={sectionTarget('specs', spec, section, specCommit)} />
    </div>
  );
}


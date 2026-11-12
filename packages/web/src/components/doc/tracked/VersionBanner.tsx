import { Link } from 'react-router';
import { useEffect, useState } from 'react';
import { ActionIcon, Menu, Modal, SegmentedControl, Tooltip, UnstyledButton } from '@mantine/core';
import { IconArrowDown, IconArrowUp, IconDots, IconFileDiff, IconGitBranch, IconRobot, IconUser, IconX } from '@tabler/icons-react';
import { CodeBlock } from '../../CodeBlock';
import { CommitHash } from '../../copy';
import { unifiedDiff } from '../diff/unified';
import { shortSubject } from '../../../lib/specs';
import { absoluteTime, relativeTime } from '../../../lib/time';
import type { TrackedState } from './useTrackedChanges';

/** Scroll to the next / previous change mark below / above the banner. */
function jump(dir: 1 | -1) {
  const marks = Array.from(document.querySelectorAll<HTMLElement>('.doc-main .tc-mark')).filter((el) => !el.parentElement?.closest('.tc-mark'));
  const offset = 140;
  const tops = marks.map((m) => m.getBoundingClientRect().top - offset);
  const target = dir === 1 ? marks[tops.findIndex((t) => t > 4)] : marks[tops.findLastIndex((t) => t < -4)];
  if (!target) return;
  target.scrollIntoView({ behavior: 'smooth', block: 'center' });
  target.classList.add('tc-flash');
  setTimeout(() => target.classList.remove('tc-flash'), 900);
}

function RawDiff({ before, after, path }: { before: string; after: string; path: string }) {
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    void unifiedDiff(before, after, path).then(setText);
  }, [before, after, path]);
  return text === null ? null : <CodeBlock code={text} lang="diff" lineNumbers={false} />;
}

/** Slim sticky banner for tracked-changes mode. */
export function VersionBanner({ tracked, missing }: { tracked: TrackedState; /** Section id (from the URL) missing at HEAD. */ missing?: string }) {
  const [raw, setRaw] = useState(false);
  const v = tracked.version;
  const m = v?.meta;
  const d = tracked.data?.diff;
  const metaOnly = !!d && d.status !== 'unchanged' && d.sections.every((s) => s.status === 'unchanged' && !s.moved);
  if (tracked.view === 'version' && !tracked.error) {
    // A pinned reference: the document as it was, read-only.
    return (
      <div className="version-banner" role="region" aria-label="Viewing a version">
        <div className="version-banner-info">
          <span className="version-banner-label">Viewing version</span>
          {v?.commit && <CommitHash sha={v.commit} className="version-banner-commit" />}
          {m && (
            <Tooltip label={absoluteTime(m.date)}>
              <span>{relativeTime(m.date)}</span>
            </Tooltip>
          )}
          {missing && <span className="version-banner-missing">Section “{missing}” no longer exists in the latest version</span>}
        </div>
        <div className="version-banner-actions">
          <UnstyledButton className="tc-toggle" onClick={() => tracked.setView('changes')}>
            Show changes
          </UnstyledButton>
          <UnstyledButton className="tc-toggle" onClick={tracked.exit}>
            View latest
          </UnstyledButton>
        </div>
      </div>
    );
  }
  return (
    <div className="version-banner" role="region" aria-label="Viewing changes" data-error={tracked.error ? true : undefined}>
      <div className="version-banner-info">
        {tracked.error ? (
          <span className="version-banner-label">Version not found — it may have been rewritten</span>
        ) : (
          <span className="version-banner-label">{metaOnly ? 'No content changes in this version — metadata only' : 'Viewing changes in'}</span>
        )}
        {v?.commit ? <CommitHash sha={v.commit} className="version-banner-commit" /> : <span className="mono version-banner-commit">{(tracked.commit ?? '').slice(0, 7)}</span>}
        {m && (
          <>
            <span className="inline-icon">
              {m.agent ? <IconRobot size={13} /> : <IconUser size={13} />}
              {m.agent ?? m.author}
            </span>
            {m.branch && (
              <span className="inline-icon mono">
                <IconGitBranch size={13} />
                {m.branch}
              </span>
            )}
            <Tooltip label={absoluteTime(m.date)}>
              <span>{relativeTime(m.date)}</span>
            </Tooltip>
            <span className="version-banner-subject">“{shortSubject(m.subject)}”</span>
            {m.trailers.Feedback && (
              <Link to={`/feedback/${m.trailers.Feedback}`} className="fb-target">
                applies {m.trailers.Feedback}
              </Link>
            )}
          </>
        )}
      </div>
      <div className="version-banner-actions">
        <SegmentedControl
          size="xs"
          value={tracked.compare}
          onChange={(c) => tracked.setCompare(c as 'prev' | 'current')}
          data={[
            { value: 'prev', label: 'vs previous' },
            { value: 'current', label: 'vs current' },
          ]}
        />
        <Tooltip label="Previous change">
          <ActionIcon onClick={() => jump(-1)} aria-label="Previous change">
            <IconArrowUp size={15} />
          </ActionIcon>
        </Tooltip>
        <Tooltip label="Next change">
          <ActionIcon onClick={() => jump(1)} aria-label="Next change">
            <IconArrowDown size={15} />
          </ActionIcon>
        </Tooltip>
        <Menu position="bottom-end">
          <Menu.Target>
            <ActionIcon aria-label="More">
              <IconDots size={15} />
            </ActionIcon>
          </Menu.Target>
          <Menu.Dropdown>
            <Menu.Item leftSection={<IconFileDiff size={14} />} onClick={() => setRaw(true)} disabled={!v}>
              View raw diff
            </Menu.Item>
          </Menu.Dropdown>
        </Menu>
        <Tooltip label="Exit (Esc)">
          <ActionIcon onClick={tracked.exit} aria-label="Exit changes view">
            <IconX size={15} />
          </ActionIcon>
        </Tooltip>
      </div>
      <Modal opened={raw} onClose={() => setRaw(false)} size="xl" title={`Raw diff · ${v?.path ?? ''}`}>
        {v && raw && <RawDiff before={v.before ?? ''} after={v.after ?? ''} path={v.path} />}
      </Modal>
    </div>
  );
}

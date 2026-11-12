import { IconExternalLink, IconGitBranch, IconGitPullRequest } from '@tabler/icons-react';
import type { WorkProgress } from '@mandate/shared';
import './lineage.css';

/** "#42" link out to the pull request (plain text without a URL). */
export function PrLink({ pr }: { pr: WorkProgress['prs'][number] }) {
  const body = (
    <>
      <IconGitPullRequest size={12} />
      {pr.repo ? `${pr.repo}#${pr.number}` : `#${pr.number}`}
      {pr.status && <span className="wp-pr-status">{pr.status}</span>}
    </>
  );
  return pr.url ? (
    <a className="wp-pr" href={pr.url} target="_blank" rel="noreferrer noopener" onClick={(e) => e.stopPropagation()} data-testid="pr-link">
      {body}
      <IconExternalLink size={11} />
    </a>
  ) : (
    <span className="wp-pr">{body}</span>
  );
}

/** Work-order progress: sections done / total (with a small bar), claim, branch and pull requests. */
export function WorkProgressLine({ work, compact }: { work: WorkProgress; compact?: boolean }) {
  const pct = work.sectionsTotal ? Math.round((work.sectionsDone / work.sectionsTotal) * 100) : 0;
  return (
    <span className="wp-line" data-compact={compact || undefined} data-testid="work-progress">
      <span className="wp-sections">
        <span className="wp-bar" aria-hidden>
          <span style={{ width: `${pct}%` }} />
        </span>
        {work.sectionsDone}/{work.sectionsTotal} sections
      </span>
      {work.claimedBy && <span className="wp-claim">{work.claimedBy}</span>}
      {!compact && work.branch && (
        <span className="wp-branch">
          <IconGitBranch size={12} />
          {work.branch}
        </span>
      )}
      {work.prs.map((p) => (
        <PrLink key={`${p.repo}#${p.number}`} pr={p} />
      ))}
    </span>
  );
}

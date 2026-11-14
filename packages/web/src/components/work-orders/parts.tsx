import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';
import { Tooltip } from '@mantine/core';
import { IconAlertOctagon, IconChevronRight, IconExternalLink, IconFolder, IconGitBranch, IconGitMerge, IconGitPullRequest, IconGitPullRequestClosed, IconGitPullRequestDraft, IconMessage, IconServer } from '@tabler/icons-react';
import type { WorkOrder, CommentThread, CommentView, GitContext, PastClaim, PullRequest, ResolvedWorkOrder, TouchedFile } from '@mandate/shared';
import { buildNodeUri, mentionOf } from '@mandate/shared/refs';
import { Markdown } from '../Markdown';
import { KindIcon } from '../refs/KindIcon';
import { TimeAgo } from '../TimeAgo';
import { CommitHash, CopyRef, copyTargetProps } from '../copy';
import { CodeRefChip } from '../doc';
import { appOrigin } from '../../project';
import { initials } from '../../lib/specs';
import type { CopyTarget } from '../../lib/refs';
import { plural } from '../../lib/audits';
import { useShowUsers } from '../../lib/attribution';
import { UserAvatar } from '../people/People';
import './wo.css';

/** The resolved work order and all its comment threads (incl. resolved), for the section renderer and panels. */
export interface WorkOrderView {
  id: string;
  resolved: ResolvedWorkOrder;
  threads: CommentThread[];
}
export const WorkOrderViewContext = createContext<WorkOrderView | null>(null);
export const useWorkOrderView = () => useContext(WorkOrderViewContext);

/* ---------------------------------------------------------------- comments */

export const commentUri = (id: string) => buildNodeUri({ kind: 'comments', id });

export function commentTarget(c: CommentView, workOrderId: string): CopyTarget {
  const uri = commentUri(c.id);
  const section = c.target.split('/sections/')[1];
  return {
    label: 'comment',
    ref: mentionOf(uri),
    markdown: () => `> ${c.body.replace(/\n/g, '\n> ')}\n\n${c.author.agent}${c.author.user ? ` (${c.author.user})` : ''} · ${mentionOf(uri)}\n`,
    link: `${appOrigin()}/work-orders/${workOrderId}${section ? `#section-${section}` : ''}`,
    extras: [{ label: 'Copy comment id', value: () => c.id }],
  };
}

export function Avatar({ author, size = 22 }: { author: { agent: string; user?: string }; size?: number }) {
  const showUsers = useShowUsers();
  const who = author.user ?? author.agent;
  // Team: the shared user avatar (hover card with "via <agent>").
  if (showUsers && author.user) return <UserAvatar user={author.user} size={size} agent={author.agent} />;
  return (
    <Tooltip label={author.user ? `${author.agent} acting as ${author.user}` : author.agent}>
      <span className="wo-avatar" style={{ width: size, height: size }} data-user={author.user ? true : undefined} aria-label={who}>
        {initials(who)}
      </span>
    </Tooltip>
  );
}

function CommentBody({ c, workOrderId, reply, anchor }: { c: CommentView; workOrderId: string; reply?: boolean; anchor?: boolean }) {
  const target = commentTarget(c, workOrderId);
  return (
    <div className="wo-comment has-copy-ref" data-reply={reply || undefined} id={anchor ? `comment-${c.id}` : undefined} {...copyTargetProps(target)}>
      <Avatar author={c.author} size={reply ? 18 : 22} />
      <div className="wo-comment-main">
        <div className="wo-comment-head">
          <span className="wo-comment-author">{c.author.agent}</span>
          {c.author.user && <span className="faint small">as {c.author.user}</span>}
          <span className="faint small">
            <TimeAgo iso={c.createdAt} />
          </span>
          {c.blocking && (
            <Tooltip label="Blocks completion until resolved" openDelay={300}>
              <span className="wo-blocking">
                <IconAlertOctagon size={12} /> Blocking
              </span>
            </Tooltip>
          )}
          <span className="wo-comment-copy">
            <CopyRef target={target} size="xs" />
          </span>
        </div>
        <div className="wo-comment-body">
          <Markdown>{c.body}</Markdown>
        </div>
      </div>
    </div>
  );
}

/** A thread: root, replies, resolution; resolved threads start collapsed. */
export function CommentThreadCard({ t, workOrderId, showTarget, anchor }: { t: CommentThread; workOrderId: string; showTarget?: boolean; anchor?: boolean }) {
  const [open, setOpen] = useState(t.status === 'open' || (anchor && typeof window !== 'undefined' && window.location.hash.includes(t.id)));
  const section = t.target.split('/sections/')[1];
  return (
    <div className="wo-thread" data-status={t.status} data-blocking={(t.blocking && t.status === 'open') || undefined}>
      {t.status === 'resolved' && (
        <button type="button" className="wo-thread-toggle" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          <IconChevronRight size={12} style={{ transform: open ? 'rotate(90deg)' : undefined }} />
          Resolved{t.resolvedBy ? ` by ${t.resolvedBy}` : ''}
          {t.resolvedAt && (
            <span className="faint">
              {' '}
              · <TimeAgo iso={t.resolvedAt} />
            </span>
          )}
          {!open && <span className="wo-thread-peek">{t.body.split('\n')[0]}</span>}
        </button>
      )}
      {open && (
        <>
          {showTarget && section && (
            <a href={`#section-${section}`} className="wo-thread-target small">
              § {section}
            </a>
          )}
          <CommentBody c={t} workOrderId={workOrderId} anchor={anchor} />
          {t.replies.map((r) => (
            <CommentBody key={r.id} c={r} workOrderId={workOrderId} reply anchor={anchor} />
          ))}
          {t.status === 'resolved' && t.resolveNote && <div className="wo-resolve-note small">Resolved: {t.resolveNote}</div>}
        </>
      )}
    </div>
  );
}

/** Open threads first (blocking first), then resolved ones (collapsed). */
export function sortThreads(threads: CommentThread[]) {
  const rank = (t: CommentThread) => (t.status === 'open' ? (t.blocking ? 0 : 1) : 2);
  return [...threads].sort((a, b) => rank(a) - rank(b) || a.createdAt.localeCompare(b.createdAt));
}

export function CommentList({ threads, workOrderId, showTarget, empty, anchor }: { threads: CommentThread[]; workOrderId: string; showTarget?: boolean; empty?: ReactNode; /** Give these threads the `#comment-<id>` anchors (each thread is anchored in one place only). */ anchor?: (t: CommentThread) => boolean }) {
  if (!threads.length) return <>{empty ?? null}</>;
  return (
    <div className="wo-threads">
      {sortThreads(threads).map((t) => (
        <CommentThreadCard key={t.id} t={t} workOrderId={workOrderId} showTarget={showTarget} anchor={anchor?.(t)} />
      ))}
    </div>
  );
}

/** Count badge for a section header: open threads (red when one blocks). */
export function CommentCount({ threads }: { threads: CommentThread[] }) {
  const open = threads.filter((t) => t.status === 'open');
  if (!threads.length) return null;
  const blocking = open.some((t) => t.blocking);
  return (
    <Tooltip label={`${plural(open.length, 'open thread')}${blocking ? ' (blocking)' : ''}, ${threads.length - open.length} resolved`} openDelay={300}>
      <span className="wo-comment-count" data-blocking={blocking || undefined} data-none={!open.length || undefined}>
        <IconMessage size={12} /> {open.length || threads.length}
      </span>
    </Tooltip>
  );
}

/* ---------------------------------------------------------------- code touched */

export function ChangeBadge({ change }: { change: TouchedFile['change'] }) {
  const letter = { added: 'A', modified: 'M', deleted: 'D', renamed: 'R' }[change];
  return (
    <Tooltip label={change} openDelay={300}>
      <span className="wo-change" data-change={change} aria-label={change}>
        {letter}
      </span>
    </Tooltip>
  );
}

interface TreeNode {
  name: string;
  path: string;
  dirs: Map<string, TreeNode>;
  files: TouchedFile[];
}
function buildTree(files: TouchedFile[]): TreeNode {
  const root: TreeNode = { name: '', path: '', dirs: new Map(), files: [] };
  for (const f of files) {
    const parts = f.path.split('/');
    let n = root;
    for (const p of parts.slice(0, -1)) {
      if (!n.dirs.has(p)) n.dirs.set(p, { name: p, path: n.path ? `${n.path}/${p}` : p, dirs: new Map(), files: [] });
      n = n.dirs.get(p)!;
    }
    n.files.push(f);
  }
  // Collapse single-child directories (`src/metering`).
  const squash = (n: TreeNode): TreeNode => {
    for (const [k, d] of n.dirs) n.dirs.set(k, squash(d));
    if (n.name && !n.files.length && n.dirs.size === 1) {
      const only = [...n.dirs.values()][0]!;
      return { ...only, name: `${n.name}/${only.name}` };
    }
    return n;
  };
  return squash(root);
}

function TreeView({ n, sections, depth }: { n: TreeNode; sections: (f: TouchedFile) => { id: string; title: string }[]; depth: number }) {
  return (
    <>
      {[...n.dirs.values()]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((d) => (
          <div key={d.path}>
            <div className="wo-tree-dir" style={{ paddingLeft: depth * 12 }}>
              <IconFolder size={13} /> {d.name}
            </div>
            <TreeView n={d} sections={sections} depth={depth + 1} />
          </div>
        ))}
      {n.files
        .sort((a, b) => a.path.localeCompare(b.path))
        .map((f) => {
          const secs = sections(f);
          return (
            <div key={f.path} className="wo-tree-file" style={{ paddingLeft: depth * 12 }} data-change={f.change}>
              <ChangeBadge change={f.change} />
              <KindIcon kind="code_file" size={13} />
              <span className="wo-tree-name mono">{f.path.split('/').pop()}</span>
              {f.from && <span className="faint small mono">← {f.from}</span>}
              {f.lines?.length ? <span className="faint small mono">{f.lines.map((l) => `L${l}`).join(', ')}</span> : null}
              {f.symbols?.length ? <span className="faint small mono">{f.symbols.join(', ')}</span> : null}
              {secs.length > 0 && (
                <span className="wo-tree-secs">
                  {secs.map((s) => (
                    <a key={s.id} href={`#section-${s.id}`} className="wo-tree-sec">
                      § {s.title}
                    </a>
                  ))}
                </span>
              )}
            </div>
          );
        })}
    </>
  );
}

/** The aggregate touched code as a file tree per repo, with change type, ranges and the sections that touched it. */
export function CodeTouched({ touched, sections }: { touched: TouchedFile[]; sections: { id: string; title: string; codeRefs: TouchedFile[] }[] }) {
  const byRepo = useMemo(() => {
    const m = new Map<string, TouchedFile[]>();
    for (const f of touched) m.set(f.repo, [...(m.get(f.repo) ?? []), f]);
    return m;
  }, [touched]);
  if (!touched.length) return <span className="faint small">No code recorded yet.</span>;
  const secsOf = (f: TouchedFile) => sections.filter((s) => s.codeRefs.some((c) => c.repo === f.repo && c.path === f.path));
  return (
    <div className="wo-tree">
      {[...byRepo].map(([repo, files]) => (
        <div key={repo} className="wo-tree-repo">
          <div className="wo-tree-repo-name">
            <IconServer size={13} /> {repo} <span className="faint small">{plural(files.length, 'file')}</span>
          </div>
          <TreeView n={buildTree(files)} sections={secsOf} depth={0} />
        </div>
      ))}
    </div>
  );
}

/** A section's code refs as chips with the change type. */
export function TouchedChips({ refs, commit }: { refs: TouchedFile[]; commit?: string }) {
  return (
    <div className="wo-touched-chips">
      {refs.map((r) => (
        <span key={`${r.repo}:${r.path}`} className="wo-touched-chip">
          <ChangeBadge change={r.change} />
          <CodeRefChip codeRef={{ repo: r.repo, path: r.path, ...(r.lines?.[0] ? { lines: r.lines[0] } : {}), ...(commit ? { commit } : {}) }} />
          {(r.lines?.length ?? 0) > 1 && <span className="faint small mono">+{r.lines!.slice(1).map((l) => `L${l}`).join(', ')}</span>}
          {r.from && <span className="faint small mono">← {r.from}</span>}
        </span>
      ))}
    </div>
  );
}

/* ---------------------------------------------------------------- git */

const PR_ICON = { draft: IconGitPullRequestDraft, open: IconGitPullRequest, merged: IconGitMerge, closed: IconGitPullRequestClosed };

export function PrBadge({ pr, repo }: { pr: PullRequest; repo?: string }) {
  const Icon = PR_ICON[pr.status];
  const body = (
    <>
      <Icon size={12} /> {repo ? `${repo}#` : '#'}
      {pr.number} · {pr.status}
    </>
  );
  return pr.url ? (
    <a className="wo-pr" data-status={pr.status} href={pr.url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>
      {body}
      <IconExternalLink size={11} />
    </a>
  ) : (
    <span className="wo-pr" data-status={pr.status}>
      {body}
    </span>
  );
}

export function BranchLabel({ g }: { g: Pick<GitContext, 'branch' | 'baseBranch'> }) {
  if (!g.branch) return null;
  return (
    <Tooltip label={g.baseBranch ? `${g.branch} → ${g.baseBranch}` : g.branch} multiline maw={320} style={{ overflowWrap: 'anywhere' }} openDelay={300}>
      <span className="wo-branch mono">
        <IconGitBranch size={12} />
        {g.branch}
        {g.baseBranch && <span className="faint"> → {g.baseBranch}</span>}
      </span>
    </Tooltip>
  );
}

/** Branch + PR of the first repo with git context (list rows, header). */
export function WorkOrderGitSummary({ item, compact }: { item: Pick<WorkOrder, 'git'>; /** Lists: the PR replaces the branch when there is one. */ compact?: boolean }) {
  const g = (item.git ?? []).find((x) => x.branch || x.pr);
  if (!g) return null;
  return (
    <span className="wo-list-git">
      {g.branch && !(compact && g.pr) && <BranchLabel g={{ branch: g.branch }} />}
      {g.pr && <PrBadge pr={g.pr} repo={(item.git ?? []).length > 1 ? g.repo : undefined} />}
    </span>
  );
}

/** Per repo: branch → base, worktree, commits, PR; then the claim history. */
export function GitPanel({ git, claims }: { git: GitContext[]; claims: PastClaim[] }) {
  return (
    <div className="wo-git">
      {git.length === 0 && <span className="faint small">No git context recorded yet.</span>}
      {git.map((g) => (
        <div key={g.repo} className="wo-git-repo">
          <div className="wo-git-row">
            <span className="wo-git-repo-name">
              <IconServer size={13} /> {g.repo}
            </span>
            {g.pr && <PrBadge pr={g.pr} />}
          </div>
          <BranchLabel g={g} />
          {g.worktree && (
            <Tooltip label="Worktree" openDelay={300}>
              <div className="faint small mono wo-git-worktree">
                {g.worktree.host ? `${g.worktree.host}:` : ''}
                {g.worktree.path}
              </div>
            </Tooltip>
          )}
          {(g.commits?.length ?? 0) > 0 && (
            <div className="wo-git-commits">
              {g.commits!.map((c) => (
                <span key={c} className="wo-git-commit">
                  <CommitHash sha={c} />
                </span>
              ))}
            </div>
          )}
          {g.pr?.mergedCommit && (
            <div className="faint small">
              Merged{g.mergedInto ? ` into ${g.mergedInto}` : ''} as <span className="mono">{g.pr.mergedCommit.slice(0, 7)}</span>
            </div>
          )}
        </div>
      ))}
      {claims.length > 0 && (
        <div className="wo-claims">
          <div className="prop-subtitle">Claim history</div>
          {claims.map((c, i) => (
            <div key={`${c.agent}-${c.startedAt}-${i}`} className="wo-claim-row small">
              <Avatar author={{ agent: c.agent }} size={18} />
              <span>{c.agent}</span>
              <span className="faint">
                <TimeAgo iso={c.startedAt} /> → {c.ended.replace('_', ' ')}
              </span>
              {c.branch && <span className="faint mono">{c.branch}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Done / total sections bar. */
export function SectionProgress({ done, total }: { done: number; total: number }) {
  const pct = total ? Math.round((done / total) * 100) : 0;
  return (
    <Tooltip label={`${done}/${total} sections done`} openDelay={300}>
      <div className="wo-progress">
        <div className="embed-progress" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
          <span style={{ width: `${pct}%` }} />
        </div>
        <span className="small faint">
          {done}/{total} sections
        </span>
      </div>
    </Tooltip>
  );
}


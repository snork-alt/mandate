/**
 * Code repositories of a project (New project → Code repositories, Settings → Code repositories): one or more GitHub
 * repos, each with a stable short name that code refs use (code refs: `code/<name>/<path>`). Mandate only reads them.
 * The specs repository can't also be a code repository.
 */
import { Anchor, Button, Checkbox, CloseButton, Loader, Skeleton, Text, TextInput, Tooltip, UnstyledButton } from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { IconAlertCircle, IconBrandGithub, IconCode, IconExternalLink, IconEye, IconGitBranch, IconLock, IconPlus, IconSearch, IconWorld } from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { buildCodeRef, codeRepoProblems, defaultCodeRepoName } from '@mandate/shared';

/** The code ref prefix (from the shared builder). */
const CODE_PREFIX = buildCodeRef({ repo: '', path: '' }).replace(/\/+$/, '/');
import { relativeTime } from '../lib/time';
import { githubApi, type CodeRepoEntry, type GithubRepo } from './github';
import { OwnerAvatar, OwnerTabs, ownerLabel } from './ownerTabs';

/** A code repository being edited (GitHub details are optional: entries loaded from the server only know the link). */
export interface CodeRepoDraft {
  name: string;
  github: string;
  defaultBranch?: string | null;
  private?: boolean;
  ownerAvatarUrl?: string | null;
}

export const READ_ONLY_NOTE = 'Mandate only reads these to link specs to code; it never writes to them.';

export const toEntry = (d: CodeRepoDraft): CodeRepoEntry => ({ name: d.name.trim(), github: d.github, ...(d.defaultBranch ? { defaultBranch: d.defaultBranch } : {}) });
export const fromRepo = (r: GithubRepo, name = defaultCodeRepoName(r.fullName)): CodeRepoDraft => ({ name, github: r.fullName, defaultBranch: r.defaultBranch, private: r.private, ownerAvatarUrl: r.ownerAvatarUrl ?? null });

/** Per row: the short-name error and a one-click fix (a free name). */
export function codeRepoErrors(list: CodeRepoDraft[], specsRepo: string | null): Record<number, { name?: string; github?: string; fix?: string }> {
  const out: Record<number, { name?: string; github?: string; fix?: string }> = {};
  const problems = codeRepoProblems(
    list.map((d) => ({ name: d.name.trim(), github: d.github })),
    specsRepo,
  );
  const taken = new Set(list.map((d) => d.name.trim()));
  for (const p of problems) {
    const row = (out[p.index] ??= {});
    if (p.field === 'github') {
      row.github = p.message;
      continue;
    }
    const empty = !list[p.index]!.name.trim();
    row.name = empty ? 'Give it a short name' : p.message.startsWith("'") ? 'Lowercase letters, digits and dashes' : p.message;
    // A free name: the repo's own name, else with -2, -3, ...
    const base = defaultCodeRepoName(list[p.index]!.github);
    let fix = base;
    for (let i = 2; taken.has(fix); i++) fix = `${base}-${i}`;
    row.fix = fix;
  }
  return out;
}

function RepoName({ github }: { github: string }) {
  const [owner, name] = github.split('/');
  return (
    <span className="np-repo-name">
      <span className="np-repo-owner">{owner}/</span>
      <b>{name}</b>
    </span>
  );
}

function ReadOnlyChip() {
  return (
    <span className="np-chip cr-ro">
      <IconEye size={11} />
      Read-only
    </span>
  );
}

/** The added repositories: repository · short name · remove. */
function CodeRepoRows({ value, onChange, specsRepo, readOnly }: { value: CodeRepoDraft[]; onChange: (v: CodeRepoDraft[]) => void; specsRepo: string | null; readOnly?: boolean }) {
  const errors = codeRepoErrors(value, specsRepo);
  const setName = (i: number, name: string) => onChange(value.map((d, j) => (j === i ? { ...d, name } : d)));
  return (
    <div className="cr-table" data-testid="code-repo-rows">
      <div className="cr-head" aria-hidden="true">
        <span>Repository</span>
        <span>Short name</span>
      </div>
      {value.map((d, i) => {
        const e = errors[i];
        const owner = d.github.split('/')[0]!;
        return (
          <div key={d.github} className="cr-row" data-invalid={e ? true : undefined} data-testid={`code-repo-${d.github}`}>
            <div className="cr-repo">
              <OwnerAvatar url={d.ownerAvatarUrl ?? `https://github.com/${encodeURIComponent(owner)}.png?size=48`} login={owner} size={24} />
              <div className="cr-repo-main">
                <RepoName github={d.github} />
                <span className="cr-meta">
                  {d.defaultBranch && (
                    <span className="cr-meta-item np-mono">
                      <IconGitBranch size={12} />
                      {d.defaultBranch}
                    </span>
                  )}
                  {d.private !== undefined && (
                    <span className="cr-meta-item">
                      {d.private ? <IconLock size={12} /> : <IconWorld size={12} />}
                      {d.private ? 'Private' : 'Public'}
                    </span>
                  )}
                  <ReadOnlyChip />
                </span>
              </div>
            </div>
            <TextInput
              className="cr-name np-mono-input"
              size="sm"
              value={d.name}
              aria-label={`Short name for ${d.github}`}
              readOnly={readOnly}
              onChange={(ev) => setName(i, ev.currentTarget.value)}
              error={!!e?.name}
              rightSection={e?.name ? <IconAlertCircle size={15} color="var(--mantine-color-red-6)" /> : undefined}
              data-testid={`code-repo-name-${d.github}`}
            />
            {!readOnly ? (
              <CloseButton size="sm" aria-label={`Remove ${d.github}`} onClick={() => onChange(value.filter((_, j) => j !== i))} data-testid={`code-repo-remove-${d.github}`} />
            ) : (
              <span />
            )}
            {(e?.name || e?.github) && (
              <div className="cr-error" role="alert" data-testid={`code-repo-error-${d.github}`}>
                <IconAlertCircle size={14} />
                <span>{e.name ?? e.github}</span>
                {e.name && e.fix && !readOnly && (
                  <Anchor component="button" type="button" size="sm" fw={600} onClick={() => setName(i, e.fix!)} data-testid={`code-repo-fix-${d.github}`}>
                    Use {e.fix}
                  </Anchor>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** Multi-select picker (same owner tabs and search as the specs repository); the specs repo is shown disabled. */
export function CodeRepoPicker({ specsRepo, added, onAdd, onCancel, single, title = 'Add repositories' }: { specsRepo: string | null; added: string[]; onAdd: (repos: GithubRepo[]) => void; onCancel: () => void; single?: boolean; title?: string }) {
  const [owner, setOwner] = useState('all');
  const [q, setQ] = useState('');
  const [debounced] = useDebouncedValue(q, 250);
  const [picked, setPicked] = useState<GithubRepo[]>([]);
  const repos = useQuery({ queryKey: ['github', 'repos', owner, debounced], queryFn: ({ signal }) => githubApi.repos(debounced, owner, signal), staleTime: 30_000, placeholderData: (prev) => prev });
  const data = repos.data;
  const owners = data?.owners ?? [];
  const sel = owners.find((o) => o.login === owner);
  const installUrl = data?.app?.installUrl ?? null;
  const addedSet = new Set(added.map((a) => a.toLowerCase()));
  const isSpecs = (r: GithubRepo) => !!specsRepo && r.fullName.toLowerCase() === specsRepo.toLowerCase();
  const toggle = (r: GithubRepo) => setPicked((p) => (p.some((x) => x.fullName === r.fullName) ? p.filter((x) => x.fullName !== r.fullName) : single ? [r] : [...p, r]));
  const placeholder = owner === 'all' ? 'Search repositories' : sel?.type === 'user' ? 'Search your repositories' : `Search ${sel ? ownerLabel(sel) : owner} repositories`;
  return (
    <div className="cr-picker" data-testid="code-repo-picker">
      <div className="cr-picker-head">
        <Text fw={600}>{title}</Text>
        <CloseButton size="sm" aria-label="Close" onClick={onCancel} />
      </div>
      {owners.length > 0 && <OwnerTabs owners={owners} value={owner} onChange={setOwner} addUrl={installUrl ?? data?.grantUrl} app={!!installUrl} />}
      <TextInput
        size="md"
        value={q}
        onChange={(e) => setQ(e.currentTarget.value)}
        aria-label="Search repositories"
        placeholder={placeholder}
        leftSection={<IconSearch size={16} />}
        rightSection={repos.isFetching && !repos.isLoading ? <Loader size={14} /> : q ? <CloseButton size="sm" aria-label="Clear search" onClick={() => setQ('')} /> : null}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.preventDefault();
          if (e.key === 'Escape' && q) (e.preventDefault(), e.stopPropagation(), setQ(''));
        }}
        data-testid="code-repo-search"
      />
      <div className="np-repos pj-repos cr-picker-list" data-testid="code-repo-list">
        {repos.isLoading &&
          [0, 1, 2].map((i) => (
            <div key={i} className="np-repo pj-repo np-repo-skeleton" aria-hidden="true">
              <Skeleton width={24} height={24} radius={6} />
              <Skeleton height={10} width="40%" radius="xl" />
            </div>
          ))}
        {repos.isError && (
          <Text size="sm" c="red" p="sm">
            Could not load repositories: {(repos.error as Error).message}
          </Text>
        )}
        {data?.needsScope && (
          <Text size="sm" className="np-muted" p="sm">
            Mandate needs GitHub access to list your repositories: choose the specs repository first.
          </Text>
        )}
        {data && !data.needsScope && data.items.length === 0 && !repos.isError && (
          <div className="np-repos-empty pj-empty">
            <Text size="sm" fw={500}>
              {q ? `No repositories match “${q}”` : 'No repositories here yet'}
            </Text>
            {!installUrl && data?.grantUrl && (
              <>
                <Text size="sm" className="np-muted">
                  If it belongs to an organization that isn’t listed, give Mandate access to it, then refresh.
                </Text>
                <Button component="a" href={data.grantUrl} target="_blank" rel="noreferrer" size="sm" variant="default" leftSection={<IconBrandGithub size={15} />} rightSection={<IconExternalLink size={13} />} mt={6}>
                  Give access to an organization
                </Button>
              </>
            )}
            {installUrl && (
              <Button component="a" href={installUrl} target="_blank" rel="noreferrer" size="sm" variant="default" leftSection={<IconBrandGithub size={15} />} rightSection={<IconExternalLink size={13} />} mt={6}>
                Install the GitHub App
              </Button>
            )}
          </div>
        )}
        {data?.items.map((r) => {
          const specs = isSpecs(r);
          const already = addedSet.has(r.fullName.toLowerCase());
          const disabled = specs || already;
          const on = already || picked.some((p) => p.fullName === r.fullName);
          const row = (
            <UnstyledButton
              key={r.fullName}
              type="button"
              className="np-repo pj-repo cr-pick"
              data-selected={(on && !already) || undefined}
              data-disabled={disabled || undefined}
              aria-disabled={disabled || undefined}
              onClick={() => !disabled && toggle(r)}
              data-testid={`pick-${r.fullName}`}
            >
              <OwnerAvatar url={r.ownerAvatarUrl} login={r.owner} size={24} />
              <span className="np-repo-main">
                <RepoName github={r.fullName} />
                {r.description && <span className="np-repo-desc">{r.description}</span>}
              </span>
              {already && <span className="np-chip pj-hide-phone">Added</span>}
              {specs && <span className="np-chip cr-specs">Specs</span>}
              <span className="np-chip">
                {r.private ? <IconLock size={11} /> : <IconWorld size={11} />}
                <span className="pj-hide-phone">{r.private ? 'Private' : 'Public'}</span>
              </span>
              <span className="np-repo-time pj-hide-phone">{r.pushedAt ? relativeTime(r.pushedAt) : 'never pushed'}</span>
              <Checkbox checked={on} disabled={disabled} readOnly tabIndex={-1} aria-hidden="true" size="sm" />
            </UnstyledButton>
          );
          return specs ? (
            <Tooltip key={r.fullName} label="Specs repository — can't also be a code repository" withinPortal>
              {row}
            </Tooltip>
          ) : (
            row
          );
        })}
      </div>
      {installUrl && !!data?.items.length && (
        <Text size="sm" className="np-muted">
          Missing a repository?{' '}
          <Anchor href={installUrl} target="_blank" rel="noreferrer" size="sm" data-testid="code-repo-install-app">
            Configure the GitHub App
          </Anchor>
        </Text>
      )}
      <div className="cr-picker-foot">
        <Text size="sm" className="np-muted">
          {picked.length} selected
        </Text>
        <Button type="button" variant="subtle" color="gray" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="button" size="sm" leftSection={<IconPlus size={15} />} disabled={!picked.length} onClick={() => onAdd(picked)} data-testid="code-repo-add-picked">
          {single ? 'Link repository' : picked.length ? `Add ${picked.length} ${picked.length === 1 ? 'repository' : 'repositories'}` : 'Add repositories'}
        </Button>
      </div>
    </div>
  );
}

/** Notice, the rows (or the empty state), the picker and the code ref example. */
export function CodeReposEditor({ value, onChange, specsRepo, readOnly }: { value: CodeRepoDraft[]; onChange: (v: CodeRepoDraft[]) => void; specsRepo: string | null; readOnly?: boolean }) {
  const [picking, setPicking] = useState(false);
  const add = (repos: GithubRepo[]) => {
    const taken = new Set(value.map((d) => d.name.trim()));
    const next = [...value];
    for (const r of repos) {
      if (next.some((d) => d.github.toLowerCase() === r.fullName.toLowerCase())) continue;
      // Default = the repo name; a taken name stays visible as a duplicate with its one-click fix.
      const d = fromRepo(r);
      taken.add(d.name);
      next.push(d);
    }
    onChange(next);
    setPicking(false);
  };
  const example = value[0]?.name.trim() || 'web-app';
  return (
    <div className="pj-stack cr-editor" data-testid="code-repos-editor">
      <div className="np-notice cr-notice" data-tone="neutral" data-testid="code-repos-readonly">
        <div className="np-notice-icon">
          <IconEye size={16} />
        </div>
        <div className="np-notice-body">
          <b>Read-only.</b> {READ_ONLY_NOTE}
        </div>
      </div>
      {value.length > 0 ? (
        <CodeRepoRows value={value} onChange={onChange} specsRepo={specsRepo} readOnly={readOnly} />
      ) : (
        !picking && (
          <div className="cr-empty" data-testid="code-repos-empty">
            <span className="pj-empty-icon">
              <IconCode size={18} />
            </span>
            <Text fw={600}>No code repositories yet</Text>
            <Text size="sm" className="np-muted">
              Add the repositories your specs describe. You can link one or more, from any account or organization.
            </Text>
            {!readOnly && (
              <Button type="button" size="sm" variant="default" leftSection={<IconPlus size={15} />} onClick={() => setPicking(true)} mt={6} data-testid="code-repo-add">
                Add repository
              </Button>
            )}
          </div>
        )
      )}
      {picking && <CodeRepoPicker specsRepo={specsRepo} added={value.map((d) => d.github)} onAdd={add} onCancel={() => setPicking(false)} />}
      {value.length > 0 && !picking && !readOnly && (
        <div className="cr-actions">
          <Button type="button" size="sm" variant="default" leftSection={<IconPlus size={15} />} onClick={() => setPicking(true)} data-testid="code-repo-add">
            Add repository
          </Button>
          <Text size="sm" className="np-faint">
            Lowercase letters, digits and dashes
          </Text>
        </div>
      )}
      {value.length > 0 && (
        <div className="cr-example" data-testid="code-ref-example">
          <span className="np-faint">Agents write</span>
          <code>
            {CODE_PREFIX}
            <span className="cr-example-name">{example}</span>/src/auth.ts<span className="np-faint">@3f9c2a1</span>
          </code>
        </div>
      )}
    </div>
  );
}

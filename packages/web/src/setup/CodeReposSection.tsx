/**
 * Settings → Code repositories: the code repositories coding agents reported, per project. They register themselves
 * the first time an agent reports a code ref (Mandate never reads the code); admins can rename one, set its remote URL
 * (code chips link to GitHub only when a remote is known) or remove it. Optional: nothing here is needed to work.
 */
import { ActionIcon, Alert, Button, Group, Loader, Text, TextInput } from '@mantine/core';
import { IconTrash } from '@tabler/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { buildCodeRef, CODE_REPO_NAME_RE, cleanRemote, codeRepoProblems } from '@mandate/shared';
import { StepIntro } from './widgets';
import type { SectionProps } from './sections';
import { codeReposApi, type CodeRepoEntry, type CodeReposProject } from '../connect/github';
import '../connect/newProject.css';

const KEY = ['ui-code-repos'];

/** Per row problems of an edited list (empty = valid). */
export function codeRepoRowErrors(list: CodeRepoEntry[]): Record<number, { name?: string; remote?: string }> {
  const out: Record<number, { name?: string; remote?: string }> = {};
  for (const p of codeRepoProblems(list.map((r) => ({ name: r.name.trim() })))) if (p.field === 'name') (out[p.index] ??= {}).name = CODE_REPO_NAME_RE.test(list[p.index]!.name.trim()) ? 'Already used' : 'Lowercase letters, digits and dashes';
  list.forEach((r, i) => {
    if (r.remote?.trim() && !cleanRemote(r.remote)) (out[i] ??= {}).remote = 'Not a git remote URL';
  });
  return out;
}

/** The list to save: trimmed, empty remote dropped. */
export const cleanEntries = (list: CodeRepoEntry[]): CodeRepoEntry[] =>
  list.map((r) => {
    const { remote, ...rest } = r;
    const clean = remote?.trim() ? (cleanRemote(remote) ?? remote.trim()) : undefined;
    return { ...rest, name: r.name.trim(), ...(clean ? { remote: clean } : {}) };
  });

const same = (a: CodeRepoEntry[], b: CodeRepoEntry[]) => JSON.stringify(cleanEntries(a)) === JSON.stringify(cleanEntries(b));

function ProjectCodeRepos({ p, admin }: { p: CodeReposProject; admin: boolean }) {
  const qc = useQueryClient();
  const [value, setValue] = useState<CodeRepoEntry[]>(p.codeRepos);
  useEffect(() => setValue(p.codeRepos), [p]);
  const save = useMutation({
    mutationFn: (list: CodeRepoEntry[]) => codeReposApi.save(p.id, cleanEntries(list)),
    onSuccess: () => void qc.invalidateQueries({ queryKey: KEY }),
  });
  const dirty = !same(value, p.codeRepos);
  const errors = codeRepoRowErrors(value);
  const invalid = Object.keys(errors).length > 0;
  const patch = (i: number, x: Partial<CodeRepoEntry>) => setValue(value.map((r, j) => (j === i ? { ...r, ...x } : r)));
  return (
    <div className="flow-project" data-testid={`code-repos-${p.id}`}>
      <Group gap={8} mb={6}>
        <Text fw={600}>{p.name}</Text>
        <Text size="xs" c="dimmed" ff="monospace">
          {p.id}
        </Text>
      </Group>
      {value.length === 0 && (
        <Text size="sm" c="dimmed" data-testid={`code-repos-empty-${p.id}`}>
          None yet. A repository appears here when a coding agent first reports code in it.
        </Text>
      )}
      {value.map((r, i) => (
        <div key={r.name + i} className="cr-row" data-testid={`code-repo-${r.name}`} data-invalid={errors[i] ? true : undefined}>
          <TextInput
            size="xs"
            aria-label={`Short name of ${r.name}`}
            value={r.name}
            disabled={!admin}
            error={errors[i]?.name}
            onChange={(e) => patch(i, { name: e.currentTarget.value })}
            className="np-mono-input"
            data-testid={`code-repo-name-${r.name}`}
          />
          <TextInput
            size="xs"
            aria-label={`Remote URL of ${r.name}`}
            placeholder="Remote URL (optional): code links open it on GitHub"
            value={r.remote ?? r.github ?? ''}
            disabled={!admin}
            error={errors[i]?.remote}
            onChange={(e) => patch(i, { remote: e.currentTarget.value })}
            style={{ flex: 1 }}
            data-testid={`code-repo-remote-${r.name}`}
          />
          {admin && (
            <ActionIcon variant="subtle" color="gray" aria-label={`Remove ${r.name}`} onClick={() => setValue(value.filter((_, j) => j !== i))} data-testid={`code-repo-remove-${r.name}`}>
              <IconTrash size={15} />
            </ActionIcon>
          )}
          {r.auto && r.registeredBy && (
            <Text size="xs" c="dimmed" data-testid={`code-repo-by-${r.name}`}>
              registered by {r.registeredBy}
              {r.registeredAt ? ` on ${r.registeredAt.slice(0, 10)}` : ''}
            </Text>
          )}
        </div>
      ))}
      {p.unlinked.length > 0 && (
        <Text size="xs" c="dimmed" mt={6} data-testid={`code-repos-unlinked-${p.id}`}>
          Named in this project&apos;s data but not registered: {p.unlinked.map((u) => u.name).join(', ')}. They register when an agent next reports them.
        </Text>
      )}
      {admin ? (
        <Group justify="flex-end" gap={8} mt="sm">
          {save.isSuccess && !dirty && (
            <Text size="xs" c="teal">
              Saved
            </Text>
          )}
          {dirty && (
            <Button type="button" size="xs" variant="default" onClick={() => setValue(p.codeRepos)}>
              Discard
            </Button>
          )}
          <Button type="button" size="xs" disabled={!dirty || invalid} loading={save.isPending} onClick={() => save.mutate(value)} data-testid={`code-repos-save-${p.id}`}>
            Save
          </Button>
        </Group>
      ) : (
        <Text size="xs" c="dimmed" mt={6}>
          Only Mandate admins change code repositories.
        </Text>
      )}
      {save.error && <Alert color="red" mt="xs">{(save.error as Error).message}</Alert>}
    </div>
  );
}

export function CodeReposSection(_p: SectionProps) {
  const q = useQuery({ queryKey: KEY, queryFn: () => codeReposApi.list(), staleTime: 10_000 });
  return (
    <div className="su-section" data-testid="code-repos-section">
      <StepIntro title="Code repositories">
        Optional. Coding agents work on the code locally and reference it by short name (<code>{buildCodeRef({ repo: '<name>', path: '<path>' })}</code>); a repository is registered automatically the first time an
        agent reports it. Set a remote URL to make code references link to GitHub; without one only the path is shown.
      </StepIntro>
      {q.isLoading && <Loader size="sm" />}
      {q.error && <Alert color="red">{(q.error as Error).message}</Alert>}
      {q.data && !q.data.projects.length && (
        <Text size="sm" c="dimmed">
          No projects yet.
        </Text>
      )}
      {q.data?.projects.map((p) => <ProjectCodeRepos key={p.id} p={p} admin={q.data.admin} />)}
    </div>
  );
}

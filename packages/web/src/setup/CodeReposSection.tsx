/**
 * Settings → Code repositories: per project, the code repositories coding agents reference by short name (admins add,
 * rename, remove; the same rows as New project). Repo names already used in a project's data but not registered yet
 * are listed so an admin can link each to its GitHub repository.
 */
import { Alert, Button, Group, Loader, Text } from '@mantine/core';
import { IconLink } from '@tabler/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { buildCodeRef } from '@mandate/shared';
import { StepIntro } from './widgets';
import type { SectionProps } from './sections';
import { codeReposApi, type CodeReposProject } from '../connect/github';
import { codeRepoErrors, CodeRepoPicker, CodeReposEditor, fromRepo, toEntry, type CodeRepoDraft } from '../connect/CodeRepos';
import '../connect/newProject.css';

const KEY = ['ui-code-repos'];
const draftsOf = (p: CodeReposProject): CodeRepoDraft[] => p.codeRepos.map((r) => ({ name: r.name, github: r.github, defaultBranch: r.defaultBranch ?? null }));
const same = (a: CodeRepoDraft[], b: CodeRepoDraft[]) => JSON.stringify(a.map(toEntry)) === JSON.stringify(b.map(toEntry));

function ProjectCodeRepos({ p, admin }: { p: CodeReposProject; admin: boolean }) {
  const qc = useQueryClient();
  const [value, setValue] = useState<CodeRepoDraft[]>(() => draftsOf(p));
  const [linking, setLinking] = useState<string | null>(null);
  useEffect(() => setValue(draftsOf(p)), [p]);
  const save = useMutation({
    mutationFn: (list: CodeRepoDraft[]) => codeReposApi.save(p.id, list.map(toEntry)),
    onSuccess: () => void qc.invalidateQueries({ queryKey: KEY }),
  });
  const dirty = !same(value, draftsOf(p));
  const invalid = Object.keys(codeRepoErrors(value, p.specsRepo)).length > 0;
  const linked = new Set(value.map((d) => d.name.trim()));
  const unlinked = p.unlinked.filter((u) => !linked.has(u.name));
  return (
    <div className="flow-project" data-testid={`code-repos-${p.id}`}>
      <Group gap={8} mb={6}>
        <Text fw={600}>{p.name}</Text>
        <Text size="xs" c="dimmed" ff="monospace">
          {p.id}
        </Text>
        {p.specsRepo && (
          <Text size="xs" c="dimmed">
            · specs in <span className="np-mono">{p.specsRepo}</span>
          </Text>
        )}
      </Group>
      <CodeReposEditor value={value} onChange={setValue} specsRepo={p.specsRepo} readOnly={!admin} />
      {unlinked.length > 0 && (
        <div className="cr-unlinked" data-testid={`code-repos-unlinked-${p.id}`}>
          <Text size="sm" fw={500} mt="sm">
            Used in this project but not linked yet
          </Text>
          <Text size="xs" c="dimmed" mb={6}>
            Code refs already name these repositories. Link each to its GitHub repository so agents can match it.
          </Text>
          {unlinked.map((u) => (
            <Group key={u.name} gap={10} className="cr-unlinked-row" data-testid={`code-repo-unlinked-${u.name}`}>
              <span className="cr-tag np-mono">{u.name}</span>
              <Text size="xs" c="dimmed">
                {u.uses} {u.uses === 1 ? 'reference' : 'references'}
              </Text>
              {admin && (
                <Button type="button" size="compact-sm" variant="subtle" leftSection={<IconLink size={14} />} onClick={() => setLinking(u.name)} data-testid={`code-repo-link-${u.name}`}>
                  Link to a GitHub repository
                </Button>
              )}
            </Group>
          ))}
          {linking && (
            <CodeRepoPicker
              single
              title={`Link ${linking}`}
              specsRepo={p.specsRepo}
              added={value.map((d) => d.github)}
              onCancel={() => setLinking(null)}
              onAdd={(repos) => {
                if (repos[0]) setValue([...value, fromRepo(repos[0], linking)]);
                setLinking(null);
              }}
            />
          )}
        </div>
      )}
      {admin ? (
        <Group justify="flex-end" gap={8} mt="sm">
          {save.isSuccess && !dirty && (
            <Text size="xs" c="teal">
              Saved
            </Text>
          )}
          {dirty && (
            <Button type="button" size="xs" variant="default" onClick={() => setValue(draftsOf(p))}>
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
        The repositories where each project&apos;s code lives. Coding agents reference them by short name (<code>{buildCodeRef({ repo: '<name>', path: '<path>' })}</code>) and record the commit they
        worked on. The short name is the stable key: renaming a GitHub repository only changes its link.
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

import { ActionIcon, Button, Code, Group, Tabs, Text, TextInput, Tooltip } from '@mantine/core';
import { IconAlertTriangle, IconCopy, IconKey, IconTrash } from '@tabler/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { copyText } from '../lib/copy';
import { uiRequest } from '../lib/ui';
import { Notice } from './parts';
import { relativeTime } from '../lib/time';
import { agentGuides, maskKey, tokenEnvVar } from './snippets';
import { AGENT_DEFS, agentDef, tokenEntry } from './agentCatalog';

export interface PersonalToken {
  id: string;
  login: string;
  project: string;
  name: string;
  createdAt: string;
  lastUsedAt?: string;
}

const tokensUrl = (projectId: string) => `/ui/p/${encodeURIComponent(projectId)}/tokens`;
export const tokensApi = {
  list: (projectId: string) => uiRequest<{ items: PersonalToken[] }>('GET', tokensUrl(projectId)),
  create: (projectId: string, name: string) => uiRequest<{ token: string; record: PersonalToken; access: 'read' | 'write' }>('POST', tokensUrl(projectId), { name }),
  revoke: (projectId: string, id: string) => uiRequest<null>('DELETE', `${tokensUrl(projectId)}/${encodeURIComponent(id)}`),
};

function Copyable({ value, shown, where, label }: { value: string; shown?: string; where: string; label: string }) {
  return (
    <div className="connect-snippet">
      <Group justify="space-between" gap={6} className="connect-snippet-head" wrap="nowrap">
        <Text size="xs" c="dimmed" truncate>
          {where}
        </Text>
        <Tooltip label="Copy">
          <ActionIcon type="button" size="sm" variant="subtle" aria-label={`Copy ${label}`} onClick={() => void copyText(value, 'Copied')}>
            <IconCopy size={14} />
          </ActionIcon>
        </Tooltip>
      </Group>
      <Code block className="connect-code">
        {shown ?? value}
      </Code>
    </div>
  );
}

/**
 * Personal tokens: for agents without MCP OAuth. A token acts as you, with your GitHub permissions on this project.
 * `agent`: after creating one, show only that agent's setup (else every agent in tabs); `bare`: no heading (the
 * Connect dialog's Advanced section has its own).
 */
export function PersonalTokens({ projectId, url, access, agent, bare }: { projectId: string; url: string; access?: 'read' | 'write'; agent?: string; bare?: boolean }) {
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ['tokens', projectId], queryFn: () => tokensApi.list(projectId) });
  const [name, setName] = useState('');
  const [fresh, setFresh] = useState<{ token: string; name: string } | null>(null);
  const create = useMutation({
    mutationFn: () => tokensApi.create(projectId, name.trim()),
    onSuccess: (r) => {
      setFresh({ token: r.token, name: r.record.name });
      setName('');
      void qc.invalidateQueries({ queryKey: ['tokens', projectId] });
    },
  });
  const revoke = useMutation({
    mutationFn: (id: string) => tokensApi.revoke(projectId, id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['tokens', projectId] }),
  });
  const env = tokenEnvVar(projectId);
  const all = fresh ? agentGuides({ project: projectId, url, key: fresh.token, envVar: env }).filter((g) => AGENT_DEFS.some((d) => d.id === g.id)) : [];
  const own = fresh && agent ? tokenEntry(agentDef(agent), { project: projectId, url, key: fresh.token }) : null;
  const guides = own ? [{ id: agent!, label: agentDef(agent!).label, env: own.env, register: own.register, verify: own.verify }] : all;
  return (
    <div className="cg-tokens" data-testid="personal-tokens">
      {!bare && (
      <Group gap={8}>
        <IconKey size={15} />
        <Text fw={600} size="sm">
          Personal tokens
        </Text>
        <Text size="xs" className="np-faint">
          for agents without GitHub sign-in
        </Text>
      </Group>
      )}
      <Text size="sm" className="np-muted">
        A token acts as you, with your GitHub permissions on this project{access ? ` (${access === 'read' ? 'read only' : 'read and write'})` : ''}. Put it in an environment variable, never in a repository.
      </Text>
      {fresh ? (
        <div className="np-stack" style={{ gap: 8 }}>
          <Notice icon={<IconAlertTriangle size={16} />} tone="warn" title={`Token “${fresh.name}” created — copy it now, you won't see it again`} testId="token-once">
            <Copyable value={fresh.token} where="token" label="token" />
          </Notice>
          <Tabs defaultValue={guides[0]?.id ?? 'claude-code'} variant="outline" keepMounted={false}>
            <Tabs.List>
              {guides.map((g) => (
                <Tabs.Tab key={g.id} value={g.id}>
                  {g.label}
                </Tabs.Tab>
              ))}
            </Tabs.List>
            {guides.map((g) => (
              <Tabs.Panel key={g.id} value={g.id} pt="sm">
                <div className="np-stack" style={{ gap: 8 }}>
                  {g.env && <Copyable value={g.env} shown={g.env.replace(fresh.token, maskKey(fresh.token))} where="shell profile" label="export" />}
                  <Copyable value={g.register.code} shown={g.register.code.split(fresh.token).join(maskKey(fresh.token))} where={g.register.where} label="config" />
                  <Text size="xs" className="np-muted">
                    {g.verify}
                  </Text>
                </div>
              </Tabs.Panel>
            ))}
          </Tabs>
          <Button type="button" size="xs" variant="subtle" color="gray" onClick={() => setFresh(null)} style={{ alignSelf: 'flex-start' }}>
            Done
          </Button>
        </div>
      ) : (
        <Group gap={6} wrap="nowrap">
          <TextInput size="sm" placeholder="Token name, e.g. laptop" value={name} onChange={(e) => setName(e.currentTarget.value)} style={{ flex: 1 }} data-testid="token-name" />
          <Button type="button" size="sm" variant="default" disabled={!name.trim()} loading={create.isPending} onClick={() => create.mutate()} data-testid="token-create">
            Create token
          </Button>
        </Group>
      )}
      {create.isError && <div className="np-error">{(create.error as Error).message}</div>}
      {(list.data?.items.length ?? 0) > 0 && (
        <div className="su-model-list">
          {list.data!.items.map((t) => (
            <div key={t.id} className="su-model">
              <IconKey size={14} className="np-faint" />
              <span className="su-model-name">{t.name}</span>
              <span className="np-faint" style={{ fontSize: 12 }}>
                created {relativeTime(t.createdAt)}
                {t.lastUsedAt ? ` · used ${relativeTime(t.lastUsedAt)}` : ' · never used'}
              </span>
              <Tooltip label="Revoke">
                <button type="button" className="su-icon-btn" aria-label={`Revoke ${t.name}`} onClick={() => revoke.mutate(t.id)}>
                  <IconTrash size={14} />
                </button>
              </Tooltip>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

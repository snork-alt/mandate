import { ActionIcon, Button, Code, Group, Tabs, Text, TextInput, Tooltip } from '@mantine/core';
import { IconAlertTriangle, IconBrandGithub, IconCopy, IconKey, IconShieldCheck, IconTrash } from '@tabler/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { copyText } from '../lib/copy';
import { uiRequest } from '../lib/ui';
import { Recommended } from '../setup/widgets';
import { AccessBadge } from './AccessBadge';
import { Notice } from './parts';
import { relativeTime } from '../lib/time';
import { agentGuides, FIRST_PROMPT, maskKey, oauthGuides, tokenEnvVar, urlReachNote } from './snippets';

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

/** Personal tokens: for agents without MCP OAuth. A token acts as you, with your GitHub permissions on this project. */
function PersonalTokens({ projectId, url, access }: { projectId: string; url: string; access?: 'read' | 'write' }) {
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
  const guides = fresh ? agentGuides({ project: projectId, url, key: fresh.token, envVar: env }) : [];
  return (
    <div className="cg-tokens" data-testid="personal-tokens">
      <Group gap={8}>
        <IconKey size={15} />
        <Text fw={600} size="sm">
          Personal tokens
        </Text>
        <Text size="xs" className="np-faint">
          for agents without GitHub sign-in
        </Text>
      </Group>
      <Text size="sm" className="np-muted">
        A token acts as you, with your GitHub permissions on this project{access ? ` (${access === 'read' ? 'read only' : 'read and write'})` : ''}. Put it in an environment variable, never in a repository.
      </Text>
      {fresh ? (
        <div className="np-stack" style={{ gap: 8 }}>
          <Notice icon={<IconAlertTriangle size={16} />} tone="warn" title={`Token “${fresh.name}” created — copy it now, you won't see it again`} testId="token-once">
            <Copyable value={fresh.token} where="token" label="token" />
          </Notice>
          <Tabs defaultValue="claude-code" variant="outline" keepMounted={false}>
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
          <TextInput size="sm" placeholder="Token name, e.g. laptop-cursor" value={name} onChange={(e) => setName(e.currentTarget.value)} style={{ flex: 1 }} data-testid="token-name" />
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

/** Server mode: agents sign in with GitHub (MCP OAuth) first; personal tokens second. */
export function OAuthConnect({ projectId, url, access }: { projectId: string; url: string; access?: 'read' | 'write' }) {
  const guides = oauthGuides(projectId, url);
  return (
    <div className="cg" data-testid="connect-guide-oauth">
      <Group gap={10} align="flex-end" wrap="nowrap">
        <TextInput
          label="MCP URL"
          value={url}
          readOnly
          style={{ flex: 1 }}
          rightSection={
            <ActionIcon type="button" variant="subtle" size="sm" aria-label="Copy MCP URL" onClick={() => void copyText(url, 'Copied URL')}>
              <IconCopy size={14} />
            </ActionIcon>
          }
          styles={{ input: { fontFamily: 'var(--mantine-font-family-monospace)', fontSize: 12.5 } }}
        />
        {access && (
          <div style={{ paddingBottom: 9 }}>
            <AccessBadge access={access} />
          </div>
        )}
      </Group>
      <Text size="xs" className="np-muted">
        {urlReachNote(url)}
      </Text>
      <div className="cg-rec">
        <div className="cg-rec-head">
          <IconBrandGithub size={16} />
          <Text fw={600} size="sm">
            Sign in with GitHub from your agent
          </Text>
          <Recommended />
        </div>
        <Text size="sm" className="np-muted">
          Your agent opens GitHub sign-in in the browser; no keys to copy. It gets exactly your access to this project&apos;s repository: read{access === 'write' || !access ? ', and write if you can push' : ' only'}.
        </Text>
        <Tabs defaultValue="claude-code" variant="outline" keepMounted={false} className="cg-tabs">
          <Tabs.List>
            {guides.map((g) => (
              <Tabs.Tab key={g.id} value={g.id}>
                {g.label}
              </Tabs.Tab>
            ))}
            <Tabs.Tab value="other">Others</Tabs.Tab>
          </Tabs.List>
          {guides.map((g) => (
            <Tabs.Panel key={g.id} value={g.id} pt="sm">
              <div className="np-stack" style={{ gap: 8 }}>
                {g.steps.map((s) => (
                  <Copyable key={s.id} value={s.code} where={s.where} label={s.label} />
                ))}
                <Group gap={6} wrap="nowrap" align="flex-start">
                  <IconShieldCheck size={14} className="np-faint" style={{ marginTop: 3, flexShrink: 0 }} />
                  <Text size="sm" className="np-muted">
                    {g.verify}
                  </Text>
                </Group>
                <Copyable value={FIRST_PROMPT} where="then ask your agent" label="first prompt" />
              </div>
            </Tabs.Panel>
          ))}
          <Tabs.Panel value="other" pt="sm">
            <Text size="sm" className="np-muted">
              Agents that support MCP OAuth only need the URL above. For the others, create a personal token below and send it as <code>Authorization: Bearer &lt;token&gt;</code>.
            </Text>
          </Tabs.Panel>
        </Tabs>
      </div>
      <PersonalTokens projectId={projectId} url={url} access={access} />
    </div>
  );
}

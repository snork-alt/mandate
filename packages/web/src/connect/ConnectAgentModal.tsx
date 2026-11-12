import { ActionIcon, Alert, Anchor, Box, Code, Group, Loader, Modal, Stack, Tabs, Text, TextInput, Tooltip } from '@mantine/core';
import { IconAlertTriangle, IconCopy, IconEye, IconEyeOff, IconKey, IconPlugConnected } from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { copyText } from '../lib/copy';
import { redirectToLogin } from '../auth';
import { agentSnippets, devApiPort, genericSnippet, maskKey, mcpUrlFor, type Snippet } from './snippets';

/** `GET /ui/p/<id>/connect` (UI session cookie only). */
export interface ConnectInfo {
  project: { id: string; name: string };
  mcpPath: string;
  key: { id: string; name: string; value: string; masked: string; createdAt: string } | null;
  keysFile: string;
  cli: { create: string; list: string; revoke: string };
}

async function fetchConnect(projectId: string): Promise<ConnectInfo> {
  const res = await fetch(`/ui/p/${encodeURIComponent(projectId)}/connect`, { credentials: 'same-origin', headers: { 'X-Mandate-UI': '1' } });
  if (res.status === 401) {
    // Sign-in expired or revoked.
    redirectToLogin();
    throw new Error('not signed in');
  }
  if (!res.ok) throw new Error(`could not load the connection details (HTTP ${res.status})`);
  return (await res.json()) as ConnectInfo;
}

function SnippetBlock({ snippet, real, label }: { snippet: Snippet; real: Snippet; label?: string }) {
  return (
    <Box className="connect-snippet">
      <Group justify="space-between" gap={6} className="connect-snippet-head" wrap="nowrap">
        <Text size="xs" c="dimmed" truncate>
          {label ?? snippet.where}
        </Text>
        <Tooltip label="Copy (with the key)">
          <ActionIcon size="sm" variant="subtle" aria-label={`Copy ${snippet.label} snippet`} onClick={() => void copyText(real.code, 'Copied config')}>
            <IconCopy size={14} />
          </ActionIcon>
        </Tooltip>
      </Group>
      <Code block className="connect-code" data-lang={snippet.language}>
        {snippet.code}
      </Code>
      {snippet.note && (
        <Text size="xs" c="dimmed" mt={6}>
          {snippet.note}
        </Text>
      )}
    </Box>
  );
}

/** "Connect agent": how a coding agent reaches this project's MCP endpoint with its bearer key. Read-only: never creates keys. */
export function ConnectAgentModal({ projectId, opened, onClose }: { projectId: string; opened: boolean; onClose: () => void }) {
  const [revealed, setRevealed] = useState(false);
  const info = useQuery({ queryKey: ['connect', projectId], queryFn: () => fetchConnect(projectId), enabled: opened, staleTime: 0, gcTime: 0 });
  const d = info.data;
  const url = d ? mcpUrlFor(window.location, d.mcpPath, devApiPort()) : '';
  const key = d?.key?.value ?? '<key>';
  const shown = d?.key ? (revealed ? key : d.key.masked || maskKey(key)) : '<key>';
  const real = { project: projectId, url, key };
  const display = { ...real, key: shown };
  const realAgents = agentSnippets(real);

  return (
    <Modal
      opened={opened}
      onClose={() => {
        setRevealed(false);
        onClose();
      }}
      size="xl"
      title={
        <Group gap={8}>
          <IconPlugConnected size={18} stroke={1.7} />
          <Text fw={600}>Connect a coding agent</Text>
        </Group>
      }
    >
      {info.isLoading && (
        <Group justify="center" py="xl">
          <Loader size="sm" />
        </Group>
      )}
      {info.isError && (
        <Alert color="red" icon={<IconAlertTriangle size={16} />}>
          {(info.error as Error).message}
        </Alert>
      )}
      {d && (
        <Stack gap="md">
          <Text size="sm" c="dimmed">
            Coding agents talk to <b>{d.project.name}</b> over MCP (Streamable HTTP). The endpoint is scoped to this project, and the key works only here; it grants
            read and write access.
          </Text>

          <TextInput
            label="MCP URL"
            value={url}
            readOnly
            rightSection={
              <ActionIcon variant="subtle" size="sm" aria-label="Copy MCP URL" onClick={() => void copyText(url, 'Copied URL')}>
                <IconCopy size={14} />
              </ActionIcon>
            }
            styles={{ input: { fontFamily: 'var(--mantine-font-family-monospace)' } }}
          />

          {d.key ? (
            <TextInput
              label={
                <Group gap={6} component="span">
                  <IconKey size={13} /> Key <Text span size="xs" c="dimmed">({d.key.name})</Text>
                </Group>
              }
              value={shown}
              readOnly
              data-testid="connect-key"
              rightSectionWidth={64}
              rightSection={
                <Group gap={2} wrap="nowrap">
                  <Tooltip label={revealed ? 'Hide key' : 'Reveal key'}>
                    <ActionIcon variant="subtle" size="sm" aria-label={revealed ? 'Hide key' : 'Reveal key'} onClick={() => setRevealed((r) => !r)}>
                      {revealed ? <IconEyeOff size={14} /> : <IconEye size={14} />}
                    </ActionIcon>
                  </Tooltip>
                  <Tooltip label="Copy key">
                    <ActionIcon variant="subtle" size="sm" aria-label="Copy key" onClick={() => void copyText(key, 'Copied key')}>
                      <IconCopy size={14} />
                    </ActionIcon>
                  </Tooltip>
                </Group>
              }
              styles={{ input: { fontFamily: 'var(--mantine-font-family-monospace)' } }}
            />
          ) : (
            <Alert color="yellow" icon={<IconKey size={16} />} title="No key for this project">
              Create one in a terminal: <Code>{d.cli.create}</Code>
            </Alert>
          )}

          <div>
            <Text size="sm" fw={600} mb={6}>
              Configuration
            </Text>
            <SnippetBlock snippet={genericSnippet(display)} real={genericSnippet(real)} label="Most coding agents accept this mcpServers entry (url + Authorization header)." />
          </div>

          <Tabs defaultValue="claude-code" variant="outline" keepMounted={false}>
            <Tabs.List>
              {realAgents.map((s) => (
                <Tabs.Tab key={s.id} value={s.id}>
                  {s.label}
                </Tabs.Tab>
              ))}
            </Tabs.List>
            {agentSnippets(display).map((s, i) => (
              <Tabs.Panel key={s.id} value={s.id} pt="sm">
                <SnippetBlock snippet={s} real={realAgents[i]!} />
              </Tabs.Panel>
            ))}
          </Tabs>

          <Box className="connect-note">
            <Text size="xs" c="dimmed">
              Keys live in <Code>{d.keysFile}</Code> (mode 0600) and are never shown in URLs or logs. The web UI does not create or revoke keys; use the CLI:
            </Text>
            <Stack gap={2} mt={6}>
              {(['create', 'list', 'revoke'] as const).map((k) => (
                <Code key={k} className="connect-cli">
                  {d.cli[k]}
                </Code>
              ))}
            </Stack>
            <Text size="xs" c="dimmed" mt={6}>
              Agents connect to the API server directly{devApiPort() ? ` (port ${devApiPort()}, not this dev UI on ${window.location.port})` : ''}. Writes are attributed to the key name in
              the activity feed. <Anchor size="xs" href="https://modelcontextprotocol.io/docs/learn/transports" target="_blank" rel="noreferrer">About MCP over HTTP</Anchor>
            </Text>
          </Box>
        </Stack>
      )}
    </Modal>
  );
}

import { ActionIcon, Alert, Code, Group, Loader, Tabs, Text, TextInput, Tooltip } from '@mantine/core';
import { IconAlertTriangle, IconCopy, IconEye, IconEyeOff, IconKey, IconMessage, IconShieldCheck, IconTerminal2 } from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { redirectToLogin, useAuth } from '../auth';
import { copyText } from '../lib/copy';
import { Recommended } from '../setup/widgets';
import { OAuthConnect } from './OAuthConnect';
import { InstallOneLiner } from './InstallOneLiner';
import { agentGuides, urlReachNote, connectCommand, devApiPort, FIRST_PROMPT, genericSnippet, keyEnvVar, maskKey, mcpUrlFor, type Snippet } from './snippets';

/** `GET /ui/p/<id>/connect` (signed-in UI session only). */
export interface ConnectInfo {
  project: { id: string; name: string };
  mcpPath: string;
  key: { id: string; name: string; value: string; masked?: string; createdAt: string } | null;
  keysFile: string | null;
  cli: { create: string; list: string; revoke: string };
  /** A team (`oauth`): agents sign in with GitHub or use personal tokens; `key` is null. */
  auth?: 'oauth' | 'key';
  /** Absolute public MCP URL (team). */
  mcpUrl?: string;
  access?: 'read' | 'write';
}

export async function fetchConnect(projectId: string): Promise<ConnectInfo> {
  const res = await fetch(`/ui/p/${encodeURIComponent(projectId)}/connect`, { credentials: 'same-origin', headers: { 'X-Mandate-UI': '1' } });
  if (res.status === 401) {
    redirectToLogin();
    throw new Error('not signed in');
  }
  if (!res.ok) throw new Error(`could not load the connection details (HTTP ${res.status})`);
  return (await res.json()) as ConnectInfo;
}

/** The project's MCP URL as agents reach it: a team's public URL, the API port in development. */
export function useMcpUrl(mcpPath: string | undefined): string {
  const auth = useAuth();
  if (!mcpPath) return '';
  if (auth?.publicUrl && !/^https?:\/\/(localhost|127\.0\.0\.1)(:|$)/.test(auth.publicUrl)) return `${auth.publicUrl.replace(/\/+$/, '')}${mcpPath}`;
  return mcpUrlFor(window.location, mcpPath, devApiPort());
}

function CodeBox({ shown, real, where, label }: { shown: string; real: string; where: string; label: string }) {
  return (
    <div className="connect-snippet">
      <Group justify="space-between" gap={6} className="connect-snippet-head" wrap="nowrap">
        <Text size="xs" c="dimmed" truncate>
          {where}
        </Text>
        <Tooltip label="Copy (with the key)">
          <ActionIcon type="button" size="sm" variant="subtle" aria-label={`Copy ${label}`} onClick={() => void copyText(real, 'Copied')}>
            <IconCopy size={14} />
          </ActionIcon>
        </Tooltip>
      </Group>
      <Code block className="connect-code">
        {shown}
      </Code>
    </div>
  );
}

const box = (s: Snippet, real: Snippet) => <CodeBox shown={s.code} real={real.code} where={s.where} label={`${s.label} config`} />;

/**
 * How to connect a coding agent to one project: the recommended CLI command, then manual setup per agent (Claude Code,
 * Codex first) with the key in an env var, how to verify, and a first prompt. Shared by the Connect-agent dialog and
 * the step after creating a project.
 */
export function ConnectAgentGuide({ projectId, compact }: { projectId: string; compact?: boolean }) {
  const [revealed, setRevealed] = useState(false);
  const info = useQuery({ queryKey: ['connect', projectId], queryFn: () => fetchConnect(projectId), staleTime: 0, gcTime: 0 });
  const d = info.data;
  const computed = useMcpUrl(d?.mcpPath);
  const url = d?.mcpUrl ?? computed;
  const auth = useAuth();
  if (info.isLoading)
    return (
      <Group justify="center" py="xl">
        <Loader size="sm" />
      </Group>
    );
  if (info.isError || !d)
    return (
      <Alert color="red" icon={<IconAlertTriangle size={16} />}>
        {(info.error as Error)?.message ?? 'Cannot load the connection details'}
      </Alert>
    );
  if (d.auth === 'oauth')
    return (
      <div className="cg" data-testid="connect-guide">
        <InstallOneLiner projectId={projectId} mcpUrl={url} />
        <OAuthConnect projectId={projectId} url={url} access={d.access} />
      </div>
    );
  const key = d.key?.value ?? '<key>';
  const shown = d.key ? (revealed ? key : d.key.masked || maskKey(key)) : '<key>';
  const real = { project: projectId, url, key };
  const display = { ...real, key: shown };
  const guides = agentGuides(display);
  const realGuides = agentGuides(real);
  const env = keyEnvVar(projectId);

  return (
    <div className="cg" data-testid="connect-guide">
      <InstallOneLiner projectId={projectId} mcpUrl={url} />
      <div className="cg-grid">
        <TextInput
          label="MCP URL"
          value={url}
          readOnly
          rightSection={
            <ActionIcon type="button" variant="subtle" size="sm" aria-label="Copy MCP URL" onClick={() => void copyText(url, 'Copied URL')}>
              <IconCopy size={14} />
            </ActionIcon>
          }
          styles={{ input: { fontFamily: 'var(--mantine-font-family-monospace)', fontSize: 12.5 } }}
        />
        {d.key ? (
          <TextInput
            label={
              <Group gap={6} component="span">
                <IconKey size={13} /> Your personal token{' '}
                <Text span size="xs" c="dimmed">
                  (key {d.key.name}; your agents act as you)
                </Text>
              </Group>
            }
            value={shown}
            readOnly
            data-testid="connect-key"
            rightSectionWidth={64}
            rightSection={
              <Group gap={2} wrap="nowrap">
                <Tooltip label={revealed ? 'Hide key' : 'Reveal key'}>
                  <ActionIcon type="button" variant="subtle" size="sm" aria-label={revealed ? 'Hide key' : 'Reveal key'} onClick={() => setRevealed((r) => !r)}>
                    {revealed ? <IconEyeOff size={14} /> : <IconEye size={14} />}
                  </ActionIcon>
                </Tooltip>
                <Tooltip label="Copy key">
                  <ActionIcon type="button" variant="subtle" size="sm" aria-label="Copy key" onClick={() => void copyText(key, 'Copied key')}>
                    <IconCopy size={14} />
                  </ActionIcon>
                </Tooltip>
              </Group>
            }
            styles={{ input: { fontFamily: 'var(--mantine-font-family-monospace)', fontSize: 12.5 } }}
          />
        ) : (
          <Alert color="yellow" icon={<IconKey size={16} />} title="No key for this project">
            Create one in a terminal: <Code>{d.cli.create}</Code>
          </Alert>
        )}
      </div>
      {auth?.publicUrl && !/^https?:\/\/(localhost|127\.0\.0\.1)(:|$)/.test(auth.publicUrl) && (
        <Text size="xs" className="np-muted">
          {urlReachNote(url, true)}
        </Text>
      )}

      <div className="cg-rec">
        <div className="cg-rec-head">
          <IconTerminal2 size={16} />
          <Text fw={600} size="sm">
            Or, in a repo on this machine, the Mandate CLI
          </Text>
        </div>
        <Text size="sm" className="np-muted">
          Run it in the code repository your agent works in. It registers this MCP server with the coding agents it finds (Claude Code, Codex, Cursor, …), installs the Mandate skill and slash
          commands, and adds a “Use Mandate” section to CLAUDE.md / AGENTS.md.
        </Text>
        <CodeBox shown={`cd <your code repo> && ${connectCommand(projectId)}`} real={`${connectCommand(projectId)}`} where="terminal" label="connect command" />
      </div>

      <div>
        <Text fw={600} size="sm" mb={6}>
          Or set it up by hand
        </Text>
        <Tabs defaultValue="claude-code" variant="outline" keepMounted={false} className="cg-tabs">
          <Tabs.List>
            {guides.map((g) => (
              <Tabs.Tab key={g.id} value={g.id}>
                {g.label}
              </Tabs.Tab>
            ))}
            <Tabs.Tab value="generic">Other</Tabs.Tab>
          </Tabs.List>
          {guides.map((g, i) => {
            const r = realGuides[i]!;
            return (
              <Tabs.Panel key={g.id} value={g.id} pt="sm">
                <ol className="cg-steps">
                  {g.env && (
                    <li>
                      <Text size="sm" fw={500}>
                        Put the key in an environment variable
                      </Text>
                      <Text size="xs" className="np-muted">
                        Add it to your shell profile (~/.zshrc, ~/.bashrc) so the key stays out of config files.
                      </Text>
                      <CodeBox shown={g.env} real={r.env!} where="shell profile" label={`${env} export`} />
                    </li>
                  )}
                  <li>
                    <Text size="sm" fw={500}>
                      Register the server
                    </Text>
                    {box(g.register, r.register)}
                    {g.register.note && <Text size="xs" className="np-muted">{g.register.note}</Text>}
                  </li>
                  <li>
                    <Group gap={6}>
                      <IconShieldCheck size={14} className="np-faint" />
                      <Text size="sm" fw={500}>
                        Check it
                      </Text>
                    </Group>
                    <Text size="sm" className="np-muted">
                      {g.verify}
                    </Text>
                  </li>
                  <li>
                    <Group gap={6}>
                      <IconMessage size={14} className="np-faint" />
                      <Text size="sm" fw={500}>
                        Try a first prompt
                      </Text>
                    </Group>
                    <CodeBox shown={FIRST_PROMPT} real={FIRST_PROMPT} where="ask your agent" label="first prompt" />
                  </li>
                </ol>
              </Tabs.Panel>
            );
          })}
          <Tabs.Panel value="generic" pt="sm">
            <Text size="sm" className="np-muted" mb={6}>
              Most coding agents accept this mcpServers entry (Streamable HTTP + Authorization header). It contains your key: put it in your user-level config, never in a file you commit.
            </Text>
            {box(genericSnippet(display), genericSnippet(real))}
          </Tabs.Panel>
        </Tabs>
      </div>

      {!compact && (
        <div className="connect-note">
          <Text size="xs" c="dimmed">
            Keys live in <Code>{d.keysFile}</Code> (mode 0600) and never appear in URLs or logs. The web UI does not create or revoke keys; use the CLI:
          </Text>
          <Group gap={6} mt={6}>
            {(['create', 'list', 'revoke'] as const).map((k) => (
              <Code key={k} className="connect-cli">
                {d.cli[k]}
              </Code>
            ))}
          </Group>
        </div>
      )}
    </div>
  );
}

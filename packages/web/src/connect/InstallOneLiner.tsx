import { ActionIcon, Code, Group, SegmentedControl, Text, Tooltip } from '@mantine/core';
import { IconCopy, IconShieldCheck, IconTerminal2 } from '@tabler/icons-react';
import { useState } from 'react';
import { copyText } from '../lib/copy';
import { Recommended } from '../setup/widgets';
import { installCommand, shellFor, verifyCommands, type InstallShell } from './snippets';

/**
 * The one-line installer, shown first in the Connect dialog and after creating a project: it wires every coding agent
 * on the developer's machine (MCP server, skills, commands) by running `getmandate connect` at this server's version.
 * The command holds no token; a team signs agents in with GitHub (MCP OAuth).
 */
export function InstallOneLiner({ projectId, mcpUrl, userAgent = typeof navigator === 'undefined' ? '' : navigator.userAgent }: { projectId: string; mcpUrl: string; userAgent?: string }) {
  const [shell, setShell] = useState<InstallShell>(shellFor(userAgent));
  let base = '';
  try {
    base = new URL(mcpUrl).origin;
  } catch {
    return null;
  }
  const cmd = installCommand(base, projectId, shell);
  return (
    <div className="cg-rec" data-testid="install-oneliner">
      <div className="cg-rec-head">
        <IconTerminal2 size={16} />
        <Text fw={600} size="sm">
          Connect all your coding agents
        </Text>
        <Recommended />
        <SegmentedControl
          size="xs"
          ml="auto"
          value={shell}
          onChange={(v) => setShell(v as InstallShell)}
          data={[
            { value: 'sh', label: 'macOS / Linux' },
            { value: 'powershell', label: 'Windows' },
          ]}
        />
      </div>
      <Text size="sm" className="np-muted">
        Run it in a terminal (inside your code repository to wire that too). It adds this MCP server, the Mandate skill and the slash commands to every coding agent it finds. It needs Node.js 22.
      </Text>
      <Group gap={6} wrap="nowrap" className="connect-snippet">
        <Code block style={{ flex: 1 }} data-testid="install-command">
          {cmd}
        </Code>
        <Tooltip label="Copy">
          <ActionIcon type="button" variant="subtle" size="sm" aria-label="Copy install command" onClick={() => void copyText(cmd, 'Copied command')}>
            <IconCopy size={14} />
          </ActionIcon>
        </Tooltip>
      </Group>
      <details className="su-advanced" data-testid="install-verify">
        <summary>
          <IconShieldCheck size={13} /> Verify the checksum first
        </summary>
        <Text size="xs" className="np-muted" mb={4}>
          Piping a script into a shell runs whatever the server sends. The script holds no token and pins the Mandate version; to read it first, download it and compare its published SHA-256:
        </Text>
        <Code block>{verifyCommands(base, projectId, shell)}</Code>
      </details>
    </div>
  );
}

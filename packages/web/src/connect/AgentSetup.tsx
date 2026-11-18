/**
 * Per-agent setup blocks shared by the Connect dialog and the Getting-started modal: the agent tabs, the one-line
 * installer for that agent (macOS / Linux | Windows), the sign-in step (as the CLI prints it after "Next: sign in
 * (once)") and the collapsed "Advanced: set it up manually" with everything the installer does, by hand.
 */
import { ActionIcon, Alert, Button, Code, Collapse, Group, Menu, Text, TextInput, Tooltip, UnstyledButton } from '@mantine/core';
import {
  IconBrandApple,
  IconBrandGithub,
  IconBrandWindows,
  IconChevronDown,
  IconChevronRight,
  IconCopy,
  IconDots,
  IconEye,
  IconEyeOff,
  IconFileText,
  IconKey,
  IconMessageCircle,
  IconPlugConnected,
  IconShieldCheck,
  IconSlash,
  IconSparkles,
  IconTerminal2,
  IconTrash,
  IconWorld,
} from '@tabler/icons-react';
import { Fragment, useState, type ReactNode } from 'react';
import { copyText } from '../lib/copy';
import { useAuth } from '../auth';
import { useAgentsPresence } from '../lib/comments';
import { WAKE_FIX } from '../lib/requests';
import { Ticks } from '../components/Ticks';
import { AgentMark } from './AgentMark';
import { AGENT_DEFS, agentDef, installFlags, MAIN_AGENTS, MORE_AGENTS, oauthRegistration, SUPPORT_NOTE, tokenEntry, type AgentDef, type AgentTabId } from './agentCatalog';
import type { ConnectInfo } from './ConnectAgentGuide';
import { PersonalTokens } from './OAuthConnect';
import { connectCommand, FIRST_PROMPT, genericSnippet, installCommand, isLoopbackUrl, keyEnvVar, maskKey, serverName, uninstallCommand, urlReachNote, verifyCommands, type InstallShell } from './snippets';
import './connect.css';

/** A tab: one of the agents, or `other` (any other MCP client: the generic entry). */
export type AgentChoice = AgentTabId | 'other';

/** The server origin from the project's MCP URL ('' when it is not a URL yet). */
export function originOf(mcpUrl: string): string {
  try {
    return new URL(mcpUrl).origin;
  } catch {
    return '';
  }
}

/* ------------------------------------------------------------------ small parts */

export function CopyBtn({ value, label, tone = 'primary', title = 'Copied' }: { value: string; label: string; tone?: 'primary' | 'default'; title?: string }) {
  return (
    <Button type="button" size="compact-sm" variant={tone === 'primary' ? 'filled' : 'default'} leftSection={<IconCopy size={13} />} aria-label={`Copy ${label}`} onClick={() => void copyText(value, title)} className="cg2-copy">
      Copy
    </Button>
  );
}

function IconCopyBtn({ value, label }: { value: string; label: string }) {
  return (
    <Tooltip label="Copy">
      <ActionIcon type="button" size="sm" variant="subtle" color="gray" aria-label={`Copy ${label}`} onClick={() => void copyText(value, 'Copied')}>
        <IconCopy size={14} />
      </ActionIcon>
    </Tooltip>
  );
}

/** A code snippet with a small header (where it goes) and a copy icon; `shown` may mask a secret. */
export function Snip({ where, value, shown, label, testId }: { where: ReactNode; value: string; shown?: string; label: string; testId?: string }) {
  return (
    <div className="cg2-snip" data-testid={testId}>
      <div className="cg2-snip-h">
        <span className="cg2-snip-where">{where}</span>
        <IconCopyBtn value={value} label={label} />
      </div>
      <pre className="cg2-pre">{shown ?? value}</pre>
    </div>
  );
}

function Chev() {
  return <IconChevronRight size={14} className="cg2-chev" aria-hidden="true" />;
}

/** One key / screen in a sign-in flow ("/mcp" → "Authenticate" → "Allow on GitHub"). */
function K({ children, mono, ok }: { children: ReactNode; mono?: boolean; ok?: boolean }) {
  return (
    <span className="cg2-k" data-mono={mono || undefined} data-ok={ok || undefined}>
      {children}
    </span>
  );
}

const AllowOnGithub = () => (
  <K ok>
    <IconBrandGithub size={14} /> Allow on GitHub
  </K>
);

/* ------------------------------------------------------------------ tabs */

/** Agent tabs: the main agents, then "More" (the other agents the CLI supports, and any other MCP client). */
export function AgentTabs({ value, onChange, compact }: { value: AgentChoice; onChange: (v: AgentChoice) => void; compact?: boolean }) {
  const inMore = value === 'other' || MORE_AGENTS.some((a) => a.id === value);
  const moreLabel = value === 'other' ? 'Other agents' : inMore ? agentDef(value).label : 'More';
  return (
    <div className="cg2-tabs" role="tablist" aria-label="Coding agent" data-compact={compact || undefined}>
      {MAIN_AGENTS.map((a) => (
        <UnstyledButton key={a.id} role="tab" aria-selected={value === a.id} className="cg2-tab" data-active={value === a.id || undefined} onClick={() => onChange(a.id)} data-testid={`agent-tab-${a.id}`}>
          <AgentMark agent={a.id} size={16} />
          {a.label}
        </UnstyledButton>
      ))}
      {AGENT_DEFS.length > 1 && (
      <Menu position="bottom-end" withinPortal>
        <Menu.Target>
          <UnstyledButton role="tab" aria-selected={inMore} className="cg2-tab" data-more={!inMore || undefined} data-active={inMore || undefined} data-testid="agent-tab-more">
            {inMore && value !== 'other' ? <AgentMark agent={value} size={16} /> : <IconDots size={16} />}
            {moreLabel}
          </UnstyledButton>
        </Menu.Target>
        <Menu.Dropdown>
          {MORE_AGENTS.map((a) => (
            <Menu.Item key={a.id} leftSection={<AgentMark agent={a.id} size={14} />} onClick={() => onChange(a.id)} data-testid={`agent-more-${a.id}`}>
              {a.label}
            </Menu.Item>
          ))}
          <Menu.Divider />
          <Menu.Item leftSection={<IconPlugConnected size={14} />} onClick={() => onChange('other')} data-testid="agent-more-other">
            Other agents (any MCP client)
          </Menu.Item>
        </Menu.Dropdown>
      </Menu>
      )}
      {SUPPORT_NOTE && AGENT_DEFS.length === 1 && (
        <span className="cg2-faint" data-testid="agent-support-note" style={{ alignSelf: 'center', marginLeft: 8, fontSize: 12, opacity: 0.7 }}>
          {SUPPORT_NOTE}
        </span>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ install */

export function ShellToggle({ value, onChange, compact }: { value: InstallShell; onChange: (v: InstallShell) => void; compact?: boolean }) {
  return (
    <div className="cg2-seg" role="radiogroup" aria-label="Platform" data-compact={compact || undefined}>
      {(
        [
          ['sh', 'macOS / Linux', <IconBrandApple key="a" size={13} />],
          ['powershell', 'Windows', <IconBrandWindows key="w" size={13} />],
        ] as const
      ).map(([v, label, icon]) => (
        <UnstyledButton key={v} role="radio" aria-checked={value === v} data-on={value === v || undefined} onClick={() => onChange(v)}>
          {!compact && icon}
          {label}
        </UnstyledButton>
      ))}
    </div>
  );
}

/** The install one-liner for one agent (`--agents <id>`); `other` installs for every agent found. */
export function InstallBox({ base, projectId, choice, shell, onShell, oauthServer, compact }: { base: string; projectId: string; choice: AgentChoice; shell: InstallShell; onShell?: (s: InstallShell) => void; oauthServer: boolean; compact?: boolean }) {
  const flags = choice === 'other' ? '' : installFlags(agentDef(choice), oauthServer);
  const cmd = installCommand(base, projectId, shell, flags);
  const plain = flags ? cmd.slice(0, cmd.length - flags.length) : cmd;
  return (
    <div className="cg2-cmd">
      <div className="cg2-cmd-h">
        <IconTerminal2 size={14} />
        <span>{compact ? 'Terminal, in your code repository' : shell === 'powershell' ? 'PowerShell' : 'Terminal'}</span>
        <span className="cg2-sp" />
        {compact && onShell && <ShellToggle value={shell} onChange={onShell} compact />}
        <CopyBtn value={cmd} label="install command" title="Copied command" />
      </div>
      <pre className="cg2-pre cg2-cmd-pre">
        <span className="cg2-prompt" aria-hidden="true">
          {shell === 'powershell' ? 'PS> ' : '$ '}
        </span>
        <span data-testid="install-command">
          {plain}
          {flags && <span className="cg2-flags">{flags}</span>}
        </span>
      </pre>
    </div>
  );
}

/* ------------------------------------------------------------------ sign in */

export interface SignInContext {
  projectId: string;
  /** The specs repository (owner/repo), for "your agent gets your access to …". */
  repo?: string;
  access?: 'read' | 'write';
  /** Team server (agents sign in with GitHub); false: local server with a project key. */
  oauthServer: boolean;
}

const accessWords = (a?: 'read' | 'write') => (a === 'read' ? 'read only' : a === 'write' ? 'read and write' : 'read, and write if you can push');

/** Step 2, as the CLI prints it after "Next: sign in (once)". */
export function SignInStep({ choice, ctx }: { choice: AgentChoice; ctx: SignInContext }) {
  const name = serverName(ctx.projectId);
  const a = choice === 'other' ? null : agentDef(choice);
  const target = ctx.repo ? <span className="cg2-mono-strong">{ctx.repo}</span> : 'this project';
  const ask = (
    <div className="cg2-ask">
      <IconMessageCircle size={14} />
      <span>Then ask:</span>
      <q>{FIRST_PROMPT}</q>
      {a?.id === 'codex' && a.flowCommand && (
        <span className="np-faint">
          or run <span className="cg2-mono-sm">{a.flowCommand}</span>
        </span>
      )}
      <IconCopyBtn value={FIRST_PROMPT} label="first prompt" />
    </div>
  );
  if (!ctx.oauthServer) {
    const verify = a ? tokenEntry(a, { project: ctx.projectId, url: '', key: '' }).verify : 'Check the agent’s MCP server list.';
    return (
      <>
        <div className="cg2-desc">On this computer the installer gives {a?.label ?? 'your coding agent'} this project&apos;s key (in an environment variable, never in a repository). No sign-in needed.</div>
        <div className="cg2-check">
          <IconShieldCheck size={14} />
          <span>Check: {verify}</span>
        </div>
        {ask}
      </>
    );
  }
  if (!a) {
    return (
      <>
        <div className="cg2-desc">Agents that support MCP OAuth only need the MCP URL (under Advanced): they open GitHub sign-in on first use. For the others, create a personal token under Advanced and send it as <code>Authorization: Bearer &lt;token&gt;</code>.</div>
        {ask}
      </>
    );
  }
  if (!a.oauth) {
    return (
      <>
        <div className="cg2-desc">
          {a.label} can&apos;t sign in with GitHub by itself. Create a personal token under <b>Advanced</b> first; the installer asks for it (<code>--auth token</code>) and keeps it in <code>~/.mandate/env.sh</code>, never in a repository.
        </div>
        {a.manualMcp && (
          <div className="cg2-check">
            <IconShieldCheck size={14} />
            <span>{a.manualMcp}</span>
          </div>
        )}
        {ask}
      </>
    );
  }
  if (a.id === 'claude-code') {
    const channel = `mandate channel login --project ${ctx.projectId}`;
    return (
      <>
        <div className="cg2-desc" data-testid="signin-channel">
          <b>Event channel.</b> The installer opened your browser to approve this computer (confirm the code it printed, then <b>Approve</b>). That is what lets Mandate wake Claude Code. Missed it, or installed without a terminal? Run it again:
        </div>
        <div className="cg2-mini">
          <span className="cg2-prompt">$</span>
          <span className="cg2-mini-v">{channel}</span>
          <CopyBtn value={channel} label="channel login" tone="default" />
        </div>
        <ChannelStatus />
        <div className="cg2-desc">
          <b>Agent sign-in.</b> In Claude Code, sign in with GitHub. Your agent gets your access to {target}: {accessWords(ctx.access)}.
        </div>
        <div className="cg2-flow" data-testid="signin-flow">
          <K>
            <AgentMark agent="claude-code" size={14} /> Claude Code
          </K>
          <Chev />
          <K mono>/mcp</K>
          <Chev />
          <K mono>{name}</K>
          <Chev />
          <K>Authenticate</K>
          <Chev />
          <AllowOnGithub />
        </div>
        {ask}
      </>
    );
  }
  if (a.id === 'codex') {
    const login = `codex mcp login ${name}`;
    return (
      <>
        <div className="cg2-desc">Log Codex in to the Mandate server. Your browser opens GitHub; approve, then come back to the terminal.</div>
        <div className="cg2-mini">
          <span className="cg2-prompt">$</span>
          <span className="cg2-mini-v">{login}</span>
          <CopyBtn value={login} label="codex login" tone="default" />
        </div>
        <div className="cg2-flow" data-testid="signin-flow">
          <AllowOnGithub />
          <Chev />
          <K mono>codex mcp list</K>
          <span className="np-faint cg2-small">shows {name} logged in</span>
        </div>
        {ask}
      </>
    );
  }
  const reg = oauthRegistration(a, ctx.projectId, '');
  return (
    <>
      <div className="cg2-desc">
        {a.label} opens the sign-in page on first use of <span className="cg2-mono-strong">{name}</span>; choose Allow. Your agent gets your access to {target}: {accessWords(ctx.access)}.
      </div>
      <div className="cg2-flow" data-testid="signin-flow">
        <K>
          <AgentMark agent={a.id} size={14} /> {a.label}
        </K>
        <Chev />
        <K>
          first use of <span className="cg2-mono-sm">{name}</span>
        </K>
        <Chev />
        <AllowOnGithub />
      </div>
      {reg && (
        <div className="cg2-check">
          <IconShieldCheck size={14} />
          <span>Check: {reg.verify}</span>
        </div>
      )}
      {ask}
    </>
  );
}

/** Step 3 for Claude Code: start it with `mandate claude` so Mandate can wake it. */
export function StartClaudeStep() {
  const cmd = 'mandate claude';
  return (
    <>
      <div className="cg2-desc">
        Start Claude Code this way instead of plain <code>claude</code>. It loads the Mandate event channel, so an idle session is woken for requests you create in the web UI, answers to its questions, and comments addressed to it. Plain <code>claude</code> still works over MCP, but only sees these when it makes its next tool call.
      </div>
      <div className="cg2-mini" data-testid="start-claude">
        <span className="cg2-prompt">$</span>
        <span className="cg2-mini-v">{cmd}</span>
        <CopyBtn value={cmd} label="mandate claude" tone="default" />
      </div>
    </>
  );
}

/** Is this user's Claude Code connected to the event channel? (agents_presence: a stream = wakeable.) */
export function ChannelStatus() {
  const login = useAuth()?.user?.login?.toLowerCase();
  const presence = useAgentsPresence(undefined);
  const me = presence.data?.agents?.find((a) => a.id.toLowerCase() === `${login}/claude-code`);
  const yes = !!me && me.state !== 'offline' && me.wakeable;
  const text = yes
    ? 'Event channel connected: yes. Claude Code can be woken.'
    : me?.state === 'reconnecting'
      ? 'Event channel connected: reconnecting… (the server restarted; Claude Code reconnects on its next hook or tool call).'
      : me && me.state !== 'offline'
      ? `Event channel connected: no. Claude Code is connected over MCP only and can't be woken: ${WAKE_FIX}.`
      : 'Event channel connected: no (Claude Code has not connected yet, or is idle).';
  return (
    <div className="cg2-check" data-testid="channel-status" data-connected={yes ? 'yes' : 'no'}>
      <IconShieldCheck size={14} />
      <span>
        <Ticks text={text} />
      </span>
    </div>
  );
}

/** Getting started: "Then sign in once: /mcp → mandate-x → Authenticate → Allow on GitHub". */
export function SignInInline({ choice, ctx }: { choice: AgentChoice; ctx: SignInContext }) {
  const name = serverName(ctx.projectId);
  const a = choice === 'other' ? null : agentDef(choice);
  let keys: ReactNode[];
  if (!ctx.oauthServer) keys = [<span key="t" className="np-muted">no sign-in on this computer: the installer gives the agent this project&apos;s key</span>];
  else if (!a) keys = [<span key="t" className="np-muted">MCP OAuth clients open GitHub sign-in on first use; others need a personal token (connect guide)</span>];
  else if (!a.oauth) keys = [<span key="t" className="np-muted">{a.label} needs a personal token: create one in the connect guide (Advanced)</span>];
  else if (a.id === 'claude-code') keys = [<K key="1" mono>/mcp</K>, <K key="2" mono>{name}</K>, <K key="3">Authenticate</K>, <AllowOnGithub key="4" />];
  else if (a.id === 'codex') keys = [<K key="1" mono>{`codex mcp login ${name}`}</K>, <AllowOnGithub key="2" />];
  else keys = [<K key="1">first use of {name}</K>, <AllowOnGithub key="2" />];
  return (
    <div className="cg2-signin" data-testid="signin-inline">
      <span className="cg2-signin-lbl">{ctx.oauthServer ? 'Then sign in once:' : 'Then:'}</span>
      {keys.map((k, i) => (
        <Fragment key={i}>
          {i > 0 && <Chev />}
          {k}
        </Fragment>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ advanced */

function Sec({ icon, title, extra, children, testId }: { icon: ReactNode; title: string; extra?: ReactNode; children: ReactNode; testId?: string }) {
  return (
    <div className="cg2-sec" data-testid={testId}>
      <div className="cg2-sec-h">
        <span className="cg2-sec-ico">{icon}</span>
        {title}
        {extra && <span className="cg2-sec-extra">{extra}</span>}
      </div>
      {children}
    </div>
  );
}

function UrlField({ url }: { url: string }) {
  return (
    <TextInput
      label="MCP URL"
      value={url}
      readOnly
      mt={10}
      rightSection={
        <ActionIcon type="button" variant="subtle" color="gray" size="sm" aria-label="Copy MCP URL" onClick={() => void copyText(url, 'Copied URL')}>
          <IconCopy size={14} />
        </ActionIcon>
      }
      styles={{ input: { fontFamily: 'var(--mantine-font-family-monospace)', fontSize: 12.5 } }}
    />
  );
}

function FilesSection({ a }: { a: AgentDef | null }) {
  const redo = a ? `getmandate connect --agents ${a.id}` : 'getmandate connect';
  return (
    <Sec icon={<IconSparkles size={14} />} title="Skill, commands and instructions" testId="adv-files">
      <p className="cg2-p">
        The installer writes these files. To write them again: <code>{redo}</code>.
      </p>
      {a ? (
        <div className="cg2-files">
          <div className="cg2-frow">
            <span className="cg2-fk">
              <IconSparkles size={14} /> Skills
            </span>
            <span className="cg2-fv">
              {a.files.skills.join(', ')} <span className="np-faint">· mandate, mandate-bootstrap</span>
            </span>
          </div>
          <div className="cg2-frow">
            <span className="cg2-fk">
              <IconSlash size={14} /> Slash commands
            </span>
            <span className="cg2-fv">
              {a.files.commands ? (
                <>
                  {a.files.commands.dir} <span className="np-faint">· {a.files.commands.names}</span>
                </>
              ) : (
                <span className="np-faint">{a.files.commandsNote}</span>
              )}
            </span>
          </div>
          <div className="cg2-frow">
            <span className="cg2-fk">
              <IconFileText size={14} /> Instructions
            </span>
            <span className="cg2-fv">
              {a.files.instructions} <span className="np-faint">· a “Use Mandate” section, in your code repository</span>
            </span>
          </div>
        </div>
      ) : (
        <p className="cg2-p">
          It registers this MCP server with the coding agents it finds (Claude Code), installs the Mandate skill and slash commands, and adds a “Use Mandate” section to CLAUDE.md / AGENTS.md.
        </p>
      )}
    </Sec>
  );
}

function ChecksumUninstall({ base, projectId, shell, flags }: { base: string; projectId: string; shell: InstallShell; flags: string }) {
  return (
    <div className="cg2-sec" data-testid="install-verify">
      <div className="cg2-cols">
        <div>
          <div className="cg2-sec-h">
            <span className="cg2-sec-ico">
              <IconShieldCheck size={14} />
            </span>
            Verify the checksum first
          </div>
          <p className="cg2-p">Piping a script into a shell runs whatever the server sends. The script holds no token and pins the Mandate version and the SHA-256 of the CLI it installs. Read it before running:</p>
        </div>
        <div data-testid="install-uninstall">
          <div className="cg2-sec-h">
            <span className="cg2-sec-ico">
              <IconTrash size={14} />
            </span>
            Uninstall
          </div>
          <p className="cg2-p">
            Removes the agent wiring and the getmandate CLI from the machine. Add <code>--dry-run</code> to preview.
          </p>
        </div>
      </div>
      <Snip where={`${shell === 'sh' ? 'terminal' : 'PowerShell'} · verify`} value={verifyCommands(base, projectId, shell, flags)} label="verify commands" />
      <Snip where={`${shell === 'sh' ? 'terminal' : 'PowerShell'} · uninstall`} value={uninstallCommand(base, shell)} label="uninstall command" testId="uninstall-command" />
    </div>
  );
}

/** Team server: register by hand (MCP OAuth), personal tokens, files, checksum, uninstall. */
function AdvancedOAuth({ choice, projectId, url, access, base, shell }: { choice: AgentChoice; projectId: string; url: string; access?: 'read' | 'write'; base: string; shell: InstallShell }) {
  const a = choice === 'other' ? null : agentDef(choice);
  const reg = a?.oauth ? oauthRegistration(a, projectId, url) : null;
  const tokenGuide = a ? tokenEntry(a, { project: projectId, url, key: '<token>' }) : null;
  const env = keyEnvVar(projectId);
  const tokenSnippet = tokenGuide ? [tokenGuide.env ? `# ~/.zshrc or ~/.bashrc\n${tokenGuide.env}` : null, tokenGuide.register.code].filter(Boolean).join('\n\n') : genericSnippet({ project: projectId, url, key: '<token>' }).code;
  return (
    <>
      <Sec icon={<IconPlugConnected size={14} />} title="MCP server" testId="adv-mcp">
        <p className="cg2-p">
          {reg
            ? `Register the project's MCP server. ${a!.label} signs in with GitHub itself (MCP OAuth); no key in any file.`
            : a
              ? `Register the project's MCP server with a personal token (${a.label} can't sign in with GitHub by itself).`
              : 'Agents that support MCP OAuth only need this URL. For the others, create a personal token below and send it as Authorization: Bearer <token>.'}
        </p>
        <UrlField url={url} />
        <div className="cg2-note">
          <IconWorld size={13} /> {urlReachNote(url)}
        </div>
        {reg?.steps.map((s) => <Snip key={s.id} where={s.where} value={s.code} label={`${s.label} registration`} />)}
        {reg && (
          <div className="cg2-check">
            <IconShieldCheck size={14} />
            <span>Check: {reg.verify}</span>
          </div>
        )}
        {a?.manualMcp && (
          <div className="cg2-check">
            <IconShieldCheck size={14} />
            <span>{a.manualMcp}</span>
          </div>
        )}
      </Sec>
      <FilesSection a={a} />
      <Sec icon={<IconKey size={14} />} title="Personal token" extra="for agents that can't sign in with GitHub" testId="adv-tokens">
        <PersonalTokens projectId={projectId} url={url} access={access} agent={a?.id} bare />
        <Snip where={tokenGuide ? (tokenGuide.env ? `shell profile, then ${tokenGuide.register.where}` : tokenGuide.register.where) : "your coding agent's MCP config (user scope; never in a repository)"} value={tokenSnippet} label="token setup" />
        {tokenGuide && (
          <div className="cg2-check">
            <IconShieldCheck size={14} />
            <span>Check: {tokenGuide.verify}</span>
          </div>
        )}
        <p className="cg2-p cg2-small">
          The token goes in <code>{env}</code>; the installer keeps it in <code>~/.mandate/env.sh</code> with <code>--auth token</code>.
        </p>
      </Sec>
      <ChecksumUninstall base={base} projectId={projectId} shell={shell} flags={a ? installFlags(a, true) : ''} />
    </>
  );
}

/** Local server (project key): the key, the manual entry per agent, the CLI, the key commands, checksum, uninstall. */
function AdvancedKey({ choice, projectId, url, info, base, shell, compact }: { choice: AgentChoice; projectId: string; url: string; info: ConnectInfo; base: string; shell: InstallShell; compact?: boolean }) {
  const [revealed, setRevealed] = useState(false);
  const a = choice === 'other' ? null : agentDef(choice);
  const key = info.key?.value ?? '<key>';
  const shown = info.key ? (revealed ? key : info.key.masked || maskKey(key)) : '<key>';
  const real = a ? tokenEntry(a, { project: projectId, url, key }) : null;
  const display = a ? tokenEntry(a, { project: projectId, url, key: shown }) : null;
  const publicUrl = !isLoopbackUrl(url);
  return (
    <>
      <Sec icon={<IconPlugConnected size={14} />} title="MCP server" testId="adv-mcp">
        <p className="cg2-p">Register the project&apos;s MCP server with this project&apos;s key, kept in an environment variable so it stays out of config files.</p>
        <UrlField url={url} />
        {publicUrl && (
          <div className="cg2-note">
            <IconWorld size={13} /> {urlReachNote(url, true)}
          </div>
        )}
        {info.key ? (
          <TextInput
            mt={10}
            label={
              <Group gap={6} component="span">
                <IconKey size={13} /> Your personal token{' '}
                <Text span size="xs" c="dimmed">
                  (key {info.key.name}; your agents act as you)
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
                  <ActionIcon type="button" variant="subtle" color="gray" size="sm" aria-label={revealed ? 'Hide key' : 'Reveal key'} onClick={() => setRevealed((r) => !r)}>
                    {revealed ? <IconEyeOff size={14} /> : <IconEye size={14} />}
                  </ActionIcon>
                </Tooltip>
                <Tooltip label="Copy key">
                  <ActionIcon type="button" variant="subtle" color="gray" size="sm" aria-label="Copy key" onClick={() => void copyText(key, 'Copied key')}>
                    <IconCopy size={14} />
                  </ActionIcon>
                </Tooltip>
              </Group>
            }
            styles={{ input: { fontFamily: 'var(--mantine-font-family-monospace)', fontSize: 12.5 } }}
          />
        ) : (
          <Alert mt={10} color="yellow" icon={<IconKey size={16} />} title="No key for this project">
            Create one in a terminal: <Code>{info.cli.create}</Code>
          </Alert>
        )}
        {real && display ? (
          <>
            {display.env && <Snip where="shell profile (~/.zshrc, ~/.bashrc)" value={real.env!} shown={display.env} label={`${keyEnvVar(projectId)} export`} />}
            <Snip where={display.register.where} value={real.register.code} shown={display.register.code} label={`${a!.label} config`} />
            {display.register.note && <p className="cg2-p cg2-small">{display.register.note}</p>}
            <div className="cg2-check">
              <IconShieldCheck size={14} />
              <span>Check: {display.verify}</span>
            </div>
          </>
        ) : (
          <>
            <p className="cg2-p" style={{ marginTop: 10 }}>
              Most coding agents accept this mcpServers entry (Streamable HTTP + Authorization header). It contains your key: put it in your user-level config, never in a file you commit.
            </p>
            <Snip where={genericSnippet({ project: projectId, url, key: shown }).where} value={genericSnippet({ project: projectId, url, key }).code} shown={genericSnippet({ project: projectId, url, key: shown }).code} label="Generic JSON config" />
          </>
        )}
      </Sec>
      <FilesSection a={a} />
      <Sec icon={<IconTerminal2 size={14} />} title="Mandate CLI, in a repo on this machine" testId="adv-cli">
        <p className="cg2-p">Run it in the code repository your agent works in: the same wiring as the installer, with the CLI already installed.</p>
        <Snip where="terminal" value={connectCommand(projectId)} shown={`cd <your code repo> && ${connectCommand(projectId)}`} label="connect command" />
      </Sec>
      {!compact && (
        <Sec icon={<IconKey size={14} />} title="Project keys" testId="adv-keys">
          <p className="cg2-p">
            Keys live in <code>{info.keysFile}</code> (mode 0600) and never appear in URLs or logs. The web UI does not create or revoke keys; use the CLI:
          </p>
          <Group gap={6} mt={6}>
            {(['create', 'list', 'revoke'] as const).map((k) => (
              <Code key={k} className="connect-cli">
                {info.cli[k]}
              </Code>
            ))}
          </Group>
        </Sec>
      )}
      <ChecksumUninstall base={base} projectId={projectId} shell={shell} flags={a ? installFlags(a, false) : ''} />
    </>
  );
}

/** "Advanced: set it up manually" (collapsed): everything the installer does for this agent, by hand. */
export function AdvancedSetup(props: { choice: AgentChoice; projectId: string; url: string; info: ConnectInfo; shell: InstallShell; compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const { choice, projectId, url, info, shell } = props;
  const base = originOf(url);
  const label = choice === 'other' ? 'your coding agent' : agentDef(choice).label;
  return (
    <div className="cg2-adv" data-open={open || undefined} data-testid="connect-advanced">
      <UnstyledButton className="cg2-adv-h" aria-expanded={open} onClick={() => setOpen((o) => !o)} data-testid="connect-advanced-toggle">
        {open ? <IconChevronDown size={16} className="cg2-adv-chev" /> : <IconChevronRight size={16} className="cg2-adv-chev" />}
        <span>
          <span className="cg2-adv-t">Advanced: set it up manually</span>
          <span className="cg2-adv-d">{open ? `What the installer does for ${label}, step by step` : 'MCP server entry, skill and commands, personal token, checksum, uninstall'}</span>
        </span>
      </UnstyledButton>
      <Collapse expanded={open} transitionDuration={120}>
        {open && (
          <div className="cg2-adv-b">
            {info.auth === 'oauth' ? <AdvancedOAuth choice={choice} projectId={projectId} url={url} access={info.access} base={base} shell={shell} /> : <AdvancedKey {...props} base={base} />}
          </div>
        )}
      </Collapse>
    </div>
  );
}

/** All agent ids (tests, deep links). */
export const AGENT_IDS = AGENT_DEFS.map((a) => a.id);

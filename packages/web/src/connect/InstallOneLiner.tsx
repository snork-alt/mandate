import { useState } from 'react';
import { AgentTabs, InstallBox, originOf, SignInInline, type AgentChoice, type SignInContext } from './AgentSetup';
import { shellFor, type InstallShell } from './snippets';

/**
 * The compact per-agent installer (Getting started): agent tabs, the one-liner for that agent (`--agents <id>`; it
 * installs the getmandate CLI from this server, checksum-verified, then runs `getmandate connect`) with the
 * macOS / Linux | Windows toggle, and the sign-in in one line. The command holds no token; a team signs agents in with
 * GitHub (MCP OAuth). The full version, with Advanced, is the Connect dialog (ConnectAgentGuide).
 */
export function InstallOneLiner({
  projectId,
  mcpUrl,
  ctx,
  userAgent = typeof navigator === 'undefined' ? '' : navigator.userAgent,
  initialAgent = 'claude-code',
}: {
  projectId: string;
  mcpUrl: string;
  ctx?: SignInContext;
  userAgent?: string;
  initialAgent?: AgentChoice;
}) {
  const [shell, setShell] = useState<InstallShell>(shellFor(userAgent));
  const [choice, setChoice] = useState<AgentChoice>(initialAgent);
  const base = originOf(mcpUrl);
  if (!base) return null;
  const sign: SignInContext = ctx ?? { projectId, oauthServer: true };
  return (
    <div className="cg2-install" data-testid="install-oneliner">
      <AgentTabs value={choice} onChange={setChoice} compact />
      <InstallBox base={base} projectId={projectId} choice={choice} shell={shell} onShell={setShell} oauthServer={sign.oauthServer} compact />
      <SignInInline choice={choice} ctx={sign} />
    </div>
  );
}

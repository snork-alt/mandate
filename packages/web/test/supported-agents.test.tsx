// @vitest-environment jsdom
/** Only Claude Code is offered (SUPPORTED_AGENTS); the other agents stay in the catalog but are hidden. */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentTabs } from '../src/connect/AgentSetup';
import { ALL_AGENT_DEFS, AGENT_DEFS, MORE_AGENTS, visibleAgents } from '../src/connect/agentCatalog';
import { installDom, Wrap } from './dom';

afterEach(cleanup);

describe('supported agents', () => {
  it('the catalog keeps every agent but only Claude Code is visible', () => {
    expect(ALL_AGENT_DEFS.length).toBeGreaterThan(1);
    expect(AGENT_DEFS.map((a) => a.id)).toEqual(['claude-code']);
    expect(MORE_AGENTS).toEqual([]);
  });

  it('listing agents in the switch shows them again', () => {
    expect(visibleAgents(['claude-code', 'codex']).map((a) => a.id)).toEqual(['claude-code', 'codex']);
  });

  it('the tabs show only Claude Code, no More, and say what is supported', () => {
    installDom();
    render(
      <Wrap>
        <AgentTabs value="claude-code" onChange={() => undefined} />
      </Wrap>,
    );
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['Claude Code']);
    expect(screen.queryByTestId('agent-tab-codex')).toBeNull();
    expect(screen.queryByTestId('agent-tab-more')).toBeNull();
    expect(screen.getByTestId('agent-support-note').textContent).toContain('currently supports Claude Code');
  });
});

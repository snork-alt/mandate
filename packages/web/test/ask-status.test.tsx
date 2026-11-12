// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { AskStatusNotice } from '../src/components/ask/AskStatusNotice';
import type { AskModelStatus, AskStatus } from '../src/mcp/queries';

afterEach(cleanup);
describe('AskStatusNotice', () => {
  const base: AskStatus = { configured: false, default: null, models: [], missing: [] };
  const r1 = (s: Partial<AskStatus>) => render(<AskStatusNotice status={{ ...base, ...s }} />);
  const m = (o: Partial<AskModelStatus>): AskModelStatus => ({ id: 'opus', label: 'Opus 5.5', provider: 'anthropic', model: 'claude-opus-5-5', apiKeySet: false, configured: false, missing: ['apiKey'], ...o });
  it('nothing configured', () => {
    r1({ missing: ['provider', 'model'] });
    expect(screen.getByText(/configure a model in/)).toBeTruthy();
    expect(screen.getByText(/Provider/)).toBeTruthy();
    expect(screen.getByText(/Model name/)).toBeTruthy();
    expect(screen.getByLabelText('Copy Anthropic')).toBeTruthy();
    expect(screen.getByText(/localhost:11434\/v1/)).toBeTruthy();
    expect(screen.getByText(/apply without a restart/)).toBeTruthy();
  });
  it('models listed but none ready: one line per model with the reason', () => {
    r1({ default: 'opus', models: [m({ reason: 'set ANTHROPIC_API_KEY (environment or ~/.mandate/secrets.env)' }), m({ id: 'l', label: 'Local', provider: 'openai-compatible', model: 'llama', missing: ['baseUrl'] })] });
    expect(screen.getByText('Opus 5.5')).toBeTruthy();
    expect(screen.getByText(/set ANTHROPIC_API_KEY/)).toBeTruthy();
    expect(screen.getByText(/Base URL/)).toBeTruthy();
    expect(screen.queryByText(/Provider \(/)).toBeNull();
  });
  it('renders nothing once a model is configured', () => {
    const { container } = r1({ configured: true, default: 'opus', models: [m({ configured: true, missing: [], apiKeySet: true })] });
    expect(container.textContent).toBe('');
  });
  it('loading and error', () => {
    render(<AskStatusNotice />);
    expect(screen.getByText(/Checking/)).toBeTruthy();
    cleanup();
    render(<AskStatusNotice error="boom" />);
    expect(screen.getByRole('alert').textContent).toContain('boom');
  });
});

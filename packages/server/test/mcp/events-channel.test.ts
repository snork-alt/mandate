/** Smoke test: the real `mandate channel` process (packages/cli) against the real events endpoint emits notifications/claude/channel. */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newsFallback } from '../../src/news/index.js';
import { tempDir } from '../helpers.js';
import { mcpFixture, type McpFixture } from './fixture.js';

let fx: McpFixture;
beforeAll(async () => {
  fx = await mcpFixture();
}, 120_000);
afterAll(async () => fx?.close());

describe('mandate channel against the server', () => {
  it('initialize declares claude/channel; an event of the server becomes a channel notification', async () => {
    const home = await tempDir();
    const cli = path.resolve(__dirname, '../../../cli/src/cli.ts');
    const child = spawn(process.execPath, ['--import', 'tsx', cli, 'channel', '--project', 'test', '--url', fx.url.origin], {
      env: { ...process.env, HOME: home, MANDATE_HOME: path.join(home, '.mandate'), MANDATE_CHANNEL_FORCE: '1', MANDATE_CHANNEL_TOKEN: fx.served.key('test') },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const lines: any[] = [];
    let buf = '';
    child.stdout.on('data', (b: Buffer) => {
      buf += b.toString();
      for (let i; (i = buf.indexOf('\n')) >= 0; ) {
        const l = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (l.trim()) lines.push(JSON.parse(l));
      }
    });
    let err = '';
    child.stderr.on('data', (b: Buffer) => (err += b.toString()));
    const until = async (f: () => boolean, ms = 20_000) => {
      for (const t = Date.now(); !f() && Date.now() - t < ms; ) await new Promise((r) => setTimeout(r, 50));
      expect(f(), `stderr: ${err}`).toBe(true);
    };
    try {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-code', version: '2' } } })}\n`);
      await until(() => lines.some((l) => l.id === 1));
      expect(lines.find((l) => l.id === 1).result.capabilities.experimental).toEqual({ 'claude/channel': {} });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
      // let the stream connect, then an event for this client identity
      await new Promise((r) => setTimeout(r, 1500));
      const client = `claude-code/${fx.served.keys.list()[0]!.name}`;
      await newsFallback('test', fx.activity).addClientWide(client, 'flow_changed', 'mandate://projects/test', 'Mandate flow settings changed (test)');
      await until(() => lines.some((l) => l.method === 'notifications/claude/channel'));
      const n = lines.find((l) => l.method === 'notifications/claude/channel');
      expect(n.params.content).toContain('Mandate flow settings changed (test)');
      expect(n.params.meta).toMatchObject({ kind: 'flow_changed', ref: 'mandate://projects/test', project: 'test' });
    } finally {
      child.kill('SIGTERM');
    }
  }, 60_000);
});

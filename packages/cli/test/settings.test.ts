/** Mode settings in config.json (validated by the server schema), Host allow-list, reverse-proxy snippets. */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { loadConfig } from '../../server/src/config.js';
import { configFile } from '../src/context.js';
import { allowedHosts, publicUrlProblem, readSettings, writeSettings } from '../src/settings.js';
import { caddySnippet, nginxSnippet, sshTunnel } from '../src/proxy.js';
import { tempCtx, write } from './helpers.js';

const serverEnv = (ctx: ReturnType<typeof tempCtx>) => ({ HOME: ctx.home, MANDATE_HOME: ctx.mandateHome });

describe('config written per mode', () => {
  it('local: 127.0.0.1, no public URL, projects folder', () => {
    const ctx = tempCtx();
    writeSettings(ctx, { mode: 'local', port: 4300, bind: '127.0.0.1', trustProxy: false, baseDir: '~/mandate' });
    const j = JSON.parse(readFileSync(configFile(ctx), 'utf8'));
    expect(j.server).toEqual({ mode: 'local', port: 4300, bind: '127.0.0.1', trustProxy: false });
    expect(j.local).toEqual({ baseDir: '~/mandate' });
    const c = loadConfig(serverEnv(ctx));
    expect(c).toMatchObject({ mode: 'local', host: '127.0.0.1', port: 4300, publicUrl: 'http://localhost:4300', trustProxy: false });
    expect(readSettings(ctx)).toMatchObject({ mode: 'local', url: 'http://localhost:4300', configured: true });
  });

  it('server: public URL, bind, trustProxy; other keys kept; re-run switches back cleanly', () => {
    const ctx = tempCtx();
    write(configFile(ctx), `${JSON.stringify({ embedding: { provider: 'none' } }, null, 2)}\n`);
    writeSettings(ctx, { mode: 'server', port: 4000, bind: '127.0.0.1', publicUrl: 'https://mandate.example.com/', trustProxy: true });
    const j = JSON.parse(readFileSync(configFile(ctx), 'utf8'));
    expect(j.embedding).toEqual({ provider: 'none' });
    expect(j.server).toEqual({ mode: 'server', port: 4000, bind: '127.0.0.1', trustProxy: true, publicUrl: 'https://mandate.example.com' });
    const c = loadConfig(serverEnv(ctx));
    expect(c).toMatchObject({ mode: 'server', publicUrl: 'https://mandate.example.com', trustProxy: true });
    writeSettings(ctx, { mode: 'local', port: 4000, bind: '127.0.0.1', trustProxy: false });
    expect(JSON.parse(readFileSync(configFile(ctx), 'utf8')).server.publicUrl).toBeUndefined();
  });

  it('validates public URLs', () => {
    expect(publicUrlProblem('https://mandate.example.com')).toBeNull();
    expect(publicUrlProblem('mandate.example.com')).toMatch(/full URL/);
    expect(publicUrlProblem('https://x.com/mandate')).toMatch(/without a path/);
    expect(publicUrlProblem('ftp://x.com')).toMatch(/https/);
  });

  it('Host allow-list includes the public host (server) and loopback', () => {
    expect(allowedHosts({ publicUrl: 'https://Mandate.Example.com', bind: '0.0.0.0' })).toEqual(['localhost', '127.0.0.1', '[::1]', 'mandate.example.com']);
    expect(allowedHosts({ bind: '127.0.0.1' })).toEqual(['localhost', '127.0.0.1', '[::1]']);
  });
});

describe('reverse proxy snippets', () => {
  const input = { publicUrl: 'https://mandate.example.com', upstream: '127.0.0.1:4000' };
  it('Caddy: automatic HTTPS, SSE flushing, long timeouts', () => {
    const s = caddySnippet(input);
    expect(s).toContain('mandate.example.com {');
    expect(s).toContain('reverse_proxy 127.0.0.1:4000');
    expect(s).toContain('flush_interval -1');
    expect(s).toContain('read_timeout 24h');
  });
  it('nginx: no buffering, long timeouts, forwarded headers, http→https', () => {
    const s = nginxSnippet(input);
    for (const x of ['server_name mandate.example.com;', 'proxy_pass http://127.0.0.1:4000;', 'proxy_buffering off;', 'proxy_read_timeout 24h;', 'proxy_set_header X-Forwarded-Proto $scheme;', 'proxy_set_header Host $host;', 'return 301 https://']) expect(s).toContain(x);
  });
  it('SSH tunnel', () => expect(sshTunnel(4000, 'ada@host')).toBe('ssh -N -L 4000:localhost:4000 ada@host'));
});

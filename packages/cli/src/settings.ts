/**
 * The server address and how it listens, persisted in config.json (`server.bind|port|publicUrl|trustProxy`), as defined
 * by the server's config schema. Sign-in is always GitHub.
 * The older `server.users` / `server.mode` keys are ignored and dropped on the next write. Writes go through the
 * server's ConfigFile (atomic, 0600, unknown keys kept, validated against the same schema the server uses).
 */
import { existsSync, readFileSync } from 'node:fs';
import { ConfigFile } from '../../server/src/setup/files.js';
import { configFile, type Ctx } from './context.js';

export interface ServerSettings {
  port: number;
  /** Listen address (127.0.0.1 for localhost, or behind a reverse proxy). */
  bind: string;
  /** Where users and agents reach Mandate (https://mandate.example.com). Unset: http://localhost:<port>. */
  publicUrl?: string;
  /** Behind a reverse proxy (trust X-Forwarded-*). */
  trustProxy: boolean;
}

export const DEFAULT_PORT = 4000;

/** Validate a public URL; returns a problem or null. */
export function publicUrlProblem(v: string): string | null {
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    return 'enter a full URL, e.g. https://mandate.example.com';
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return 'the URL must start with https:// (or http://)';
  if (u.pathname !== '/' || u.search || u.hash) return 'use the bare origin, without a path (e.g. https://mandate.example.com)';
  return null;
}

export const normalizeUrl = (v: string) => new URL(v).origin;

/** Apply the settings to raw config JSON (other keys untouched). */
export function applySettings(json: Record<string, unknown>, s: ServerSettings): void {
  const server = { ...((json.server as Record<string, unknown>) ?? {}) };
  delete server.mode; // older settings: there is one setup (GitHub sign-in)
  delete server.users;
  server.port = s.port;
  server.bind = s.bind;
  server.trustProxy = s.trustProxy;
  if (s.publicUrl) server.publicUrl = normalizeUrl(s.publicUrl);
  else delete server.publicUrl;
  json.server = server;
}

/** Write the settings into config.json (created when missing). */
export function writeSettings(ctx: Ctx, s: ServerSettings): string {
  const file = new ConfigFile(configFile(ctx));
  file.patch(file.version(), (json) => applySettings(json, s));
  return file.file;
}

/** Persist only `server.port` (other keys untouched, so a fresh install still opens the setup wizard). */
export function savePort(ctx: Ctx, port: number): void {
  const file = new ConfigFile(configFile(ctx));
  file.patch(file.version(), (json) => {
    json.server = { ...((json.server as Record<string, unknown>) ?? {}), port };
  });
}

export interface CurrentSettings extends ServerSettings {
  /** The URL users and agents use (publicUrl, or http://localhost:<port>). */
  url: string;
  /** Loopback URL the CLI uses to talk to the local server. */
  localUrl: string;
  configured: boolean;
}

/** Read the settings (defaults when config.json is missing); env MANDATE_PORT overrides the port like the server. */
export function readSettings(ctx: Ctx): CurrentSettings {
  const f = configFile(ctx);
  let json: Record<string, any> = {};
  if (existsSync(f)) {
    try {
      json = JSON.parse(readFileSync(f, 'utf8')) as Record<string, any>;
    } catch {
      json = {};
    }
  }
  const server = (json.server ?? {}) as Record<string, any>;
  const envPort = Number(ctx.env.MANDATE_PORT ?? ctx.env.PORT);
  const port = Number.isInteger(envPort) && envPort > 0 ? envPort : typeof server.port === 'number' ? server.port : DEFAULT_PORT;
  const bind = ctx.env.MANDATE_HOST ?? server.bind ?? server.host ?? '127.0.0.1';
  const publicUrl = typeof server.publicUrl === 'string' ? server.publicUrl.replace(/\/+$/, '') : undefined;
  return {
    port,
    bind,
    publicUrl,
    trustProxy: server.trustProxy === true,
    url: publicUrl ?? `http://localhost:${port}`,
    localUrl: `http://127.0.0.1:${port}`,
    configured: !!(server.bind || server.publicUrl || server.users || server.mode),
  };
}

/** Hostnames the server must accept in Host (DNS-rebinding check): loopback + the public host. */
export function allowedHosts(s: Pick<ServerSettings, 'publicUrl' | 'bind'>): string[] {
  const hosts = new Set(['localhost', '127.0.0.1', '[::1]']);
  if (s.publicUrl) hosts.add(new URL(s.publicUrl).hostname.toLowerCase());
  if (s.bind && s.bind !== '0.0.0.0' && s.bind !== '::') hosts.add(s.bind.toLowerCase());
  return [...hosts];
}

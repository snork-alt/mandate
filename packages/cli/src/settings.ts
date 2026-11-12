/**
 * The deployment choice persisted in config.json (`server.mode|bind|port|publicUrl|trustProxy`, `local.baseDir`), as
 * defined by the server's config schema. Writes go through the server's ConfigFile (atomic, 0600, unknown keys kept,
 * validated against the same schema the server uses).
 */
import { existsSync, readFileSync } from 'node:fs';
import { ConfigFile } from '../../server/src/setup/files.js';
import { configFile, type Ctx } from './context.js';

export type Mode = 'local' | 'server';

export interface ServerSettings {
  mode: Mode;
  port: number;
  /** Listen address (127.0.0.1 in local mode). */
  bind: string;
  /** Server mode: where users and agents reach Mandate (https://mandate.example.com). */
  publicUrl?: string;
  /** Behind a reverse proxy (trust X-Forwarded-*). */
  trustProxy: boolean;
  /** Local mode: the projects folder (default ~/mandate). */
  baseDir?: string;
}

export const DEFAULT_PORT = 4000;
export const DEFAULT_BASE_DIR = '~/mandate';

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
  server.mode = s.mode;
  server.port = s.port;
  server.bind = s.bind;
  server.trustProxy = s.trustProxy;
  if (s.mode === 'server' && s.publicUrl) server.publicUrl = normalizeUrl(s.publicUrl);
  else delete server.publicUrl;
  json.server = server;
  if (s.mode === 'local') json.local = { ...((json.local as Record<string, unknown>) ?? {}), baseDir: s.baseDir ?? DEFAULT_BASE_DIR };
}

/** Write the settings into config.json (created when missing). */
export function writeSettings(ctx: Ctx, s: ServerSettings): string {
  const file = new ConfigFile(configFile(ctx));
  file.patch(file.version(), (json) => applySettings(json, s));
  return file.file;
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
  const mode: Mode = server.mode ?? (json.auth?.github ? 'server' : 'local');
  const envPort = Number(ctx.env.MANDATE_PORT ?? ctx.env.PORT);
  const port = Number.isInteger(envPort) && envPort > 0 ? envPort : typeof server.port === 'number' ? server.port : DEFAULT_PORT;
  const bind = ctx.env.MANDATE_HOST ?? server.bind ?? server.host ?? '127.0.0.1';
  const publicUrl = typeof server.publicUrl === 'string' ? server.publicUrl.replace(/\/+$/, '') : undefined;
  return {
    mode,
    port,
    bind,
    publicUrl,
    trustProxy: server.trustProxy === true,
    baseDir: json.local?.baseDir ?? DEFAULT_BASE_DIR,
    url: publicUrl ?? `http://localhost:${port}`,
    localUrl: `http://127.0.0.1:${port}`,
    configured: !!server.mode,
  };
}

/** Hostnames the server must accept in Host (DNS-rebinding check): loopback + the public host. */
export function allowedHosts(s: Pick<ServerSettings, 'publicUrl' | 'bind'>): string[] {
  const hosts = new Set(['localhost', '127.0.0.1', '[::1]']);
  if (s.publicUrl) hosts.add(new URL(s.publicUrl).hostname.toLowerCase());
  if (s.bind && s.bind !== '0.0.0.0' && s.bind !== '::') hosts.add(s.bind.toLowerCase());
  return [...hosts];
}

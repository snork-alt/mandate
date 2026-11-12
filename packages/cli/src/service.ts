/**
 * Background service: a launchd agent (macOS), a systemd --user unit (Linux), or, without either, a detached
 * process with a pid file. Generation is pure (snapshot-tested); control goes through an injectable runner.
 */
import { spawn, spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { logFile, type Ctx } from './context.js';

export const LAUNCHD_LABEL = 'dev.mandate.server';
export const SYSTEMD_UNIT = 'mandate.service';

export interface ServiceSpec {
  /** node binary (absolute). */
  node: string;
  /** dist/server.js (absolute). */
  entry: string;
  mandateHome: string;
  home: string;
  log: string;
  version: string;
  /** PATH for git (cli backend) and ssh. */
  path: string;
}

export function serviceSpec(ctx: Ctx, entry: string, version: string, node = process.execPath): ServiceSpec {
  const sysPath = ctx.env.PATH ?? '/usr/local/bin:/usr/bin:/bin';
  const nodeDir = path.dirname(node);
  return { node, entry, mandateHome: ctx.mandateHome, home: ctx.home, log: logFile(ctx), version, path: sysPath.split(':').includes(nodeDir) ? sysPath : `${nodeDir}:${sysPath}` };
}

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function launchdPlist(s: ServiceSpec): string {
  // MANDATE_SUPERVISED: launchd restarts the server when it exits non-zero (KeepAlive.SuccessfulExit = false), so it
  // may restart itself (exit 75) after a mode switch.
  const env: Record<string, string> = { HOME: s.home, MANDATE_HOME: s.mandateHome, MANDATE_SUPERVISED: '1', MANDATE_VERSION: s.version, NODE_ENV: 'production', PATH: s.path };
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- Managed by Mandate (mandate install / mandate uninstall). -->
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(s.node)}</string>
    <string>${xml(s.entry)}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${Object.entries(env)
  .map(([k, v]) => `    <key>${k}</key>\n    <string>${xml(v)}</string>`)
  .join('\n')}
  </dict>
  <key>WorkingDirectory</key>
  <string>${xml(s.mandateHome)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>5</integer>
  <key>StandardOutPath</key>
  <string>${xml(s.log)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(s.log)}</string>
</dict>
</plist>
`;
}

const sq = (v: string) => (/[\s"\\]/.test(v) ? `"${v.replace(/(["\\])/g, '\\$1')}"` : v);

export function systemdUnit(s: ServiceSpec): string {
  return `# Managed by Mandate (mandate install / mandate uninstall).
[Unit]
Description=Mandate specification server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${sq(s.node)} ${sq(s.entry)}
WorkingDirectory=${sq(s.mandateHome)}
Environment=${sq(`HOME=${s.home}`)}
Environment=${sq(`MANDATE_HOME=${s.mandateHome}`)}
Environment=MANDATE_SUPERVISED=1
Environment=${sq(`MANDATE_VERSION=${s.version}`)}
Environment=NODE_ENV=production
Environment=${sq(`PATH=${s.path}`)}
# Exit 75 = "restart me" (the server asks for it after a mode switch); on-failure covers it, listed explicitly.
Restart=on-failure
RestartForceExitStatus=75
RestartSec=2
StandardOutput=append:${s.log}
StandardError=append:${s.log}

[Install]
WantedBy=default.target
`;
}

export type Run = (cmd: string, args: string[]) => { code: number; stdout: string; stderr: string };
export const run: Run = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8' });
  return { code: r.status ?? (r.error ? 127 : 1), stdout: r.stdout ?? '', stderr: r.stderr ?? (r.error?.message ?? '') };
};

export type ServiceKind = 'launchd' | 'systemd' | 'process';

export interface ServiceManager {
  kind: ServiceKind;
  /** Where the definition lives (plist / unit / pid file). */
  file: string;
  installed(): boolean;
  install(spec: ServiceSpec): void;
  uninstall(): void;
  start(): void;
  stop(): void;
  running(): boolean;
}

const uid = () => (typeof process.getuid === 'function' ? process.getuid() : 0);

export function launchd(ctx: Ctx, r: Run = run): ServiceManager {
  const file = path.join(ctx.home, 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`);
  const target = `gui/${uid()}`;
  const loaded = () => r('launchctl', ['print', `${target}/${LAUNCHD_LABEL}`]).code === 0;
  const must = (res: ReturnType<Run>, what: string) => {
    if (res.code !== 0) throw new Error(`${what} failed: ${(res.stderr || res.stdout).trim()}`);
  };
  return {
    kind: 'launchd',
    file,
    installed: () => existsSync(file),
    install(spec) {
      mkdirSync(path.dirname(file), { recursive: true });
      mkdirSync(path.dirname(spec.log), { recursive: true });
      if (loaded()) r('launchctl', ['bootout', `${target}/${LAUNCHD_LABEL}`]);
      writeFileSync(file, launchdPlist(spec));
    },
    uninstall() {
      if (loaded()) r('launchctl', ['bootout', `${target}/${LAUNCHD_LABEL}`]);
      rmSync(file, { force: true });
    },
    start() {
      if (!loaded()) must(r('launchctl', ['bootstrap', target, file]), 'launchctl bootstrap');
      else must(r('launchctl', ['kickstart', '-k', `${target}/${LAUNCHD_LABEL}`]), 'launchctl kickstart');
    },
    stop() {
      if (loaded()) must(r('launchctl', ['bootout', `${target}/${LAUNCHD_LABEL}`]), 'launchctl bootout');
    },
    running() {
      const p = r('launchctl', ['print', `${target}/${LAUNCHD_LABEL}`]);
      return p.code === 0 && /state = running/.test(p.stdout);
    },
  };
}

export function systemd(ctx: Ctx, r: Run = run): ServiceManager {
  const file = path.join(ctx.env.XDG_CONFIG_HOME || path.join(ctx.home, '.config'), 'systemd', 'user', SYSTEMD_UNIT);
  const sc = (...a: string[]) => r('systemctl', ['--user', ...a]);
  const must = (res: ReturnType<Run>, what: string) => {
    if (res.code !== 0) throw new Error(`${what} failed: ${(res.stderr || res.stdout).trim()}`);
  };
  return {
    kind: 'systemd',
    file,
    installed: () => existsSync(file),
    install(spec) {
      mkdirSync(path.dirname(file), { recursive: true });
      mkdirSync(path.dirname(spec.log), { recursive: true });
      writeFileSync(file, systemdUnit(spec));
      must(sc('daemon-reload'), 'systemctl --user daemon-reload');
      must(sc('enable', SYSTEMD_UNIT), 'systemctl --user enable');
    },
    uninstall() {
      sc('disable', '--now', SYSTEMD_UNIT);
      rmSync(file, { force: true });
      sc('daemon-reload');
    },
    start: () => must(sc('restart', SYSTEMD_UNIT), 'systemctl --user restart'),
    stop: () => must(sc('stop', SYSTEMD_UNIT), 'systemctl --user stop'),
    running: () => sc('is-active', '--quiet', SYSTEMD_UNIT).code === 0,
  };
}

/** No service manager: a detached `node server.js` with a pid file (stopped by `mandate stop`). */
export function detached(ctx: Ctx, spec: () => ServiceSpec): ServiceManager {
  const file = path.join(ctx.mandateHome, 'server.pid');
  const pid = (): number | null => {
    try {
      const n = Number(readFileSync(file, 'utf8').trim());
      if (!Number.isInteger(n) || n <= 0) return null;
      process.kill(n, 0);
      return n;
    } catch {
      return null;
    }
  };
  return {
    kind: 'process',
    file,
    installed: () => true,
    install: () => undefined,
    uninstall() {
      this.stop();
    },
    start() {
      if (pid()) return;
      const s = spec();
      mkdirSync(path.dirname(s.log), { recursive: true });
      const fd = openSync(s.log, 'a');
      // Through the CLI's foreground supervisor (next to server.js) so the server can restart itself; else directly.
      const cli = path.join(path.dirname(s.entry), 'cli.js');
      const args = existsSync(cli) ? [cli, 'start', '--foreground'] : [s.entry];
      const child = spawn(s.node, args, {
        detached: true,
        stdio: ['ignore', fd, fd],
        cwd: s.mandateHome,
        env: { ...ctx.env, HOME: s.home, MANDATE_HOME: s.mandateHome, MANDATE_VERSION: s.version, NODE_ENV: 'production' },
      });
      closeSync(fd);
      child.unref();
      writeFileSync(file, `${child.pid}\n`);
    },
    stop() {
      const p = pid();
      if (p) process.kill(p, 'SIGTERM');
      rmSync(file, { force: true });
    },
    running: () => pid() !== null,
  };
}

/** The platform's service manager when `serviceKind` is supported (systemd: needs `systemctl --user`). */
export function platformService(ctx: Ctx, r: Run = run): ServiceManager | null {
  if (ctx.platform === 'darwin') return launchd(ctx, r);
  if (ctx.platform === 'linux' && r('systemctl', ['--user', '--version']).code === 0) return systemd(ctx, r);
  return null;
}

/** The manager in use: an installed launchd/systemd service, else the detached process. */
export function currentService(ctx: Ctx, spec: () => ServiceSpec, r: Run = run): ServiceManager {
  const p = platformService(ctx, r);
  return p && p.installed() ? p : detached(ctx, spec);
}

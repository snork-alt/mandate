import { describe, expect, it } from 'vitest';
import { launchd, launchdPlist, systemd, systemdUnit, type ServiceSpec } from '../src/service.js';
import { tempCtx } from './helpers.js';

const spec: ServiceSpec = {
  node: '/usr/local/bin/node',
  entry: '/usr/local/lib/node_modules/getmandate/dist/server.js',
  mandateHome: '/Users/ada/.mandate',
  home: '/Users/ada',
  log: '/Users/ada/.mandate/logs/server.log',
  version: '0.1.0',
  path: '/usr/local/bin:/usr/bin:/bin',
};

describe('service definitions', () => {
  it('launchd plist', () => expect(launchdPlist(spec)).toMatchSnapshot());
  it('systemd unit', () => expect(systemdUnit({ ...spec, home: '/home/ada', mandateHome: '/home/ada/.mandate', log: '/home/ada/.mandate/logs/server.log' })).toMatchSnapshot());
  it('escapes XML and quotes paths with spaces', () => {
    expect(launchdPlist({ ...spec, home: '/Users/a&b' })).toContain('/Users/a&amp;b');
    expect(systemdUnit({ ...spec, node: '/opt/my node/bin/node' })).toContain('ExecStart="/opt/my node/bin/node" /usr/local/lib');
  });
  it('control goes through launchctl / systemctl --user (never run for real in tests)', () => {
    const ctx = tempCtx('darwin');
    const calls: string[] = [];
    const fake = (cmd: string, args: string[]) => (calls.push(`${cmd} ${args.join(' ')}`), { code: cmd === 'launchctl' && args[0] === 'print' ? 113 : 0, stdout: '', stderr: '' });
    const l = launchd(ctx, fake);
    const local = { ...spec, log: `${ctx.home}/.mandate/logs/server.log` };
    l.install(local);
    l.start();
    expect(l.file).toBe(`${ctx.home}/Library/LaunchAgents/dev.mandate.server.plist`);
    expect(calls.at(-1)).toMatch(/^launchctl bootstrap gui\/\d+ .*dev\.mandate\.server\.plist$/);
    const lctx = tempCtx('linux');
    const s = systemd(lctx, fake);
    s.install({ ...spec, log: `${lctx.home}/.mandate/logs/server.log` });
    expect(calls.slice(-2)).toEqual(['systemctl --user daemon-reload', 'systemctl --user enable mandate.service']);
  });
});

/** The `mandate` command (npm package: see package.json `name`). */
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { main as keysMain } from '../../server/scripts/mandate.js';
import { bool, parseArgs } from './args.js';
import { cmdDoctor, cmdLogs, cmdOpen, cmdRestart, cmdSetupUrl, cmdStart, cmdStatus, cmdStop, cmdUpdate } from './commands.js';
import { cmdConnect } from './connect.js';
import { cmdBootstrap } from './bootstrap.js';
import { inventory, printInventory } from './inventory.js';
import { BIN, makeCtx, PKG_NAME, PKG_VERSION } from './context.js';
import { cmdInstall, cmdUninstall, type Runtime } from './install.js';
import { c, fail, Prompter, stdout, type Out } from './ui.js';

export const HELP = `${c.bold('mandate')} ${c.dim(`v${PKG_VERSION}`)} — specifications for coding agents

${c.bold('Get started')}
  npx ${PKG_NAME} install        set up Mandate (GitHub sign-in) and open the wizard
  ${BIN} connect                 in a code repo: link it to a Mandate project for your agents

${c.bold('Commands')}
  agents [--json]                  coding agents: detected, supported (MCP / skills / commands), installed
  install [--yes] [--public-url URL] [--port N] [--bind ADDR]
          [--behind-proxy|--no-behind-proxy] [--no-service] [--no-open] [--no-agents]
          [--agents a,b] [--agents-only] [--no-global] [--dry-run]
  connect [--project <id>] [--url <server>] [--agents a,b] [--remove] [--dry-run]
  start [--foreground] [--port N] · stop · restart · status [--json]
  logs [-f] [-n N]                 server log
  open [--print]                   open the UI (setup wizard, or a one-time sign-in link)
  setup-url                        print the one-time setup wizard link
  update                           npm install -g ${PKG_NAME}@latest, then restart
  doctor [--json] [--clean]        diagnostics (--clean: remove expired bootstrap notes)
  agents                           detected coding agents: what each supports and has installed
  bootstrap init|status|validate|clean   run folders for /mandate-bootstrap (notes stay in ~/.mandate)
  uninstall [--purge] [--dry-run]  remove the service and agent wiring (keeps ~/.mandate unless --purge)
  key create <project> [--name N] | key list | key revoke <id>
  session create <github-login> | session revoke <cookie>

Agents: claude-code, codex, cursor, vscode, gemini, windsurf, opencode.
`;

export async function run(argv: string[], env: NodeJS.ProcessEnv = process.env, out: Out = stdout, cwd = process.cwd()): Promise<number> {
  const a = parseArgs(argv);
  if (a.cmd === 'help' || a.cmd === '--help' || a.cmd === '-h' || bool(a, 'help')) {
    out.log(HELP);
    return 0;
  }
  if (a.cmd === '--version' || a.cmd === '-v' || a.cmd === 'version') {
    out.log(PKG_VERSION);
    return 0;
  }
  const ctx = { ...makeCtx(env, cwd), force: bool(a, 'force') };
  const interactive = !bool(a, 'yes') && !!process.stdin.isTTY && !!process.stdout.isTTY && !env.CI;
  const rt: Runtime = { ctx, out, prompt: new Prompter(interactive), dryRun: bool(a, 'dry-run') };
  switch (a.cmd) {
    case 'install':
      return cmdInstall(rt, a);
    case 'uninstall':
      return cmdUninstall(rt, a);
    case 'connect':
      return cmdConnect(rt, a);
    case 'start':
      return cmdStart(ctx, a, out);
    case 'stop':
      return cmdStop(ctx, a, out);
    case 'restart':
      return cmdRestart(ctx, a, out);
    case 'status':
      return cmdStatus(ctx, a, out);
    case 'logs':
      return cmdLogs(ctx, a, out);
    case 'open':
      return cmdOpen(ctx, a, out);
    case 'setup-url':
      return cmdSetupUrl(ctx, a, out);
    case 'update':
      return cmdUpdate(ctx, a, out);
    case 'doctor':
      return cmdDoctor(ctx, a, out);
    case 'agents': {
      const rows = inventory(ctx);
      if (bool(a, 'json')) out.log(JSON.stringify(rows, null, 2));
      else printInventory(rows, out);
      return 0;
    }
    case 'bootstrap':
      return cmdBootstrap(ctx, a, out);
    case 'key':
    case 'session':
      return keysMain([a.cmd, ...a.rest], { ...env, MANDATE_HOME: ctx.mandateHome }, (s) => out.log(s.replaceAll('npm run mandate --', BIN)));
    default:
      out.err(fail(`unknown command '${a.cmd}'`));
      out.log(HELP);
      return 2;
  }
}

const isMain = (() => {
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1] ?? '')).href;
  } catch {
    return false;
  }
})();

if (isMain) {
  run(process.argv.slice(2)).then(
    (code) => {
      if (code >= 0) process.exit(code);
    },
    (e: Error) => {
      process.stderr.write(`${fail(`${BIN}: ${e.message}`)}\n`);
      process.exit(1);
    },
  );
}

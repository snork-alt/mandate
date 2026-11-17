/** `mandate channel login --project <id>`: store the personal token the event stream uses (~/.mandate/channel/<id>.token, 0600). */
import { str, type Args } from './args.js';
import { BIN } from './context.js';
import { saveToken } from './events.js';
import type { Runtime } from './install.js';
import { c, fail, info, ok } from './ui.js';

export async function cmdChannelLogin(rt: Runtime, a: Args): Promise<number> {
  const { ctx, out } = rt;
  const project = str(a, 'project');
  if (!project || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(project)) {
    out.err(fail(`usage: ${BIN} channel login --project <id> [--token <personal token>]`));
    return 2;
  }
  const token = (ctx.env.MANDATE_CHANNEL_TOKEN || str(a, 'token') || (rt.prompt.interactive ? await rt.prompt.input(`Personal token for '${project}' (web UI → Connect agent → Personal tokens):`, '') : '')).trim();
  if (!/^mndp_\S{8,}$/.test(token)) {
    out.err(fail('expected a personal token (mndp_…): create one in the web UI under Connect agent → Personal tokens'));
    return 2;
  }
  const file = saveToken(ctx, project, token);
  out.log(ok(`token stored in ${file} (0600); it is sent only to your Mandate server, as the event stream's Bearer token`));
  out.log(info(`start Claude Code with ${c.cyan(`${BIN} claude`)}`));
  return 0;
}

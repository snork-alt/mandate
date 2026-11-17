/** Minimal argv parsing: `--flag`, `--no-flag`, `--key value`, `--key=value`, `-y`, `-f`, `-n N`. */
const VALUE_FLAGS = new Set(['for', 'auth', 'mode', 'public-url', 'port', 'bind', 'project', 'agents', 'lines', 'ssh', 'name', 'ttl-minutes', 'out', 'file', 'from', 'url', 'scope', 'run', 'stage', 'area', 'area-status', 'work-order', 'retention-days', 'days', 'push', 'token', 'consumer', 'format', 'since', 'client', 'timeout']);
const SHORT: Record<string, string> = { y: 'yes', f: 'follow', n: 'lines', h: 'help' };

export interface Args {
  cmd: string;
  positional: string[];
  flags: Record<string, string | boolean>;
  /** The raw args after the command (for pass-through commands). */
  rest: string[];
}

export function parseArgs(argv: string[]): Args {
  const [cmd = 'help', ...rest] = argv;
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split(/=(.*)/s, 2) as [string, string | undefined];
      if (v !== undefined) flags[k] = v;
      else if (k.startsWith('no-')) flags[k.slice(3)] = false;
      else if (VALUE_FLAGS.has(k) && i + 1 < rest.length && !rest[i + 1]!.startsWith('-')) flags[k] = rest[++i]!;
      else flags[k] = true;
    } else if (/^-[a-z]$/.test(a)) {
      const k = SHORT[a[1]!] ?? a[1]!;
      if (VALUE_FLAGS.has(k) && i + 1 < rest.length) flags[k] = rest[++i]!;
      else flags[k] = true;
    } else positional.push(a);
  }
  return { cmd, positional, flags, rest };
}

export const str = (a: Args, k: string): string | undefined => (typeof a.flags[k] === 'string' ? (a.flags[k] as string) : undefined);
export const bool = (a: Args, k: string, def = false): boolean => (a.flags[k] === undefined ? def : a.flags[k] === true || a.flags[k] === 'true');

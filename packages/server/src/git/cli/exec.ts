import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

/** Minimum git version the `cli` backend supports (`init --initial-branch`, porcelain v2, `--end-of-options`). */
export const MIN_GIT_VERSION: readonly [number, number] = [2, 30];

/** A failed git invocation; `message` includes git's (redacted) stderr. */
export class GitCliError extends Error {
  constructor(
    message: string,
    readonly command: string,
    readonly exitCode: number | null,
    readonly stderr: string,
  ) {
    super(message);
    this.name = 'GitCliError';
  }
}

/**
 * Remove credentials from text git printed: `scheme://user:pass@host` userinfo, `password=` / `token=` /
 * `Authorization:` values and any literal secret we passed to git (e.g. the HTTPS token).
 */
export function redact(text: string, secrets: readonly (string | undefined)[] = []): string {
  let out = text
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, '$1***@')
    .replace(/\b(password|passwd|token|secret|authorization)(\s*[=:]\s*)(?:(?:basic|bearer|token)\s+)?\S+/gi, '$1$2***');
  for (const s of secrets) if (s && s.length >= 3) out = out.split(s).join('***');
  return out;
}

export interface RunOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** Written to stdin (stdin is closed otherwise). */
  input?: string | Buffer;
  timeoutMs: number;
  /** Max bytes of stdout kept; the process is killed and the call fails beyond it. */
  maxBuffer: number;
  /** Exit codes that are returned instead of thrown (0 is always ok). */
  okCodes?: readonly number[];
  /** Literal secrets to scrub from error messages. */
  secrets?: readonly (string | undefined)[];
  /** Called for every complete stdout record (split on `separator`); return false to stop early (kills git). */
  onRecord?: (record: string) => boolean | void;
  separator?: string;
}

export interface RunResult {
  code: number;
  stdout: Buffer;
  stderr: string;
}

const MAX_STDERR = 64 * 1024;

/** Human-readable command for error messages (subcommand + args, `-c key=value` collapsed to the key). */
function describe(args: readonly string[], secrets: RunOptions['secrets']): string {
  const shown: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-c') {
      i++; // global config overrides: noise (and possibly helpers) in error messages
      continue;
    }
    shown.push(args[i]!.length > 120 ? `${args[i]!.slice(0, 117)}...` : args[i]!);
  }
  return redact(`git ${shown.join(' ')}`, secrets);
}

/**
 * Run git with an argument array (never a shell). Collects stdout up to `maxBuffer` (or streams
 * records to `onRecord`), enforces a timeout, and throws GitCliError with the redacted stderr.
 */
export function runGit(bin: string, args: readonly string[], opts: RunOptions): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const command = describe(args, opts.secrets);
    let child;
    try {
      child = spawn(bin, args as string[], {
        cwd: opts.cwd,
        env: opts.env,
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: false,
        windowsHide: true,
      });
    } catch (e) {
      reject(new GitCliError(`${command} failed to start: ${(e as Error).message}`, command, null, ''));
      return;
    }
    const out: Buffer[] = [];
    let outLen = 0;
    let stderr = '';
    let failure: Error | null = null;
    let stopped = false;
    let pending = '';
    const decoder = new StringDecoder('utf8');
    const sep = opts.separator ?? '\n';

    const kill = (err: Error | null) => {
      if (err && !failure) failure = err;
      child.kill('SIGKILL');
    };
    const timer = setTimeout(
      () => kill(new GitCliError(`${command} timed out after ${opts.timeoutMs} ms`, command, null, redact(stderr, opts.secrets))),
      opts.timeoutMs,
    );

    child.stdout.on('data', (chunk: Buffer) => {
      if (stopped) return;
      if (opts.onRecord) {
        pending += decoder.write(chunk);
        if (pending.length > opts.maxBuffer) return kill(new GitCliError(`${command}: record larger than ${opts.maxBuffer} bytes`, command, null, ''));
        let i: number;
        while ((i = pending.indexOf(sep)) >= 0) {
          const rec = pending.slice(0, i);
          pending = pending.slice(i + sep.length);
          if (opts.onRecord(rec) === false) {
            stopped = true;
            return kill(null);
          }
        }
        return;
      }
      outLen += chunk.length;
      if (outLen > opts.maxBuffer) return kill(new GitCliError(`${command}: output exceeded ${opts.maxBuffer} bytes`, command, null, ''));
      out.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < MAX_STDERR) stderr += chunk.toString('utf8').slice(0, MAX_STDERR - stderr.length);
    });
    child.stdin.on('error', () => {}); // git may exit before reading all input; the exit code tells
    child.on('error', (e: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      const msg =
        e.code === 'ENOENT'
          ? `git executable "${bin}" not found (set git.cliPath, or use git.backend "embedded")`
          : `${command} failed to start: ${e.message}`;
      reject(new GitCliError(msg, command, null, ''));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (failure) return reject(failure);
      if (stopped) return resolve({ code: 0, stdout: Buffer.alloc(0), stderr });
      pending += opts.onRecord ? decoder.end() : '';
      if (opts.onRecord && pending) opts.onRecord(pending);
      const exit = code ?? -1;
      if (exit !== 0 && !opts.okCodes?.includes(exit)) {
        const err = redact(stderr.trim(), opts.secrets);
        return reject(new GitCliError(`${command} failed (exit ${exit})${err ? `: ${err}` : ''}`, command, exit, err));
      }
      resolve({ code: exit, stdout: Buffer.concat(out), stderr });
    });
    if (opts.input !== undefined) child.stdin.end(opts.input);
    else child.stdin.end();
  });
}

/** Parse `git version 2.46.0` / `git version 2.39.3 (Apple Git-146)`. */
export function parseGitVersion(text: string): [number, number, number] | null {
  const m = /git version (\d+)\.(\d+)(?:\.(\d+))?/.exec(text);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)] : null;
}

const versionChecks = new Map<string, Promise<string>>();

/** Check that `bin` runs and is at least MIN_GIT_VERSION; resolves to the version string. Memoized per binary. */
export function checkGitCli(bin: string, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  let p = versionChecks.get(bin);
  if (!p) {
    p = (async () => {
      let text: string;
      try {
        text = (await runGit(bin, ['--version'], { cwd: process.cwd(), env, timeoutMs: 10_000, maxBuffer: 4096 })).stdout.toString();
      } catch (e) {
        throw new Error(`Mandate git backend "cli": ${(e as Error).message}`);
      }
      const v = parseGitVersion(text);
      const [maj, min] = MIN_GIT_VERSION;
      if (!v) throw new Error(`Mandate git backend "cli": could not parse the version of "${bin}" ("${text.trim()}")`);
      if (v[0] < maj || (v[0] === maj && v[1] < min)) {
        throw new Error(
          `Mandate git backend "cli" needs git >= ${maj}.${min}, but "${bin}" is ${v.join('.')}. ` +
            'Upgrade git, point git.cliPath at a newer binary, or set git.backend to "embedded".',
        );
      }
      return v.join('.');
    })();
    p.catch(() => versionChecks.delete(bin)); // retry next time
    versionChecks.set(bin, p);
  }
  return p;
}

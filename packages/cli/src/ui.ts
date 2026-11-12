/** Terminal output: colors (NO_COLOR / non-TTY aware), a spinner, and prompts that fall back to defaults. */
import { createInterface } from 'node:readline/promises';

const useColor = () => !process.env.NO_COLOR && (process.stdout.isTTY || !!process.env.FORCE_COLOR);
const wrap = (open: number, close: number) => (s: string) => (useColor() ? `\x1b[${open}m${s}\x1b[${close}m` : s);

export const c = {
  bold: wrap(1, 22),
  dim: wrap(2, 22),
  red: wrap(31, 39),
  green: wrap(32, 39),
  yellow: wrap(33, 39),
  blue: wrap(34, 39),
  magenta: wrap(35, 39),
  cyan: wrap(36, 39),
};

export interface Out {
  log(s?: string): void;
  err(s: string): void;
}

export const stdout: Out = {
  log: (s = '') => process.stdout.write(`${s}\n`),
  err: (s) => process.stderr.write(`${s}\n`),
};

export const ok = (s: string) => `${c.green('✔')} ${s}`;
export const warn = (s: string) => `${c.yellow('!')} ${s}`;
export const fail = (s: string) => `${c.red('✖')} ${s}`;
export const info = (s: string) => `${c.cyan('›')} ${s}`;
export const step = (n: number, total: number, s: string) => `${c.dim(`[${n}/${total}]`)} ${c.bold(s)}`;

/** A spinner on TTYs; plain lines elsewhere (CI, pipes, tests). */
export function spinner(text: string, out: Out = stdout) {
  const tty = process.stdout.isTTY && out === stdout;
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let i = 0;
  let current = text;
  const timer = tty ? setInterval(() => process.stdout.write(`\r${c.cyan(frames[i++ % frames.length]!)} ${current}\x1b[K`), 80) : null;
  const end = (line: string) => {
    if (timer) {
      clearInterval(timer);
      process.stdout.write(`\r${line}\x1b[K\n`);
    } else out.log(line);
  };
  return {
    update: (t: string) => {
      current = t;
    },
    succeed: (t = current) => end(ok(t)),
    warn: (t = current) => end(warn(t)),
    fail: (t = current) => end(fail(t)),
  };
}

/** Prompts: interactive only on a TTY and without `--yes`; otherwise the default is taken. */
export class Prompter {
  constructor(readonly interactive: boolean) {}

  private async ask(q: string): Promise<string> {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      return (await rl.question(q)).trim();
    } finally {
      rl.close();
    }
  }

  async confirm(q: string, def = true): Promise<boolean> {
    if (!this.interactive) return def;
    const a = (await this.ask(`${c.cyan('?')} ${q} ${c.dim(def ? '(Y/n)' : '(y/N)')} `)).toLowerCase();
    return a ? a.startsWith('y') : def;
  }

  async input(q: string, def = '', validate?: (v: string) => string | null): Promise<string> {
    if (!this.interactive) return def;
    for (;;) {
      const a = (await this.ask(`${c.cyan('?')} ${q}${def ? ` ${c.dim(`(${def})`)}` : ''} `)) || def;
      const problem = validate?.(a) ?? null;
      if (!problem) return a;
      process.stdout.write(`${warn(problem)}\n`);
    }
  }

  async select<T extends string>(q: string, choices: { value: T; label: string; hint?: string }[], def: T): Promise<T> {
    if (!this.interactive) return def;
    process.stdout.write(`${c.cyan('?')} ${q}\n`);
    choices.forEach((ch, i) => process.stdout.write(`  ${c.bold(String(i + 1))}) ${ch.label}${ch.value === def ? c.dim(' (default)') : ''}${ch.hint ? `\n     ${c.dim(ch.hint)}` : ''}\n`));
    for (;;) {
      const a = await this.ask(`  ${c.dim('choose 1-' + choices.length + ':')} `);
      if (!a) return def;
      const n = Number(a);
      const hit = Number.isInteger(n) ? choices[n - 1] : choices.find((ch) => ch.value === a);
      if (hit) return hit.value;
    }
  }
}

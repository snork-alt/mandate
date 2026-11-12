import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { GitCliError, redact } from './exec.js';

export interface GitObject {
  type: 'commit' | 'tree' | 'blob' | 'tag';
  content: Buffer;
}

interface Pending {
  oid: string;
  header?: { type: GitObject['type']; size: number };
  resolve: (o: GitObject | null) => void;
  reject: (e: Error) => void;
}

const OID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

/**
 * A long-lived `git cat-file --batch` process: reads objects by id with one round trip each instead of
 * one process per read. Only object ids are ever written to it (never paths or refs), so the line-based
 * protocol cannot be confused by unusual file names. The process is unref'd while idle, closed after
 * `idleMs` without requests, and restarted on demand after a crash or timeout.
 */
export class CatFile {
  private proc?: ChildProcessWithoutNullStreams;
  private queue: Pending[] = [];
  private chunks: Buffer[] = [];
  private len = 0;
  private stderr = '';
  private idleTimer?: NodeJS.Timeout;
  /** Fires when no object arrived for `timeoutMs` while reads are pending (a stall, not queue length). */
  private watchdog?: NodeJS.Timeout;

  constructor(
    private readonly bin: string,
    private readonly args: readonly string[],
    private readonly cwd: string,
    private readonly env: () => NodeJS.ProcessEnv,
    private readonly timeoutMs = 30_000,
    private readonly maxObjectBytes = 512 * 1024 * 1024,
    private readonly idleMs = 30_000,
  ) {}

  /** Read one object; null if it does not exist. */
  read(oid: string): Promise<GitObject | null> {
    if (!OID.test(oid)) return Promise.reject(new Error(`invalid object id '${oid}'`));
    return new Promise((resolve, reject) => {
      const proc = this.ensure();
      this.queue.push({ oid, resolve, reject });
      if (this.queue.length === 1) {
        this.setActive(true);
        this.arm();
      }
      proc.stdin.write(`${oid}\n`);
    });
  }

  /** Stop the process (pending reads fail). */
  close(): void {
    this.fail(new Error('git cat-file closed'));
  }

  private ensure(): ChildProcessWithoutNullStreams {
    if (this.proc) return this.proc;
    const proc = spawn(this.bin, [...this.args, 'cat-file', '--batch'], { cwd: this.cwd, env: this.env(), stdio: ['pipe', 'pipe', 'pipe'], shell: false, windowsHide: true });
    this.proc = proc;
    this.chunks = [];
    this.len = 0;
    this.stderr = '';
    proc.stdout.on('data', (c: Buffer) => this.onData(c));
    proc.stderr.on('data', (c: Buffer) => {
      if (this.stderr.length < 8192) this.stderr += c.toString('utf8');
    });
    proc.stdin.on('error', () => {});
    proc.on('error', (e: NodeJS.ErrnoException) => {
      if (this.proc === proc) this.fail(new GitCliError(`git cat-file failed to start: ${e.message}`, 'git cat-file --batch', null, ''));
    });
    proc.on('close', (code) => {
      if (this.proc !== proc) return;
      this.proc = undefined;
      if (this.queue.length) {
        const err = redact(this.stderr.trim());
        this.fail(new GitCliError(`git cat-file --batch exited (${code})${err ? `: ${err}` : ''}`, 'git cat-file --batch', code, err));
      }
    });
    return proc;
  }

  /** Keep the event loop alive only while reads are pending. */
  private setActive(active: boolean): void {
    const p = this.proc;
    if (!p) return;
    const m = active ? 'ref' : 'unref';
    p[m]();
    for (const s of [p.stdin, p.stdout, p.stderr] as unknown as { ref?: () => void; unref?: () => void }[]) s[m]?.();
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
    if (!active) {
      this.idleTimer = setTimeout(() => {
        if (!this.queue.length && this.proc === p) {
          this.proc = undefined;
          p.stdin.end();
        }
      }, this.idleMs);
      this.idleTimer.unref();
    }
  }

  private arm(): void {
    if (this.watchdog) clearTimeout(this.watchdog);
    this.watchdog = undefined;
    if (!this.queue.length) return;
    this.watchdog = setTimeout(() => {
      const oid = this.queue[0]?.oid;
      this.fail(new GitCliError(`git cat-file made no progress for ${this.timeoutMs} ms (reading ${oid})`, 'git cat-file --batch', null, ''));
    }, this.timeoutMs);
  }

  private flat(): Buffer {
    if (this.chunks.length > 1) this.chunks = [Buffer.concat(this.chunks)];
    return this.chunks[0] ?? Buffer.alloc(0);
  }

  private consume(n: number): void {
    const rest = this.flat().subarray(n);
    this.chunks = rest.length ? [rest] : [];
    this.len = rest.length;
  }

  private onData(chunk: Buffer): void {
    this.chunks.push(chunk);
    this.len += chunk.length;
    for (;;) {
      const p = this.queue[0];
      if (!p) {
        if (this.len) this.fail(new Error('git cat-file: unexpected output'));
        return;
      }
      if (!p.header) {
        const buf = this.flat();
        const nl = buf.indexOf(10);
        if (nl < 0) return;
        const line = buf.subarray(0, nl).toString('utf8');
        this.consume(nl + 1);
        const parts = line.split(' ');
        if (parts.length !== 3) {
          // `<oid> missing` (or `ambiguous`)
          this.done(p, null);
          continue;
        }
        const size = Number(parts[2]);
        if (size > this.maxObjectBytes) {
          this.fail(new Error(`git object ${p.oid} is larger than ${this.maxObjectBytes} bytes`));
          return;
        }
        p.header = { type: parts[1] as GitObject['type'], size };
      }
      if (this.len < p.header.size + 1) return;
      const content = Buffer.from(this.flat().subarray(0, p.header.size));
      this.consume(p.header.size + 1);
      this.done(p, { type: p.header.type, content });
    }
  }

  private done(p: Pending, obj: GitObject | null): void {
    this.queue.shift();
    p.resolve(obj);
    this.arm();
    if (!this.queue.length) this.setActive(false);
  }

  private fail(err: Error): void {
    const q = this.queue.splice(0);
    const proc = this.proc;
    this.proc = undefined;
    if (proc) proc.kill('SIGKILL');
    this.arm();
    for (const p of q) p.reject(err);
  }
}

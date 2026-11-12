/**
 * Setup probes ("Test" buttons): environment checks, GitHub OAuth App credentials, Ask providers (list models, tiny
 * prompt), Ollama embeddings, git access (system git with no prompts, or the embedded client with given credentials),
 * SSH public key fingerprints. Secrets are only sent to their provider; results and errors never contain them.
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { accessSync, constants, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { createGitStore } from '../git/index.js';
import type { RemoteAuth } from '../config.js';

const exec = promisify(execFile);
export type Fetch = typeof fetch;

export interface Check {
  id: string;
  label: string;
  ok: boolean;
  /** info: shown but not blocking. */
  level?: 'error' | 'warning' | 'info';
  detail: string;
  fix?: string;
}

/** Remove anything secret-looking (and the given literal secrets) from a message. */
export function scrub(msg: string, secrets: (string | undefined)[] = []): string {
  let m = msg;
  for (const s of secrets) if (s && s.length >= 4) m = m.split(s).join('***');
  return m
    .replace(/\/\/[^/@\s]*@/g, '//***@')
    .replace(/\b(sk-[A-Za-z0-9_-]{8,}|gh[opusr]_[A-Za-z0-9]{10,}|AIza[0-9A-Za-z_-]{20,})\b/g, '***')
    .slice(0, 300);
}

/* ------------------------------------------------------------------ environment */

export async function gitVersion(gitPath = 'git'): Promise<string | null> {
  try {
    const { stdout } = await exec(gitPath, ['--version'], { timeout: 5000 });
    return /(\d+\.\d+(?:\.\d+)?)/.exec(stdout)?.[1] ?? null;
  } catch {
    return null;
  }
}

async function gitConfigValue(key: string, gitPath = 'git'): Promise<string | null> {
  try {
    const { stdout } = await exec(gitPath, ['config', '--global', '--get', key], { timeout: 5000 });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

export async function systemGit(gitPath = 'git') {
  const [version, userName, userEmail] = await Promise.all([gitVersion(gitPath), gitConfigValue('user.name', gitPath), gitConfigValue('user.email', gitPath)]);
  return { version, userName, userEmail };
}

const atLeast = (v: string, min: [number, number]) => {
  const [a = 0, b = 0] = v.split('.').map(Number);
  return a > min[0] || (a === min[0] && b >= min[1]);
};

export interface CheckContext {
  home: string;
  localBaseDir: string;
  port: number;
  publicUrl: string;
  fetch?: Fetch;
}

export async function environmentChecks(c: CheckContext): Promise<Check[]> {
  const checks: Check[] = [];
  const v = await gitVersion();
  checks.push(
    v
      ? { id: 'git', label: 'git', ok: atLeast(v, [2, 30]), level: atLeast(v, [2, 30]) ? 'info' : 'warning', detail: `git ${v}`, ...(atLeast(v, [2, 30]) ? {} : { fix: 'Update git to 2.30 or newer (only needed for the system git backend).' }) }
      : { id: 'git', label: 'git', ok: false, level: 'warning', detail: 'git is not installed or not on PATH', fix: 'Install git (macOS: xcode-select --install; Debian/Ubuntu: sudo apt install git), or use the embedded git backend.' },
  );
  const writable = (dir: string) => {
    let d = dir;
    while (!existsSync(d) && path.dirname(d) !== d) d = path.dirname(d);
    try {
      accessSync(d, constants.W_OK);
      return true;
    } catch {
      return false;
    }
  };
  const dataDir = path.join(c.home, 'projects');
  checks.push(writable(dataDir) ? { id: 'dataDir', label: 'Data folder', ok: true, level: 'info', detail: `${dataDir} is writable` } : { id: 'dataDir', label: 'Data folder', ok: false, level: 'error', detail: `${dataDir} is not writable`, fix: `Pick another folder or fix permissions: chmod u+w ${path.dirname(dataDir)}` });
  checks.push({ id: 'port', label: 'Port', ok: true, level: 'info', detail: `listening on ${c.port}` });
  checks.push(
    process.env.MANDATE_SERVICE === '1'
      ? { id: 'service', label: 'Background service', ok: true, level: 'info', detail: 'running as a service' }
      : { id: 'service', label: 'Background service', ok: true, level: 'info', detail: 'running in the foreground', fix: 'Optional: mandate install keeps Mandate running after you close the terminal.' },
  );
  if (!/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(c.publicUrl)) checks.push(...(await serverChecks(c.publicUrl, c.fetch ?? fetch)));
  return checks;
}

/** On a server: the public URL is reachable from the server, over HTTPS with a valid certificate, and SSE is not buffered. */
export async function serverChecks(publicUrl: string, f: Fetch = fetch): Promise<Check[]> {
  const out: Check[] = [];
  let u: URL;
  try {
    u = new URL(publicUrl);
  } catch {
    return [{ id: 'publicUrl', label: 'Public URL', ok: false, level: 'error', detail: 'server.publicUrl is not a URL', fix: 'Set the public URL, e.g. https://mandate.example.com' }];
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  try {
    const r = await f(`${u.origin}/health`, { signal: AbortSignal.timeout(8000) });
    out.push(r.ok ? { id: 'publicUrl', label: 'Public URL', ok: true, level: 'info', detail: `${u.origin} answers` } : { id: 'publicUrl', label: 'Public URL', ok: false, level: 'error', detail: `${u.origin}/health answered ${r.status}`, fix: 'Check the reverse proxy routes / to Mandate.' });
  } catch (e) {
    const cert = /certificate|CERT_|self.signed|unable to verify/i.test(String((e as Error).cause ?? e));
    out.push({ id: 'publicUrl', label: 'Public URL', ok: false, level: 'error', detail: cert ? 'TLS certificate is not valid' : `${u.origin} is not reachable from the server`, fix: cert ? 'Use a certificate from a public CA (e.g. Let’s Encrypt via Caddy).' : 'Check DNS, the firewall and the reverse proxy.' });
  }
  out.push(u.protocol === 'https:' ? { id: 'https', label: 'HTTPS', ok: true, level: 'info', detail: 'served over HTTPS (session cookies are Secure)' } : { id: 'https', label: 'HTTPS', ok: local, level: local ? 'warning' : 'error', detail: local ? 'plain http on localhost (fine for an SSH tunnel)' : 'plain http: sessions and keys would travel unencrypted', fix: 'Put Mandate behind HTTPS (Caddy / nginx + Let’s Encrypt) and set server.publicUrl to the https URL.' });
  try {
    const t0 = Date.now();
    const r = await f(`${u.origin}/health/sse`, { signal: AbortSignal.timeout(8000), headers: { accept: 'text/event-stream' } });
    const reader = r.body?.getReader();
    const first = reader ? await reader.read() : null;
    const ms = Date.now() - t0;
    await reader?.cancel().catch(() => undefined);
    const ok = !!first?.value && ms < 1200;
    out.push(ok ? { id: 'sse', label: 'Live updates (SSE)', ok: true, level: 'info', detail: `first event after ${ms} ms` } : { id: 'sse', label: 'Live updates (SSE)', ok: false, level: 'warning', detail: `events are buffered (${ms} ms)`, fix: 'Disable proxy buffering for Mandate (nginx: proxy_buffering off; Caddy: flush_interval -1).' });
  } catch {
    out.push({ id: 'sse', label: 'Live updates (SSE)', ok: false, level: 'warning', detail: 'could not open the event stream', fix: 'Allow long-lived responses through the proxy (timeouts >= 1 h) and disable buffering.' });
  }
  return out;
}

/* ------------------------------------------------------------------ GitHub OAuth App credentials */

/**
 * Valid client id + secret: GitHub's "check a token" endpoint authenticates the app with basic auth; with a dummy
 * token it answers 404 (credentials OK, token unknown) or 401 (bad id / secret).
 */
export async function testGithubApp(clientId: string, secret: string, f: Fetch = fetch, api = 'https://api.github.com'): Promise<{ ok: boolean; message: string }> {
  try {
    const r = await f(`${api}/applications/${encodeURIComponent(clientId)}/token`, {
      method: 'POST',
      headers: { Authorization: `Basic ${Buffer.from(`${clientId}:${secret}`).toString('base64')}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', 'User-Agent': 'mandate' },
      body: JSON.stringify({ access_token: 'mandate-setup-check-0000000000000000' }),
      signal: AbortSignal.timeout(10_000),
    });
    if (r.status === 404 || r.status === 422) return { ok: true, message: 'GitHub accepted the client id and secret.' };
    if (r.status === 401) return { ok: false, message: 'GitHub rejected the client id or secret: copy them again from the OAuth App page (generate a new secret if needed).' };
    return { ok: false, message: `GitHub answered ${r.status}; try again.` };
  } catch (e) {
    return { ok: false, message: `Could not reach GitHub: ${scrub((e as Error).message, [secret])}` };
  }
}

/* ------------------------------------------------------------------ Ask providers */

export type AskProvider = 'anthropic' | 'openai' | 'google' | 'openai-compatible';
export interface ProviderInput {
  provider: AskProvider;
  baseUrl?: string | null;
  apiKey?: string;
  model?: string;
}

const BASE: Record<AskProvider, string> = {
  anthropic: 'https://api.anthropic.com/v1',
  openai: 'https://api.openai.com/v1',
  google: 'https://generativelanguage.googleapis.com/v1beta',
  'openai-compatible': 'http://localhost:11434/v1',
};

function headersFor(p: ProviderInput): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  if (p.provider === 'anthropic') {
    if (p.apiKey) h['x-api-key'] = p.apiKey;
    h['anthropic-version'] = '2023-06-01';
  } else if (p.provider === 'google') {
    if (p.apiKey) h['x-goog-api-key'] = p.apiKey;
  } else if (p.apiKey) h.Authorization = `Bearer ${p.apiKey}`;
  return h;
}

const SUGGEST: Record<AskProvider, RegExp[]> = {
  anthropic: [/sonnet/, /opus/, /haiku/],
  openai: [/^gpt-[\d.]+$/, /^gpt-[\d.]+-mini$/, /^gpt/, /^o\d/],
  google: [/gemini-[\d.]+-pro$/, /gemini.*flash$/, /gemini/],
  'openai-compatible': [/llama|qwen|mistral|gemma|gpt/],
};

export function suggestModel(provider: AskProvider, models: string[]): string | null {
  for (const re of SUGGEST[provider]) {
    const hit = models.find((m) => re.test(m));
    if (hit) return hit;
  }
  return models[0] ?? null;
}

export async function listModels(p: ProviderInput, f: Fetch = fetch): Promise<{ ok: boolean; models: string[]; suggested: string | null; message: string }> {
  const base = (p.baseUrl || BASE[p.provider]).replace(/\/+$/, '');
  if (p.provider !== 'openai-compatible' && !p.apiKey) return { ok: false, models: [], suggested: null, message: 'Enter the API key first.' };
  try {
    const r = await f(`${base}/models`, { headers: headersFor(p), signal: AbortSignal.timeout(15_000) });
    if (r.status === 401 || r.status === 403) return { ok: false, models: [], suggested: null, message: 'The provider rejected the API key.' };
    if (!r.ok) return { ok: false, models: [], suggested: null, message: `The provider answered ${r.status}.` };
    const j = (await r.json()) as { data?: { id: string }[]; models?: { name: string; supportedGenerationMethods?: string[] }[] };
    const models =
      p.provider === 'google'
        ? (j.models ?? []).filter((m) => !m.supportedGenerationMethods || m.supportedGenerationMethods.includes('generateContent')).map((m) => m.name.replace(/^models\//, ''))
        : (j.data ?? []).map((m) => m.id);
    models.sort();
    return { ok: true, models, suggested: suggestModel(p.provider, models), message: `${models.length} models available.` };
  } catch (e) {
    return { ok: false, models: [], suggested: null, message: `Could not reach ${base}: ${scrub((e as Error).message, [p.apiKey])}` };
  }
}

/** A tiny prompt (a few output tokens) to prove the model answers. */
export async function testModel(p: ProviderInput, f: Fetch = fetch): Promise<{ ok: boolean; message: string; ms: number }> {
  const base = (p.baseUrl || BASE[p.provider]).replace(/\/+$/, '');
  const t0 = Date.now();
  if (!p.model) return { ok: false, message: 'Pick a model first.', ms: 0 };
  const prompt = 'Reply with the single word OK.';
  const req =
    p.provider === 'anthropic'
      ? { url: `${base}/messages`, body: { model: p.model, max_tokens: 8, messages: [{ role: 'user', content: prompt }] } }
      : p.provider === 'google'
        ? { url: `${base}/models/${encodeURIComponent(p.model)}:generateContent`, body: { contents: [{ parts: [{ text: prompt }] }], generationConfig: { maxOutputTokens: 8 } } }
        : { url: `${base}/chat/completions`, body: { model: p.model, max_tokens: 8, messages: [{ role: 'user', content: prompt }] } };
  try {
    const r = await f(req.url, { method: 'POST', headers: headersFor(p), body: JSON.stringify(req.body), signal: AbortSignal.timeout(60_000) });
    const ms = Date.now() - t0;
    if (r.ok) return { ok: true, message: `${p.model} answered in ${ms} ms.`, ms };
    const text = scrub(await r.text().catch(() => ''), [p.apiKey]);
    if (r.status === 401 || r.status === 403) return { ok: false, message: 'The provider rejected the API key.', ms };
    if (r.status === 404) return { ok: false, message: `Unknown model ${p.model}.`, ms };
    return { ok: false, message: `The provider answered ${r.status}${text ? `: ${text.slice(0, 160)}` : ''}`, ms };
  } catch (e) {
    return { ok: false, message: `Could not reach ${base}: ${scrub((e as Error).message, [p.apiKey])}`, ms: Date.now() - t0 };
  }
}

/* ------------------------------------------------------------------ embeddings (Ollama) */

export const OLLAMA = 'http://localhost:11434';
export function ollamaInstall(platform = process.platform): string[] {
  return [platform === 'darwin' ? 'brew install ollama   # or download from https://ollama.com/download' : 'curl -fsSL https://ollama.com/install.sh | sh', 'ollama serve   # if it is not running as a service', 'ollama pull nomic-embed-text'];
}

export async function detectOllama(f: Fetch = fetch, base = OLLAMA) {
  try {
    const r = await f(`${base}/api/tags`, { signal: AbortSignal.timeout(3000) });
    const j = (await r.json()) as { models?: { name: string }[] };
    const models = (j.models ?? []).map((m) => m.name);
    return { ollama: r.ok, baseUrl: `${base}/v1`, models, hasNomic: models.some((m) => m.startsWith('nomic-embed-text')), install: ollamaInstall() };
  } catch {
    return { ollama: false, baseUrl: `${base}/v1`, models: [] as string[], hasNomic: false, install: ollamaInstall() };
  }
}

export async function testEmbedding(baseUrl: string, model: string, f: Fetch = fetch): Promise<{ ok: boolean; dimensions: number | null; message: string }> {
  try {
    const r = await f(`${baseUrl.replace(/\/+$/, '')}/embeddings`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model, input: 'search_document: hello' }), signal: AbortSignal.timeout(30_000) });
    if (!r.ok) return { ok: false, dimensions: null, message: r.status === 404 ? `Model ${model} is not installed: ollama pull ${model}` : `The embeddings endpoint answered ${r.status}.` };
    const j = (await r.json()) as { data?: { embedding: number[] }[] };
    const dims = j.data?.[0]?.embedding.length ?? 0;
    return dims ? { ok: true, dimensions: dims, message: `${model} works (${dims} dimensions).` } : { ok: false, dimensions: null, message: 'No embedding in the response.' };
  } catch (e) {
    return { ok: false, dimensions: null, message: `Could not reach ${baseUrl}: ${scrub((e as Error).message)}` };
  }
}

/* ------------------------------------------------------------------ git access */

/** System git: `ls-remote` with no prompts (GIT_TERMINAL_PROMPT=0, ssh BatchMode=yes), 20 s. */
export async function testGitSystem(url: string, gitPath = 'git'): Promise<{ ok: boolean; message: string; args: string[]; env: Record<string, string> }> {
  const args = ['-c', 'credential.interactive=never', 'ls-remote', '--heads', '--', url];
  const env = { GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: 'ssh -o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new', GCM_INTERACTIVE: 'never' };
  try {
    const { stdout } = await exec(gitPath, args, { timeout: 20_000, env: { ...process.env, ...env } });
    const n = stdout.split('\n').filter(Boolean).length;
    return { ok: true, message: `Access works (${n} branch${n === 1 ? '' : 'es'}).`, args, env };
  } catch (e) {
    const err = e as Error & { stderr?: string; killed?: boolean };
    const msg = scrub(err.stderr || err.message);
    const hint = /Permission denied \(publickey\)/.test(msg) ? ' Add your SSH key to the host (ssh-add, or the key in your account settings).' : /could not read Username|Authentication failed|terminal prompts disabled/i.test(msg) ? ' Configure a credential helper or use an SSH URL.' : '';
    return { ok: false, message: `${err.killed ? 'Timed out.' : msg}${hint}`, args, env };
  }
}

/** Embedded git: fetch into a throwaway repository with the given credentials. */
export async function testGitEmbedded(url: string, auth: RemoteAuth | undefined): Promise<{ ok: boolean; message: string }> {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'mandate-git-test-'));
  try {
    const git = createGitStore({ dataDir: dir, author: { name: 'Mandate', email: 'mandate@localhost' }, remote: { url, branch: 'main', auth }, git: { backend: 'embedded' } });
    await git.init();
    await Promise.race([git.fetch(), new Promise((_, rej) => setTimeout(() => rej(new Error('timed out')), 20_000))]);
    return { ok: true, message: 'Access works with these credentials.' };
  } catch (e) {
    const secrets = auth?.type === 'https' ? [auth.token] : auth?.type === 'ssh' ? [auth.passphrase] : [];
    return { ok: false, message: scrub((e as Error).message, secrets) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Default SSH keys present in ~/.ssh (paths only). */
export function defaultSshKeys(home = os.homedir()): string[] {
  return ['id_ed25519', 'id_ecdsa', 'id_rsa'].map((n) => path.join(home, '.ssh', n)).filter((p) => existsSync(p));
}

/** The PUBLIC key next to a private key path (`<path>.pub`) and its SHA256 fingerprint. Never reads the private key. */
export function publicKeyInfo(privateKeyPath: string): { publicKey: string; fingerprint: string; publicKeyPath: string } | null {
  const pub = `${privateKeyPath}.pub`;
  if (!existsSync(pub)) return null;
  const text = readFileSync(pub, 'utf8').trim();
  const m = /^(ssh-[a-z0-9-]+|ecdsa-[a-z0-9-]+|sk-[a-z0-9@.-]+)\s+([A-Za-z0-9+/=]+)/.exec(text);
  if (!m) return null;
  const fp = createHash('sha256').update(Buffer.from(m[2]!, 'base64')).digest('base64').replace(/=+$/, '');
  return { publicKey: text, fingerprint: `SHA256:${fp}`, publicKeyPath: pub };
}

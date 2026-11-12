/**
 * `mandate bootstrap …`: run folders for the /mandate-bootstrap pipeline. Notes are raw extract observations; they
 * live only in `~/.mandate/bootstrap/<project>/<runId>/` (mode 0700), never in the code or Mandate repositories, and
 * are removed `retentionDays` (default 14) after the run is done (`mandate bootstrap clean`, `mandate doctor --clean`,
 * and automatically on `mandate start`).
 *   init <project> [--scope a,b] [<area>=<paths,…> …] [--retention-days N]
 *   status <runId> [--stage S] [--area <id> --area-status S] [--work-order <ref>]
 *   validate <runId>
 *   clean [--days N] [--dry-run]
 */
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { NOTE_TYPES } from '../../server/src/mcp/bootstrap.js';
import { bool, str, type Args } from './args.js';
import type { Ctx } from './context.js';
import { c, fail, info, ok, type Out } from './ui.js';

export const DEFAULT_RETENTION_DAYS = 14;
export const STAGES = ['setup', 'extract', 'distill', 'review', 'done'] as const;
export const AREA_STATUSES = ['pending', 'extracting', 'extracted', 'distilled', 'reviewed'] as const;
const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const CODE_REF = /^[A-Za-z0-9_.-]+:[^#\s:][^#\s]*(?:#L\d+(?:-L?\d+)?)?$/;

export const manifestSchema = z
  .object({
    version: z.literal(1),
    runId: z.string().regex(/^\d{8}-\d{6}-[0-9a-f]{4}$/),
    project: z.string().regex(ID),
    repo: z.string().min(1),
    scope: z.array(z.string().min(1)).default([]),
    stage: z.enum(STAGES),
    areas: z.array(
      z
        .object({
          id: z.string().regex(ID, 'area ids are kebab-case'),
          paths: z.array(z.string().min(1)).default([]),
          status: z.enum(AREA_STATUSES),
          notes: z.string().regex(/^notes\/[a-z0-9-]+\.jsonl$/),
          updatedAt: z.string().min(1),
        })
        .strict(),
    ),
    workOrder: z.string().min(1).optional(),
    retentionDays: z.number().int().min(0).max(3650).default(DEFAULT_RETENTION_DAYS),
    createdAt: z.string().min(1),
    updatedAt: z.string().min(1),
    completedAt: z.string().min(1).optional(),
  })
  .strict();
export type Manifest = z.infer<typeof manifestSchema>;

const base = {
  area: z.string().regex(ID, 'area must be a manifest area id'),
  statement: z.string().trim().min(3).max(2000),
  evidence: z.array(z.string().regex(CODE_REF, 'evidence is a code ref repo:path#Lx-Ly (or a doc path for doc_claim)')).min(1).max(50),
  confidence: z.enum(['low', 'med', 'high']),
};
/** One extract note (a line of notes/<area>.jsonl). */
export const noteSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('component_candidate'), ...base, name: z.string().min(1).max(100), paths: z.array(z.string().min(1)).min(1) }).strict(),
  z.object({ type: z.literal('convention'), ...base, conforming: z.number().int().min(0), violating: z.number().int().min(0) }).strict(),
  z.object({ type: z.literal('behavior'), ...base }).strict(),
  z.object({ type: z.literal('test'), ...base, test: z.string().min(1).max(500), command: z.string().min(1).max(500).optional() }).strict(),
  z.object({ type: z.literal('dependency'), ...base, from: z.string().min(1), to: z.string().min(1) }).strict(),
  z.object({ type: z.literal('api_surface'), ...base }).strict(),
  z.object({ type: z.literal('data_model'), ...base }).strict(),
  z.object({ type: z.literal('doc_claim'), ...base, evidence: z.array(z.string().min(1)).min(1).max(50) }).strict(),
  z.object({ type: z.literal('question'), ...base, question: z.string().min(3).max(1000) }).strict(),
]);
// Keep the skill's documented type list and the validator in sync.
if (noteSchema.options.length !== NOTE_TYPES.length) throw new Error('note types out of sync with the skill');

export const bootstrapRoot = (ctx: Ctx) => path.join(ctx.mandateHome, 'bootstrap');
const now = () => new Date().toISOString();

export function newRunId(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${randomBytes(2).toString('hex')}`;
}

/** Every run folder: { dir, manifest | error }. */
export function listRuns(ctx: Ctx): { dir: string; manifest?: Manifest; error?: string }[] {
  const root = bootstrapRoot(ctx);
  if (!existsSync(root)) return [];
  const out: { dir: string; manifest?: Manifest; error?: string }[] = [];
  for (const project of readdirSync(root)) {
    const pdir = path.join(root, project);
    for (const run of existsSync(pdir) ? readdirSync(pdir) : []) {
      const dir = path.join(pdir, run);
      try {
        out.push({ dir, manifest: manifestSchema.parse(JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf8'))) });
      } catch (e) {
        out.push({ dir, error: (e as Error).message.split('\n')[0] });
      }
    }
  }
  return out;
}

export function findRun(ctx: Ctx, runId: string): { dir: string; manifest: Manifest } {
  const hit = listRuns(ctx).find((r) => path.basename(r.dir) === runId);
  if (!hit) throw new Error(`no bootstrap run '${runId}' under ${bootstrapRoot(ctx)}`);
  if (!hit.manifest) throw new Error(`run '${runId}': invalid manifest.json (${hit.error})`);
  return { dir: hit.dir, manifest: hit.manifest };
}

function writeManifest(dir: string, m: Manifest): void {
  writeFileSync(path.join(dir, 'manifest.json'), `${JSON.stringify(manifestSchema.parse({ ...m, updatedAt: now() }), null, 2)}\n`, { mode: 0o600 });
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'root';

/** Create a run: folder (0700), notes/ (0700), manifest. Areas from `name=paths` args, else one per scope path. */
export function initRun(ctx: Ctx, project: string, opts: { scope?: string[]; areas?: string[]; retentionDays?: number; repo?: string }): { runId: string; dir: string; manifest: Manifest } {
  if (!ID.test(project)) throw new Error(`project must be a project id (kebab-case), got '${project}'`);
  const runId = newRunId();
  const dir = path.join(bootstrapRoot(ctx), project, runId);
  for (const d of [ctx.mandateHome, bootstrapRoot(ctx), path.dirname(dir), dir, path.join(dir, 'notes')]) {
    mkdirSync(d, { recursive: true, mode: 0o700 });
    chmodSync(d, 0o700);
  }
  const scope = opts.scope ?? [];
  const specs = opts.areas?.length ? opts.areas : scope.length ? scope.map((p) => `${slug(p)}=${p}`) : ['all=.'];
  const areas = specs.map((a) => {
    const [name, paths = ''] = a.split('=', 2) as [string, string?];
    const id = slug(name);
    return { id, paths: paths.split(',').map((x) => x.trim()).filter(Boolean), status: 'pending' as const, notes: `notes/${id}.jsonl`, updatedAt: now() };
  });
  const dup = areas.find((a, i) => areas.findIndex((b) => b.id === a.id) !== i);
  if (dup) throw new Error(`area '${dup.id}' given twice`);
  const manifest: Manifest = { version: 1, runId, project, repo: opts.repo ?? ctx.cwd, scope, stage: 'setup', areas, retentionDays: opts.retentionDays ?? DEFAULT_RETENTION_DAYS, createdAt: now(), updatedAt: now() };
  writeManifest(dir, manifest);
  return { runId, dir, manifest };
}

export interface NoteIssue {
  file: string;
  line: number;
  message: string;
}

/** Validate the manifest and every notes file. */
export function validateRun(dir: string, manifest: Manifest): { issues: NoteIssue[]; counts: Record<string, number> } {
  const issues: NoteIssue[] = [];
  const counts: Record<string, number> = {};
  const areaIds = new Set(manifest.areas.map((a) => a.id));
  const notesDir = path.join(dir, 'notes');
  const files = existsSync(notesDir) ? readdirSync(notesDir).filter((f) => !f.startsWith('.')) : [];
  for (const f of files) {
    const rel = `notes/${f}`;
    if (!f.endsWith('.jsonl')) {
      issues.push({ file: rel, line: 0, message: 'notes files are .jsonl (one JSON object per line)' });
      continue;
    }
    readFileSync(path.join(notesDir, f), 'utf8')
      .split('\n')
      .forEach((line, i) => {
        if (!line.trim()) return;
        let v: unknown;
        try {
          v = JSON.parse(line);
        } catch (e) {
          issues.push({ file: rel, line: i + 1, message: `not JSON: ${(e as Error).message}` });
          return;
        }
        const r = noteSchema.safeParse(v);
        if (!r.success) {
          for (const iss of r.error.issues) issues.push({ file: rel, line: i + 1, message: `${iss.path.join('.') || '(note)'}: ${iss.message}` });
          return;
        }
        if (!areaIds.has(r.data.area)) issues.push({ file: rel, line: i + 1, message: `area '${r.data.area}' is not in manifest.json (${[...areaIds].join(', ')})` });
        counts[r.data.type] = (counts[r.data.type] ?? 0) + 1;
      });
  }
  for (const a of manifest.areas) if (['extracted', 'distilled', 'reviewed'].includes(a.status) && !existsSync(path.join(dir, a.notes))) issues.push({ file: a.notes, line: 0, message: `area '${a.id}' is ${a.status} but has no notes file` });
  return { issues, counts };
}

/** Runs past their retention: done (completedAt + retentionDays) — `days` overrides the per-run setting. */
export function expiredRuns(ctx: Ctx, at = Date.now(), days?: number): string[] {
  return listRuns(ctx)
    .filter((r) => r.manifest?.stage === 'done' && r.manifest.completedAt && Date.parse(r.manifest.completedAt) + (days ?? r.manifest.retentionDays) * 86_400_000 <= at)
    .map((r) => r.dir);
}

export function cleanRuns(ctx: Ctx, opts: { days?: number; dryRun?: boolean; at?: number } = {}): string[] {
  const dirs = expiredRuns(ctx, opts.at, opts.days);
  if (!opts.dryRun) for (const d of dirs) rmSync(d, { recursive: true, force: true });
  return dirs;
}

export async function cmdBootstrap(ctx: Ctx, a: Args, out: Out): Promise<number> {
  const [sub, ...pos] = a.positional;
  const num = (k: string) => (str(a, k) !== undefined ? Number(str(a, k)) : undefined);
  switch (sub) {
    case 'init': {
      const [project, ...areas] = pos;
      if (!project) {
        out.err(fail('usage: mandate bootstrap init <project> [--scope a,b] [<area>=<paths,…> …] [--retention-days N]'));
        return 2;
      }
      const r = initRun(ctx, project, { scope: str(a, 'scope')?.split(',').map((x) => x.trim()).filter(Boolean), areas, retentionDays: num('retention-days') });
      out.log(JSON.stringify({ runId: r.runId, path: r.dir, notes: path.join(r.dir, 'notes'), areas: r.manifest.areas.map((x) => ({ id: x.id, paths: x.paths, notes: x.notes })) }, null, 2));
      return 0;
    }
    case 'status': {
      const runId = pos[0];
      if (!runId) {
        for (const r of listRuns(ctx)) out.log(`${path.basename(r.dir)}  ${r.manifest ? `${r.manifest.project}  ${r.manifest.stage}  ${r.manifest.areas.map((x) => `${x.id}:${x.status}`).join(' ')}` : c.red(`invalid: ${r.error}`)}`);
        return 0;
      }
      const { dir, manifest } = findRun(ctx, runId);
      let m = manifest;
      const stage = str(a, 'stage');
      if (stage) {
        if (!(STAGES as readonly string[]).includes(stage)) throw new Error(`--stage: ${STAGES.join(' | ')}`);
        m = { ...m, stage: stage as Manifest['stage'], ...(stage === 'done' ? { completedAt: now() } : {}) };
      }
      const area = str(a, 'area');
      const areaStatus = str(a, 'area-status');
      if (area || areaStatus) {
        if (!area || !areaStatus || !(AREA_STATUSES as readonly string[]).includes(areaStatus)) throw new Error(`--area <id> --area-status ${AREA_STATUSES.join(' | ')}`);
        if (!m.areas.some((x) => x.id === area)) throw new Error(`no area '${area}' (${m.areas.map((x) => x.id).join(', ')})`);
        m = { ...m, areas: m.areas.map((x) => (x.id === area ? { ...x, status: areaStatus as Manifest['areas'][number]['status'], updatedAt: now() } : x)) };
      }
      const wo = str(a, 'work-order');
      if (wo) m = { ...m, workOrder: wo };
      if (m !== manifest) writeManifest(dir, m);
      out.log(JSON.stringify({ path: dir, ...findRun(ctx, runId).manifest }, null, 2));
      return 0;
    }
    case 'validate': {
      const runId = pos[0];
      if (!runId) {
        out.err(fail('usage: mandate bootstrap validate <runId>'));
        return 2;
      }
      const { dir, manifest } = findRun(ctx, runId);
      const { issues, counts } = validateRun(dir, manifest);
      for (const i of issues.slice(0, 200)) out.log(`${i.file}${i.line ? `:${i.line}` : ''}: ${i.message}`);
      if (issues.length > 200) out.log(`… ${issues.length - 200} more`);
      const summary = Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(', ') || 'no notes';
      out.log(issues.length ? fail(`${issues.length} problem(s); notes: ${summary}`) : ok(`notes valid: ${summary}`));
      return issues.length ? 1 : 0;
    }
    case 'clean': {
      const dirs = cleanRuns(ctx, { days: num('days'), dryRun: bool(a, 'dry-run') });
      out.log(dirs.length ? dirs.map((d) => `${bool(a, 'dry-run') ? 'would remove' : 'removed'} ${d}`).join('\n') : info('no bootstrap notes past their retention'));
      return 0;
    }
    default:
      out.err(fail('usage: mandate bootstrap init|status|validate|clean …'));
      return 2;
  }
}

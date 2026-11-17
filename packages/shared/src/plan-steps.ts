/**
 * Plan steps of a work order as data (pure helpers): stable ids (s1, s2, ... never reused), a status, a note, the spec
 * sections / acceptance criteria a step covers and the code it touched. The plan section's markdown is rendered from them
 * (`- [x] **s1** text`); work orders written before steps existed get their checkbox items parsed into steps on read.
 */
import { z } from 'zod';
import { touchedFileSchema } from '@mandate/doc';

/** Task ids: `t1`, `t2`, ... (older work orders: `s1`, `s2`). */
export const TASK_ID_RE = /^[st]\d+$/;

export const PLAN_STEP_STATUSES = ['pending', 'in_progress', 'done', 'skipped'] as const;
export type PlanStepStatus = (typeof PLAN_STEP_STATUSES)[number];

export const planStepSchema = z.object({
  /** `s1`, `s2`, ...: stable, never reused within a work order. */
  id: z.string().regex(TASK_ID_RE),
  text: z.string().trim().min(1),
  status: z.enum(PLAN_STEP_STATUSES).default('pending'),
  /** Why (required for skipped), what was done. */
  note: z.string().optional(),
  /** Spec section ids (of the work order's targets) this step covers. */
  sections: z.array(z.string()).optional(),
  /** Acceptance criterion ids this step proves. */
  proves: z.array(z.string()).optional(),
  codeRefs: z.array(touchedFileSchema).optional(),
  updatedAt: z.string(),
  by: z.string(),
});
export type PlanStep = z.infer<typeof planStepSchema>;

/** A step as written by an agent (work_order_create / work_order_plan_set): a string, or text with links (and its id when editing). */
export const planStepInputSchema = z.union([
  z.string().trim().min(1).max(2000).regex(/^[^\r\n]*$/, 'single line'),
  z
    .object({
      id: z.string().regex(TASK_ID_RE).optional(),
      text: z.string().trim().min(1).max(2000).regex(/^[^\r\n]*$/, 'single line'),
      sections: z.array(z.string().trim().min(1).max(200)).max(50).optional(),
      proves: z.array(z.string().trim().min(1).max(200)).max(50).optional(),
    })
    .strict(),
]);
export type PlanStepInput = z.input<typeof planStepInputSchema>;

const BOX: Record<PlanStepStatus, string> = { pending: ' ', in_progress: '~', done: 'x', skipped: '-' };
const FROM_BOX: Record<string, PlanStepStatus> = { ' ': 'pending', '~': 'in_progress', x: 'done', X: 'done', '-': 'skipped' };

/** One markdown line of a step. */
export const renderStepLine = (s: Pick<PlanStep, 'id' | 'text' | 'status'>) => `- [${BOX[s.status]}] **${s.id}** ${s.text}`;
export const renderSteps = (steps: PlanStep[]): string[] => steps.map(renderStepLine);

const LINE_RE = /^[-*+]\s+\[([ xX~-])\]\s+(?:\*\*([st]\d+)\*\*\s+)?(.*\S)\s*$/;
export interface ParsedStepLine {
  /** Index of the line in the text. */
  line: number;
  status: PlanStepStatus;
  id?: string;
  text: string;
}

/** The checkbox items of a plan text (only its **Tasks** block when there is one; fenced code ignored). */
export function parseStepLines(md: string): ParsedStepLine[] {
  const lines = md.split(/\r?\n/);
  let from = 0;
  let to = lines.length;
  const head = lines.findIndex((l) => /^\*\*(?:Tasks|Steps)\*\*/.test(l));
  if (head >= 0) {
    from = head + 1;
    const next = lines.findIndex((l, i) => i > head && /^\*\*[^*\n]+\*\*\s*$/.test(l));
    if (next >= 0) to = next;
  }
  const out: ParsedStepLine[] = [];
  let fence = false;
  for (let i = from; i < to; i++) {
    const l = lines[i]!;
    if (/^\s*(```|~~~)/.test(l)) fence = !fence;
    if (fence) continue;
    const m = LINE_RE.exec(l);
    if (m) out.push({ line: i, status: FROM_BOX[m[1]!]!, ...(m[2] ? { id: m[2] } : {}), text: m[3]!.trim() });
  }
  return out;
}

/** Legacy work orders (markdown-only plans): the checkbox items as steps s1.. in order (deterministic, nothing is written). */
export function legacySteps(planMd: string, at: string): PlanStep[] {
  return parseStepLines(planMd).map((p, i) => ({ id: `s${i + 1}`, text: p.text, status: p.status, updatedAt: at, by: 'plan' }));
}

/** The steps of a work order: stored ones, else parsed from the plan text. */
export function stepsOf(d: { planSteps?: PlanStep[]; createdAt: string }, planMd: string): PlanStep[] {
  return d.planSteps ?? legacySteps(planMd, d.createdAt);
}

/** Next sequence number: ids are never reused (the stored counter, at least the highest id seen). */
export const nextStepSeq = (steps: PlanStep[], seq?: number) => Math.max(seq ?? 0, ...steps.map((s) => Number(s.id.slice(1))));

export interface DesiredStep {
  id?: string;
  text: string;
  /** Status of a NEW step (from a ticked checkbox in markdown); matched steps keep theirs (work_order_step_set changes it). */
  status?: Exclude<PlanStepStatus, 'skipped'>;
  sections?: string[];
  proves?: string[];
}
export const toDesired = (i: PlanStepInput): DesiredStep => (typeof i === 'string' ? { text: i.trim() } : i);

/**
 * Reconcile the desired step list with the existing steps: match by id, else by identical text (an unmatched step);
 * matched steps keep id, status, note and code refs (text and given links are updated); unmatched ones get new ids.
 * Problems: unknown ids, duplicate ids, removed done steps.
 */
export function reconcileSteps(
  existing: PlanStep[],
  desired: DesiredStep[],
  seq: number,
  who: { now: string; by: string },
): { steps: PlanStep[]; seq: number; problems: string[] } {
  const problems: string[] = [];
  const used = new Set<string>();
  const byId = new Map(existing.map((s) => [s.id, s]));
  let n = nextStepSeq(existing, seq);
  const steps = desired.map((d): PlanStep => {
    let prev: PlanStep | undefined;
    if (d.id) {
      prev = byId.get(d.id);
      if (!prev) problems.push(`unknown task id ${d.id} (tasks: ${existing.map((s) => s.id).join(', ') || 'none'}); leave the id out for a new step`);
      else if (used.has(d.id)) problems.push(`task id ${d.id} used twice`);
    } else prev = existing.find((s) => !used.has(s.id) && s.text === d.text);
    if (prev && !used.has(prev.id)) {
      used.add(prev.id);
      const links = { ...(d.sections ? { sections: d.sections } : {}), ...(d.proves ? { proves: d.proves } : {}) };
      const changed = prev.text !== d.text || (d.sections && JSON.stringify(d.sections) !== JSON.stringify(prev.sections ?? [])) || (d.proves && JSON.stringify(d.proves) !== JSON.stringify(prev.proves ?? []));
      return changed ? { ...prev, text: d.text, ...links, updatedAt: who.now, by: who.by } : prev;
    }
    n += 1;
    return { id: `t${n}`, text: d.text, status: d.status ?? 'pending', ...(d.sections?.length ? { sections: d.sections } : {}), ...(d.proves?.length ? { proves: d.proves } : {}), updatedAt: who.now, by: who.by };
  });
  for (const s of existing) {
    if (!used.has(s.id) && s.status === 'done') problems.push(`task ${s.id} is done ("${s.text.slice(0, 60)}") and cannot be removed: keep it in the plan`);
  }
  return { steps, seq: n, problems };
}

/** Rewrite the step lines of a plan text from the steps (by id, else by position when the text matches); other lines are kept. */
export function syncStepLines(md: string, steps: PlanStep[]): string {
  const parsed = parseStepLines(md);
  if (!parsed.length) return md;
  const lines = md.split(/\r?\n/);
  const byId = new Map(steps.map((s) => [s.id, s]));
  parsed.forEach((p, k) => {
    const s = p.id ? byId.get(p.id) : steps[k]?.text === p.text ? steps[k] : undefined;
    if (s) lines[p.line] = renderStepLine(s);
  });
  return lines.join('\n');
}

/** The plan text with its step lines replaced by exactly these steps (a **Tasks** block is added when the text has none). */
export function replaceStepLines(md: string, steps: PlanStep[]): string {
  const parsed = parseStepLines(md);
  const lines = md.split(/\r?\n/);
  const block = renderSteps(steps);
  if (!parsed.length) return ['**Tasks**', ...block, ...(md.trim() ? ['', md.trim()] : [])].join('\n');
  const drop = new Set(parsed.map((p) => p.line));
  const out: string[] = [];
  lines.forEach((l, i) => {
    if (i === parsed[0]!.line) out.push(...block);
    else if (!drop.has(i)) out.push(l);
  });
  return out.join('\n').trim();
}

/** The current step: the in-progress one, else the first pending. */
export const currentStep = (steps: PlanStep[]): PlanStep | undefined => steps.find((s) => s.status === 'in_progress') ?? steps.find((s) => s.status === 'pending');
export const unfinishedSteps = (steps: PlanStep[]) => steps.filter((s) => s.status === 'pending' || s.status === 'in_progress');

/** Plan progress from steps (finished = done or skipped). */
export function stepsProgress(steps: PlanStep[]): { total: number; done: number; current?: { index: number; text: string; id: string } } {
  const cur = currentStep(steps);
  return {
    total: steps.length,
    done: steps.filter((s) => s.status === 'done' || s.status === 'skipped').length,
    ...(cur ? { current: { index: steps.indexOf(cur) + 1, text: cur.text, id: cur.id } } : {}),
  };
}

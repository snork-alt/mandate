/**
 * Writes realistic sample data (specs, standards, work orders) into the configured data repo,
 * one commit per change with backdated times and Agent:/Branch: trailers, so the UI has history to show.
 *
 *   npm run seed            # refuses if the repo already has specs
 *   npm run seed -- --reset # wipes the data repo first (restart the server afterwards)
 */
import { existsSync } from 'node:fs';
import { readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { sectionSchema } from '@mandate/doc';
import { createStandardSchema, updateStandardSchema } from '@mandate/shared';
import { createSpecSchema, updateSpecSchema, type CreateSpecInput, type SectionInput, type UpdateSpecInput } from '@mandate/shared';
import { loadConfig } from '../src/config.js';
import { createGitStore } from '../src/git/index.js';
import { createStorage, type CommitMeta } from '../src/storage/index.js';
import { FEEDBACK, WORK_ORDERS, SPECS, STANDARDS, type SeedSection, type SeedSpec } from './seed-data.js';
import { createFeedbackSchema } from '@mandate/shared';
import { applyFeedback, finishFeedback } from './feedback-ops.js';
import { seedVerification, verifyForDone, withCriteria } from './verification-seed.js';
import { seedLinks, seedSummaries } from './links-seed.js';
import { applyRichStandards } from './rules-seed.js';
import { applyComponents } from './components-seed.js';

const NOW = Date.now();
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const person = (handle: string) => ({
  name: handle.charAt(0).toUpperCase() + handle.slice(1),
  email: `${handle}@example.com`,
});

/** First version of a section (draft body/title if given). */
/** Section-level standards become `follows` links to the whole standard (spec-level standards are derived). */
const withFollows = <S extends { links?: SectionInput['links'] }>(s: S, standards?: string[]): S => {
  const links = [...(s.links ?? [])];
  for (const id of standards ?? []) {
    const to = `mandate://standards/${id}`;
    if (!links.some((l) => l.to === to)) links.push({ to, rel: 'follows' });
  }
  return { ...s, links };
};
const draft = ({ draftBody, draftTitle, standards, ...s }: SeedSection) =>
  sectionSchema.parse(withFollows({ ...s, body: draftBody ?? s.body, title: draftTitle ?? s.title }, standards));
/** Final version of a section. */
const final = ({ draftBody: _b, draftTitle: _t, standards, ...s }: SeedSection) => sectionSchema.parse(withFollows(s, standards));
const hasDraft = (s: SeedSection) => s.draftBody !== undefined || s.draftTitle !== undefined;

type Step = {
  at: number;
  spec: string;
  meta: Omit<CommitMeta, 'date'>;
  /** Patch to apply, or the full input for the first step. */
  change: { create: CreateSpecInput } | { update: (ctx: { lastCommit: string; current: SectionInput[] }) => UpdateSpecInput } | { verify: true };
};

function stepsFor(s: SeedSpec, index: number): Step[] {
  const steps: Step[] = [];
  const human = { author: person(s.owner) };
  const agent = { agent: s.agent ?? 'claude-code@matteo-mbp', branch: `spec/${s.id}` };
  let t = NOW - s.startDaysAgo * DAY + index * 17 * MIN;
  const add = (dt: number, meta: Step['meta'], change: Step['change']) => {
    t += dt;
    steps.push({ at: t, spec: s.id, meta, change });
  };
  const [first, ...rest] = s.sections;
  let implemented = '';

  add(0, { ...human, message: `spec(${s.id}): draft` }, {
    create: {
      id: s.id,
      title: s.title,
      summary: s.summary,
      category: s.category,
      priority: s.priority,
      tags: s.tags,
      owner: s.owner,
      repo: s.repo,
      status: 'active',
      sections: first ? [draft(first)] : [],
    },
  });
  rest.forEach((section, i) => {
    const sections = s.sections.slice(0, i + 2);
    const byAgent = s.agent && i % 2 === 1;
    add(3 * HOUR + i * 41 * MIN, byAgent ? { ...agent, message: `spec(${s.id}): add ${section.title.toLowerCase()}` } : { ...human, message: `spec(${s.id}): add ${section.title.toLowerCase()}` }, {
      update: () => ({ sections: sections.map(draft) }),
    });
  });
  // Refine drafted sections (gives the history real "modified" diffs).
  const drafted = s.sections.filter(hasDraft);
  if (drafted.length) {
    add(9 * HOUR, s.agent ? { ...agent, message: `spec(${s.id}): refine ${drafted.map((d) => d.id).join(', ')}` } : { ...human, message: `spec(${s.id}): refine ${drafted.map((d) => d.id).join(', ')}` }, {
      update: () => ({ sections: s.sections.map(final) }),
    });
  }
  const notFollowed = (s.standards ?? []).filter((id) => !s.sections.some((x) => x.standards?.includes(id)));
  if (notFollowed.length) {
    // Spec-wide standards are followed by the first section (the overview).
    add(2 * HOUR, { ...human, message: `spec(${s.id}): follow ${notFollowed.join(', ')}` }, {
      // (only standards no section follows yet; a section-level follows is more precise)
      update: () => {
        const sections = s.sections.map(final);
        const missing = s.standards!.filter((id) => !sections.some((x) => x.links.some((l) => l.to === `mandate://standards/${id}`)));
        return { sections: sections.map((x, i) => (i === 0 ? withFollows(x, missing) : x)) };
      },
    });
  }
  if (s.final === 'archived') {
    add(DAY, { ...human, message: `spec(${s.id}): archive\n\nReplaced by the CSV export.` }, { update: () => ({ status: 'archived' }) });
    return steps;
  }
  

  // Ready gate: every section has an acceptance criterion before ready (criteria written with the ready step).
  add(5 * HOUR, { ...human, message: `spec(${s.id}): ready for implementation` }, { update: ({ current }) => ({ sections: withCriteria(s.id, current) }) });
  if (s.final === 'active') return steps;

  // In progress = a claimed work order (claims live on work orders; see WORK_ORDER_CLAIMS).
  if (s.final === 'in_progress' || s.final === 'in_progress_stale') return steps;

  // done / reopened (the agent's claim was on its work order; the spec only records the result). The agent verifies
  // the criteria first (the done gate).
  add(9 * HOUR + 40 * MIN, { ...agent }, { verify: true });
  add(2 * MIN, { ...agent, message: `spec(${s.id}): done\n\nImplemented on ${agent.branch}; all acceptance checks pass.` }, {
    // Spec-level and per-section implementedCommit point at the version that was implemented (full sha).
    update: ({ lastCommit, current }) => {
      implemented = lastCommit;
      return {
        status: 'done',
        implementedCommit: implemented,
        sections: current.map((x) => ({ ...x, implementedCommit: implemented })),
      };
    },
  });
  if (s.final === 'reopened') {
    // The aggregation rules change after implementation, so those sections become outdated.
    add(2 * DAY, { ...human, message: `spec(${s.id}): tighten aggregation rules`, trailers: { Feedback: 'fb-0005' } }, {
      update: ({ current }) => ({
        sections: current.map((x) => {
          const sec = { ...x, implementedCommit: implemented };
          return x.id === 'aggregation'
            ? { ...sec, body: `${sec.body}\n- Retries reuse the idempotency key of the first attempt; never generate a new one.` }
            : sec;
        }),
      }),
    });
    add(DAY, { ...human, message: `spec(${s.id}): reopen\n\nUsage was double-counted when the flush job retried; reporting must be idempotent.` }, {
      update: () => ({ status: 'active' }),
    });
  }
  return steps;
}

async function main() {
  const reset = process.argv.includes('--reset');
  const config = loadConfig();
  if (reset && existsSync(config.dataDir)) {
    console.log(`Wiping ${config.dataDir}`);
    await rm(config.dataDir, { recursive: true, force: true });
  }
  const git = createGitStore(config);
  await git.openOrCreate();
  const storage = createStorage(git);

  const existing = await readdir(path.join(git.dir, 'specs')).catch(() => []);
  if (existing.length) {
    console.error(`${git.dir} already contains specs; run with --reset to wipe it (then restart the server).`);
    process.exit(1);
  }

  // Every write becomes a timed event; events run in time order so git history is chronological.
  const events: { at: number; run: () => Promise<unknown> }[] = [];
  for (const std of STANDARDS) {
    const t0 = NOW - std.startDaysAgo * DAY;
    const { sections, startDaysAgo: _d, ...front } = std;
    const author = { author: person(std.owner) };
    events.push({
      at: t0,
      run: () =>
        storage.standards.create(createStandardSchema.parse({ ...front, sections: sections.slice(0, 2).map(draft) }), {
          ...author,
          date: new Date(t0),
          message: `standard(${std.id}): draft`,
        }),
    });
    if (sections.length > 2) {
      const at = t0 + 2 * DAY;
      events.push({
        at,
        run: () =>
          storage.standards.update(std.id, updateStandardSchema.parse({ sections: sections.map(draft) }), {
            author: person('matteo'),
            date: new Date(at),
            message: `standard(${std.id}): add ${sections.slice(2).map((x) => x.title.toLowerCase()).join(', ')}`,
          }),
      });
    }
    if (sections.some(hasDraft)) {
      const at = t0 + 9 * DAY;
      events.push({
        at,
        run: () =>
          storage.standards.update(std.id, updateStandardSchema.parse({ sections: sections.map(final) }), {
            author: person('giulia'),
            date: new Date(at),
            message: `standard(${std.id}): tighten ${sections.filter(hasDraft).map((x) => x.title.toLowerCase()).join(', ')}`,
          }),
      });
    }
  }
  for (const { hoursAgo, agent, ...item } of WORK_ORDERS) {
    const at = NOW - hoursAgo * HOUR;
    events.push({
      at,
      run: () =>
        storage.workOrderService.create({ ...item, ...(item.id === 'q-0001' ? { plan: '1. Wire the OIDC client.\n2. Handle the callback and create the session.\n3. Tests with a fake IdP.' } : {}) }, {
          date: new Date(at),
          author: person(item.createdBy),
          message: `work order: ${item.kind} ${item.spec} (${item.sections.map((x) => x.id).join(', ')})`,
          ...(agent ? { agent } : {}),
        }),
    });
  }

  // Claims live on work orders: claude-code works on login-sso through q-0001 (claim + heartbeats).
  const claimer = { agent: 'claude-code@matteo-mbp', branch: 'spec/login-sso', worktree: '/Users/matteo/code/app-wt/login-sso' };
  events.push({ at: NOW - 52 * MIN, run: () => storage.workOrderService.claim({ id: 'q-0001', ...claimer }, { date: new Date(NOW - 52 * MIN), agent: claimer.agent, branch: claimer.branch }) });
  for (const b of [NOW - 27 * MIN, NOW - 3 * MIN]) {
    events.push({ at: b, run: () => storage.workOrderService.heartbeat({ id: 'q-0001', agent: claimer.agent }, { date: new Date(b), agent: claimer.agent, branch: claimer.branch }) });
  }

  const lastCommit = new Map<string, string>();
  for (const step of SPECS.flatMap(stepsFor)) {
    if (step.at > NOW) throw new Error(`step for ${step.spec} is in the future`);
    const meta: CommitMeta = { ...step.meta, date: new Date(step.at) };
    events.push({
      at: step.at,
      run: async () => {
        if ('create' in step.change) {
          await storage.specs.create(createSpecSchema.parse(step.change.create), meta);
        } else if ('verify' in step.change) {
          await verifyForDone(storage, step.spec, meta);
          return;
        } else {
          const current = (await storage.specs.get(step.spec)).sections as SectionInput[];
          const patch = updateSpecSchema.parse(step.change.update({ lastCommit: lastCommit.get(step.spec) ?? '', current }));
          await storage.specs.update(step.spec, patch, meta);
        }
        lastCommit.set(step.spec, (await git.log(1))[0]!.id);
      },
    });
  }

  for (const item of FEEDBACK) {
    const { hoursAgo, apply, final: _f, by: _by, ...input } = item;
    const at = NOW - hoursAgo * HOUR;
    events.push({
      at,
      run: () =>
        storage.feedbackService.create(createFeedbackSchema.parse(input), {
          date: new Date(at),
          author: person(item.by ?? 'matteo'),
          message: `feedback: ${item.kind} on ${item.targets.map((t) => t.replace('mandate://', '')).join(', ')}`,
        }),
    });
    for (const op of apply ?? []) {
      const opAt = NOW - op.hoursAgo * HOUR;
      events.push({ at: opAt, run: () => applyFeedback(storage, item.id, op, new Date(opAt)) });
    }
    if (item.final) {
      const finalAt = 'hoursAgo' in item.final ? NOW - item.final.hoursAgo * HOUR : at + HOUR;
      events.push({ at: finalAt, run: () => finishFeedback(storage, item, new Date(finalAt)) });
    }
  }

  // Stable sort keeps each spec's own steps in order when times tie.
  events.sort((a, b) => a.at - b.at);
  for (const e of events) await e.run();
  // Acceptance criteria and verification results (minutes before now).
  await seedVerification(storage, (m) => new Date(NOW - 90 * MIN + m * 30_000));
  let linkMinute = 0;
  await seedSummaries(storage, () => new Date(NOW - 20 * MIN + (linkMinute += 0.2) * MIN));
  await seedLinks(storage, () => new Date(NOW - 20 * MIN + (linkMinute += 0.2) * MIN));
  // audit-log got its acceptance criteria after it was done: re-complete it so its gate snapshot covers them
  // (user-sessions is left as is: done, verified, but Drifted because criteria were added after done).
  const reDone = () => new Date(NOW - 5 * MIN + (linkMinute += 0.2) * MIN);
  await storage.specs.update('audit-log', { status: 'active' } as never, { date: reDone(), author: person('giulia'), message: 'spec(audit-log): reopen to re-run the gate with the new criteria' });
  await storage.specs.update('audit-log', { status: 'done' } as never, { date: reDone(), author: person('giulia'), message: 'spec(audit-log): done (gate re-run)' });
  // Richer standards: rule sections, lifecycle (deprecated rate-limit-headers, draft observability).
  // Rules added after a spec was done make it Drifted (never retroactively failed).
  await applyRichStandards(storage, () => ({ date: reDone(), author: person('giulia') }));
  // Architecture components (owns, interfaces, depends_on, follows) and affects links from spec sections.
  await applyComponents(storage, () => ({ date: reDone(), author: person('sofia') }));
  const commits = (await git.log(1000)).length;

  console.log(`Seeded ${SPECS.length} specs, ${STANDARDS.length} standards and ${WORK_ORDERS.length} work orders in ${commits} commits (${git.dir}).`);
}

await main();

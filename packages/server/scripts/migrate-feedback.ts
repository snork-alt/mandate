/**
 * One-off, in-place migration of feedback.jsonl to the open/accepted/closed model:
 * drops `source` / `commits`, adds missing items, applies remaining seed effects with
 * `Feedback:` trailers and closes items (closing freezes them). Safe to re-run.
 *
 *   npx tsx scripts/migrate-feedback.ts
 */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createFeedbackSchema, parseRef } from '@mandate/shared';
import { loadConfig } from '../src/config.js';
import { createGitStore } from '../src/git/index.js';
import { createStorage } from '../src/storage/index.js';
import { applyFeedback, finishFeedback } from './feedback-ops.js';
import { FEEDBACK } from './seed-data.js';

const config = loadConfig();
const git = createGitStore(config);
await git.openOrCreate();
const storage = createStorage(git);
const file = path.join(git.dir, 'feedback.jsonl');

// 1. Convert the stored lines.
const lines = (await readFile(file, 'utf8')).split('\n').filter(Boolean);
if (lines.some((l) => l.includes('"source":'))) {
  const out = lines.map((l) => {
    const { source: _s, commits: _c, resolution: _r, ...rest } = JSON.parse(l) as Record<string, unknown>;
    return JSON.stringify({ ...rest, status: rest.status === 'accepted' ? 'accepted' : 'open', relatedTo: [] });
  });
  await writeFile(file, `${out.join('\n')}\n`, 'utf8');
  await git.commit(['feedback.jsonl'], 'feedback: migrate to open/accepted/closed, drop source\n\nAgent: claude-code@matteo-mbp\nMandate-Migration: yes\n');
  console.log('converted feedback.jsonl');
}

// 2. Add missing items, 3. apply remaining effects, 4. set final states.
const existing = new Set((await storage.feedbackService.list()).map((f) => f.id));
for (const item of FEEDBACK) {
  if (!existing.has(item.id)) {
    const { hoursAgo: _h, apply: _a, final: _f, ...input } = item;
    await storage.feedbackService.create(createFeedbackSchema.parse(input), { message: `feedback: ${item.kind} on ${item.targets.map((t) => t.replace('mandate://', '')).join(', ')}` });
    console.log('created', item.id);
  }
}
for (const item of FEEDBACK) {
  const current = await storage.feedbackService.get(item.id);
  if (current.status === 'closed') continue;
  for (const op of item.apply ?? []) {
    if (op.type === 'replace') {
      const ref = parseRef(op.target)!;
      const doc = await (ref.kind === 'standards' ? storage.standards : storage.specs).get(ref.id);
      if (!doc.sections.some((s) => s.body.includes(op.find))) continue; // already applied
    } else if (op.type === 'createStandard' && (await storage.standards.raw(op.id)) !== null) continue;
    else if (op.type === 'archiveSection') continue; // historical: this migration used to delete the spec (documents are archive-only now)
    await applyFeedback(storage, item.id, op, new Date());
    console.log('applied', item.id, op.type);
  }
  if (item.final && current.status !== item.final.status) {
    await finishFeedback(storage, item, new Date());
    console.log('final', item.id, item.final.status);
  }
}
const summary = await storage.feedbackService.list();
console.log(summary.map((f) => `${f.id} ${f.status}${f.resolution ? `/${f.resolution}` : ''} changes=${f.changes.length}${f.warnings.length ? ` warnings=${f.warnings.length}` : ''}`).join('\n'));

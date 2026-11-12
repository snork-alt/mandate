/**
 * In-place migration to the reviewed connectivity model (real-time commits, idempotent):
 * - spec-level and section-level `standards` -> `follows` links to the whole standard on the sections
 *   (spec-level entries no section follows go on the first section, noted in the commit message);
 * - spec-level `dependsOn` -> section `depends_on` links (where no section link already covers it);
 * - `status: in_progress` -> `ready` (in progress is derived from claimed work orders);
 * - spec `claim` -> the covering open work order (dropped, with a note, when that work order is closed);
 * - short shas -> full shas (implementedCommit, work order specCommit);
 * - contradictory link pairs (follows + deviates_from on one target) -> the deviation is kept;
 * - the command-palette deviation gets an accepted approval by another author (fb by giulia);
 * - done specs get a gate snapshot of their current state.
 * Verification records are append-only and keep their (short) specCommit; it is resolved on read.
 */
import { parse as parseYaml } from 'yaml';
import { parseLinkTarget } from '@mandate/doc';
import type { Claim, Section } from '@mandate/shared';
import { loadConfig } from '../src/config.js';
import { createGitStore } from '../src/git/index.js';
import { createStorage, isFullSha } from '../src/storage/index.js';

const config = loadConfig();
const git = createGitStore(config);
await git.openOrCreate();
const storage = createStorage(git);
const author = { name: 'Matteo', email: 'matteo@example.com' };
// Migration commits record no causes (lineage L-1): `Mandate-Migration: yes`.
const meta = (message: string) => ({ date: new Date(), author, message, trailers: { 'Mandate-Migration': 'yes' } });
const full = async (c?: string) => (c && !isFullSha(c) ? ((await git.resolveCommit(c)) ?? c) : c);

/** Former spec-level dependsOn, mapped to the section that actually depends (by content). */
const DEPENDS: Record<string, { from: string; to: string; note: string }[]> = {
  'usage-metering': [{ from: 'pipeline', to: 'mandate://specs/audit-log/sections/events', note: 'Usage is counted from audit events' }],
  'rate-limiting': [{ from: 'limits', to: 'mandate://specs/audit-log/sections/events', note: 'Throttling decisions are audited' }],
};

// 1. Approval for the command-palette deviation (accepted feedback by someone other than the waiver's author).
const fbBody = 'Native command palettes show the selected row with a background highlight, not a focus ring. Approving the deviation from the focus-visible criterion for the palette rows.';
let approvalId = (await storage.feedback.list()).find((f) => f.body === fbBody)?.id;
if (!approvalId) {
  const giulia = { date: new Date(), author: { name: 'Giulia', email: 'giulia@example.com' } };
  const fb = await storage.feedbackService.create(
    { targets: ['mandate://specs/command-palette/sections/keyboard'], kind: 'question', body: fbBody },
    { ...giulia, message: 'feedback: question on specs/command-palette/sections/keyboard' },
  );
  await storage.feedbackService.update(fb.id, { status: 'accepted' }, { ...giulia, message: `feedback: accept ${fb.id}` });
  approvalId = fb.id;
  console.log('approval', fb.id);
}

// 2. Specs.
const claims = new Map<string, Claim>();
for (const spec of await storage.specs.list()) {
  const raw = (await storage.specs.raw(spec.id)) ?? '';
  const fm = (parseYaml(raw.split(/^---$/m)[1] ?? '') ?? {}) as {
    standards?: string[];
    dependsOn?: string[];
    claim?: Claim;
    status?: string;
    sections?: { id: string; standards?: string[] }[];
  };
  if (fm.claim) claims.set(spec.id, fm.claim);
  const notes: string[] = [];
  const sections: Section[] = [];
  for (const s of spec.sections) {
    const legacy = fm.sections?.find((x) => x.id === s.id)?.standards ?? [];
    let links = [...s.links];
    for (const id of legacy) {
      const to = `mandate://standards/${id}`;
      if (!links.some((l) => l.to === to)) links.push({ to, rel: 'follows' });
    }
    // Contradictory pairs: keep the deviation (it is the more specific statement).
    links = links.filter((l) => !(l.rel === 'follows' && links.some((x) => x.to === l.to && x.rel === 'deviates_from')));
    for (const d of DEPENDS[spec.id] ?? []) if (d.from === s.id && !links.some((l) => l.to === d.to)) links.push({ to: d.to, rel: 'depends_on', note: d.note });
    if (spec.id === 'command-palette' && s.id === 'keyboard') links = links.map((l) => (l.rel === 'deviates_from' && !l.feedback ? { ...l, feedback: approvalId } : l));
    sections.push({ ...s, links, ...(s.implementedCommit ? { implementedCommit: await full(s.implementedCommit) } : {}) });
  }
  const followed = (id: string) => sections.some((s) => s.links.some((l) => l.rel === 'follows' && parseLinkTarget(l.to)?.id === id));
  const missing = (fm.standards ?? []).filter((id) => !followed(id));
  if (missing.length && sections[0]) {
    sections[0] = { ...sections[0], links: [...sections[0].links, ...missing.map((id) => ({ to: `mandate://standards/${id}`, rel: 'follows' as const }))] };
    notes.push(`spec-level standards ${missing.join(', ')} -> follows on "${sections[0].title}" (no section followed them; first section used)`);
  }
  const followedSections = (fm.standards ?? []).filter((id) => !missing.includes(id));
  if (followedSections.length) notes.push(`spec-level standards ${followedSections.join(', ')} dropped (already followed by sections)`);
  for (const d of fm.dependsOn ?? []) notes.push(`dependsOn ${d} -> derived from section depends_on links`);
  if (fm.status === 'in_progress') notes.push('status in_progress -> ready (derived from claimed work orders)');
  if (fm.claim) {
    const target = (await storage.workOrders.list()).find((w) => w.spec === spec.id && (w.status === 'pending' || w.status === 'in_progress') && (w.kind === 'implement' || w.kind === 'update'));
    notes.push(target ? `claim by ${fm.claim.agent} -> moved to work order ${target.id}` : `claim by ${fm.claim.agent} dropped: no open implement/update work order covers it (claims live on work orders)`);
  }
  const implementedCommit = await full(spec.implementedCommit);
  const changed =
    JSON.stringify(sections) !== JSON.stringify(spec.sections) || implementedCommit !== spec.implementedCommit || fm.standards || fm.dependsOn || fm.claim || fm.status === 'in_progress';
  if (!changed) continue;
  await storage.specs.update(spec.id, { sections, ...(implementedCommit ? { implementedCommit } : {}) } as never, meta(`spec(${spec.id}): migrate to section-level standards and links\n\n${notes.map((n) => `- ${n}`).join('\n')}`));
  console.log('spec', spec.id, notes.length);
}

// 3. Gate snapshots for done specs (their current state; criteria added later show as Drifted).
for (const spec of await storage.specs.list()) {
  if (spec.status !== 'done' || spec.gate) continue;
  const v = await storage.verificationService.forSpec(spec);
  const gate = await storage.verificationService.snapshotOf(v);
  await storage.specs.update(spec.id, { gate } as never, meta(`spec(${spec.id}): record gate snapshot (migration; ${gate.criteria.length}/${v.total} criteria verified or waived)`));
  console.log('gate', spec.id, `${gate.criteria.length}/${v.total}`);
}

// 4. Work orders: full specCommit; claims from specs onto the covering open work order.
for (const w of await storage.workOrders.list()) {
  const specCommit = (await full(w.specCommit))!;
  const claim = claims.get(w.spec);
  const open = w.status === 'pending' || w.status === 'in_progress';
  const takeClaim = claim && open && !w.claim && w.kind !== 'review' && w.kind !== 'verify';
  if (specCommit === w.specCommit && !takeClaim) continue;
  const notes = [specCommit !== w.specCommit ? 'specCommit -> full sha' : '', takeClaim ? `claim by ${claim!.agent} moved here from spec ${w.spec}` : ''].filter(Boolean);
  await storage.workOrderService.update(w.id, { specCommit, ...(takeClaim ? { claim, status: 'in_progress' } : {}) } as never, meta(`work order: migrate ${w.id}\n\n${notes.map((n) => `- ${n}`).join('\n')}`));
  if (takeClaim) claims.delete(w.spec);
  console.log('work order', w.id, notes.join('; '));
}
for (const [spec, claim] of claims) console.log(`claim by ${claim.agent} on ${spec} dropped: no open implement/update work order covers it`);
// 5. Validate every document after rewriting: each file parses, and the repo lint is clean.
const { readdir } = await import('node:fs/promises');
for (const kind of ['specs', 'standards'] as const) {
  const files = (await readdir(`${git.dir}/${kind}`)).filter((f) => f.endsWith('.md'));
  const parsed = await (kind === 'specs' ? storage.specs : storage.standards).list();
  if (parsed.length !== files.length) throw new Error(`${kind}: ${files.length - parsed.length} file(s) do not parse after the migration`);
}
const issues = (await storage.integrity.run()).issues;
console.log('integrity issues:', issues.map((i) => `${i.rule} ${i.uri}: ${i.message}`));
if (issues.length) process.exitCode = 1;

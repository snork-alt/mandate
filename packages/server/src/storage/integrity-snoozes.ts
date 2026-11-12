/**
 * Integrity snoozes (`integrity-snoozes.jsonl`, append-only): a person acknowledges an integrity WARNING for N days
 * with a note (it leaves the attention counts until then). Errors are broken invariants and cannot be snoozed.
 */
import { activeSnooze, type IntegritySnooze } from '@mandate/shared';
import type { CommitMeta } from './GitBackedRepository.js';
import type { JsonlFileRepository } from './JsonlFileRepository.js';
import type { IntegrityService } from './integrity.js';

export class SnoozeError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly statusCode = 400,
  ) {
    super(message);
  }
}

export class IntegritySnoozeService {
  constructor(
    private readonly repo: JsonlFileRepository<IntegritySnooze>,
    private readonly integrity: () => IntegrityService,
  ) {}

  list(): Promise<IntegritySnooze[]> {
    return this.repo.list();
  }

  /** Active snoozes at `now`, keyed `rule|uri`. */
  async active(now = Date.now()): Promise<Map<string, IntegritySnooze>> {
    const all = await this.repo.list();
    const out = new Map<string, IntegritySnooze>();
    for (const s of all) {
      const a = activeSnooze(all, s.rule, s.uri, now);
      if (a) out.set(`${a.rule}|${a.uri}`, a);
    }
    return out;
  }

  async snooze(input: { rule: string; uri: string; days: number; note: string; by: string; now?: Date }, meta: CommitMeta = {}): Promise<IntegritySnooze> {
    const report = await this.integrity().current();
    const issue = report.issues.find((i) => i.rule === input.rule && i.uri === input.uri);
    if (!issue) throw new SnoozeError(`no current integrity issue ${input.rule} on ${input.uri}`, 'not_found', 404);
    if ((issue.severity ?? 'warning') === 'error') throw new SnoozeError(`${input.rule} is an ERROR (a broken invariant): fix it; only warnings can be snoozed`, 'not_snoozable', 409);
    const now = input.now ?? new Date();
    const until = new Date(now.getTime() + input.days * 86_400_000).toISOString();
    return this.repo.create(
      { rule: input.rule, uri: input.uri, until, note: input.note.trim(), by: input.by, at: now.toISOString() } as Omit<IntegritySnooze, 'id'> as IntegritySnooze,
      { ...meta, message: meta.message ?? `integrity: snooze ${input.rule} on ${input.uri.replace('mandate://', '')} for ${input.days} day${input.days === 1 ? '' : 's'}` },
    );
  }
}

/**
 * Lineage annotations (`lineage.jsonl`): causes recorded after the fact for past commits of the data repo, because
 * history is never rewritten. Append-only and frozen once written; the indexer turns each record into `caused_by`
 * edges exactly like trailers (`source: 'annotation'`).
 */
import { parseNodeUri, type LineageAnnotation } from '@mandate/shared';
import type { GitStore } from '../git/GitStore.js';
import { resolveCauses } from './causes.js';
import { ConflictError, type CommitMeta } from './GitBackedRepository.js';
import type { JsonlFileRepository } from './JsonlFileRepository.js';
import type { Storage } from './index.js';

export class AnnotationError extends Error {
  readonly statusCode = 400;
  constructor(
    message: string,
    readonly path: string,
    readonly code = 'invalid_annotation',
  ) {
    super(message);
  }
}

type CauseStorage = Parameters<typeof resolveCauses>[0];

export class LineageAnnotationService {
  constructor(
    private readonly repo: JsonlFileRepository<LineageAnnotation>,
    private readonly git: GitStore,
    private readonly storage: () => CauseStorage & Pick<Storage, 'feedback' | 'workOrders'>,
  ) {}

  list(): Promise<LineageAnnotation[]> {
    return this.repo.list();
  }

  /**
   * Append one annotation. The commit must resolve to a full sha on the data repo's history (an ancestor of HEAD);
   * causes are validated like `cause` and must not be later than the commit (no cause later than its effect).
   * An identical annotation (same commit and causes) is refused (`duplicate`).
   */
  async annotate(input: { commit: string; causes: string | string[]; note: string; by: string; at?: Date; confidence?: 'low' }, meta: CommitMeta = {}): Promise<LineageAnnotation> {
    const sha = await this.git.resolveCommit(input.commit).catch(() => null);
    if (!sha || !/^[0-9a-f]{40}$/.test(sha)) throw new AnnotationError(`commit '${input.commit}' does not resolve to a commit of the data repo`, 'commit');
    const head = await this.git.head();
    if (!head || (await this.git.reachable(sha, head)).length) throw new AnnotationError(`commit ${sha.slice(0, 7)} is not on the data repo's history (not an ancestor of HEAD)`, 'commit');
    const storage = this.storage();
    const causes = [...new Set(await resolveCauses(storage, input.causes))];
    const when = Date.parse((await this.git.commitInfo(sha)).date);
    for (const [i, c] of causes.entries()) {
      const born = await this.createdAt(storage, c);
      if (born !== null && Number.isFinite(when) && born > when + 1000) {
        throw new AnnotationError(`cause ${c} was created after commit ${sha.slice(0, 7)}: a cause cannot be later than its effect`, `causes.${i}`, 'cause_after_effect');
      }
      const n = parseNodeUri(c);
      if (n?.kind === 'commits' && n.sha !== sha && (await this.git.reachable(n.sha, sha)).length) {
        throw new AnnotationError(`cause commit ${n.sha.slice(0, 7)} is not an ancestor of ${sha.slice(0, 7)}`, `causes.${i}`, 'cause_after_effect');
      }
      if (n?.kind === 'commits' && n.sha === sha) throw new AnnotationError('a commit cannot be its own cause', `causes.${i}`);
    }
    const key = (a: { commit: string; causes: string[] }) => `${a.commit}|${[...a.causes].sort().join(',')}`;
    if ((await this.repo.list()).some((a) => key(a) === key({ commit: sha, causes }))) {
      throw new ConflictError(`duplicate: commit ${sha.slice(0, 7)} is already annotated with these causes`);
    }
    return this.repo.create(
      { commit: sha, causes, note: input.note.trim(), by: input.by, at: (input.at ?? new Date()).toISOString(), ...(input.confidence === 'low' ? { confidence: 'low' as const } : {}) },
      { ...meta, message: meta.message ?? `lineage: annotate ${sha.slice(0, 7)} (${causes.map((c) => c.replace('mandate://', '')).join(', ')})` },
    );
  }

  /** Creation time (ms) of a feedback item or work order cause; null when unknown (other kinds are not checked). */
  private async createdAt(storage: Pick<Storage, 'feedback' | 'workOrders'>, uri: string): Promise<number | null> {
    const n = parseNodeUri(uri);
    if (!n) return null;
    const rec =
      n.kind === 'feedback'
        ? await storage.feedback.get(n.id).catch(() => null)
        : n.kind === 'work-orders'
          ? await storage.workOrders.get(n.id).catch(() => null)
          : null;
    const t = rec ? Date.parse(String((rec as { createdAt?: string }).createdAt ?? '')) : NaN;
    return Number.isFinite(t) ? t : null;
  }
}

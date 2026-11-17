import { feedbackTrailerIds } from './feedback.js';
import {
  OPEN_WORK_ORDER_STATUSES,
  parseRef,
  userOfTrailers,
  SPEC_TRANSITIONS,
  STANDARD_TRANSITIONS,
  COMPONENT_TRANSITIONS,
  type StoredComponent,
  type StoredFeedback,
  type StoredSpec,
  type StoredStandard,
  type VerificationRecord,
  type WorkOrder,
} from '@mandate/shared';
import type { GitStore } from '../git/GitStore.js';
import { componentCodec, specCodec, standardCodec } from './codecs.js';
import { actorOf, ConflictError, type WriteContext } from './GitBackedRepository.js';
import { approvalOf, type LinkService } from './links.js';
import type { MarkdownDirRepository } from './MarkdownDirRepository.js';
import { samePrincipal, sectionUri, waiverPolicy, type Doc, type Kind, type Model } from './model.js';
import type { VerificationService } from './verification.js';

class RuleError extends Error {
  readonly statusCode: number;
  constructor(
    readonly code: string,
    message: string,
    readonly details?: unknown,
    status = 409,
  ) {
    super(`${code}: ${message}`);
    this.statusCode = status;
  }
}

/**
 * Write-time rules for specs and standards, run inside the write lock:
 * - status transitions (SPEC_TRANSITIONS);
 * - identity (C3): document and section ids are never reused; a section with inbound references
 *   cannot be removed (archive it instead); documents are archive-only (no delete);
 * - links (LinkService.validate: targets, archived / superseded, waivers, cycles);
 * - C1.3: shrinking the criteria of a done or claimed spec needs the user's approval (`User-Approved:` trailer from an answered approval question);
 * - the done gate with its snapshot (VerificationService.gate).
 */
export class DocRules {
  private idsAt = new Map<string, string[] | null>();

  constructor(
    private readonly deps: {
      specs: MarkdownDirRepository<StoredSpec>;
      standards: MarkdownDirRepository<StoredStandard>;
      components: MarkdownDirRepository<StoredComponent>;
      git: GitStore;
      links: LinkService;
      verification: VerificationService;
      model: () => Promise<Model>;
      workOrders: () => Promise<WorkOrder[]>;
      feedback: () => Promise<StoredFeedback[]>;
      verifications: () => Promise<VerificationRecord[]>;
      /** Who accepted a feedback item (principal), for the "approved by someone else" rule. */
      acceptorOf?: (id: string) => Promise<string | null>;
    },
  ) {}

  private repo(kind: Kind): MarkdownDirRepository<Doc> {
    return (kind === 'specs' ? this.deps.specs : kind === 'standards' ? this.deps.standards : this.deps.components) as MarkdownDirRepository<Doc>;
  }

  /** Section ids of the document in every committed version (ids are never reused). */
  async everSectionIds(kind: Kind, id: string): Promise<Set<string>> {
    const path = this.repo(kind).pathOf(id);
    const versions = (await this.deps.git.fileHistory(['specs', 'standards', 'components'])).get(path) ?? [];
    const out = new Set<string>();
    for (const v of versions) {
      const key = `${v.id}:${path}`;
      if (!this.idsAt.has(key)) {
        const raw = await this.deps.git.readFileAt(v.id, path).catch(() => null);
        let ids: string[] | null = null;
        try {
          ids = raw === null ? null : (kind === 'specs' ? specCodec.decode(raw, id) : kind === 'standards' ? standardCodec.decode(raw, id) : componentCodec.decode(raw, id)).sections.map((s) => s.id);
        } catch {
          ids = null;
        }
        this.idsAt.set(key, ids);
      }
      for (const s of this.idsAt.get(key) ?? []) out.add(s);
    }
    return out;
  }

  /** Everything that points at a section (C3.3). */
  async inbound(kind: Kind, docId: string, sectionId: string, m: Model): Promise<string[]> {
    const uri = sectionUri(kind, docId, sectionId);
    const out: string[] = [];
    for (const [k, list] of [['specs', m.specs], ['standards', m.standards], ['components', m.components ?? []]] as const)
      for (const d of list) for (const s of d.sections) for (const l of s.links) if (l.to === uri) out.push(`${l.rel} from ${sectionUri(k, d.id, s.id)}`);
    for (const w of await this.deps.workOrders())
      if (kind === 'specs' && w.spec === docId && OPEN_WORK_ORDER_STATUSES.includes(w.status) && w.sections.some((s) => s.id === sectionId)) out.push(`open work order ${w.id}`);
    for (const f of await this.deps.feedback())
      if (f.status !== 'closed' && f.targets.some((t) => { const r = parseRef(t); return r?.kind === kind && r.id === docId && r.sectionId === sectionId; })) out.push(`${f.status} feedback ${f.id}`);
    if ((await this.deps.verifications()).some((r) => r.criterion === uri)) out.push('verification results');
    return out;
  }

  /**
   * MW-5 / MW-9: archived sections are kept exactly as they were (content, links; only their position may change) and
   * are never un-archived; an archived component is frozen as a whole.
   */
  private frozen(kind: Kind, next: Doc, current: Doc): void {
    if (kind === 'components' && (current as StoredComponent).status === 'archived') {
      const strip = (d: Doc) => stable({ ...d, updatedAt: undefined, createdAt: undefined });
      if (strip(next) !== strip(current)) throw new RuleError('validation', `${kind}/${current.id} is archived: archived components are frozen`, undefined, 409);
    }
    for (const s of current.sections) {
      if (!s.archived) continue;
      const n = next.sections.find((x) => x.id === s.id);
      if (!n) continue; // removal is checked by the identity rule (section_referenced)
      if (!n.archived) throw new RuleError('validation', `section '${s.id}' of ${kind}/${current.id} is archived; archived sections are never restored (insert a new section)`, undefined, 409);
      if (stable(n) !== stable(s)) throw new RuleError('validation', `section '${s.id}' of ${kind}/${current.id} is archived; archived sections are kept as they were (links included)`, undefined, 409);
    }
  }

  async beforeWrite<D extends Doc>(kind: Kind, next: D, current: D | undefined, ctx: WriteContext): Promise<D> {
    const m = await this.deps.model();
    if (kind === 'specs') {
      const from = (current as StoredSpec | undefined)?.status;
      const to = (next as unknown as StoredSpec).status;
      if (from && from !== to && !SPEC_TRANSITIONS[from].includes(to)) throw new RuleError('invalid_transition', `${next.id}: ${from} -> ${to} is not allowed (allowed: ${SPEC_TRANSITIONS[from].join(', ') || 'none'})`, undefined, 409);
    }
    if (kind === 'components') {
      const c = next as unknown as StoredComponent;
      const from = (current as StoredComponent | undefined)?.status;
      if (from && from !== c.status && !COMPONENT_TRANSITIONS[from].includes(c.status)) throw new RuleError('invalid_transition', `${c.id}: ${from} -> ${c.status} is not allowed`);
      const bad = next.sections.filter((s) => s.type === 'rule' || s.type === 'acceptance');
      if (bad.length) throw new RuleError('invalid_section_type', `components describe architecture; criteria belong to specs and rules to standards (${bad.map((s) => s.id).join(', ')})`, undefined, 400);
      // Containment (parent): an existing component, never itself (cycles: the combined graph check in links.validate).
      if (c.parent !== undefined) {
        if (c.parent === c.id) throw new RuleError('invalid_parent', `${c.id}: a component cannot be its own parent`, undefined, 400);
        const parent = (m.components ?? []).find((x) => x.id === c.parent);
        if (!parent) throw new RuleError('invalid_parent', `${c.id}: parent '${c.parent}' is not a component`, undefined, 400);
        if (parent.status === 'archived' && c.status !== 'archived') throw new RuleError('archived_parent', `${c.id}: parent '${parent.id}' is archived; a ${c.status} component cannot sit under it (pick another parent or archive it too)`);
      }
      // Archiving a parent never cascades: its children must be archived (or moved) first.
      if (c.status === 'archived' && from !== 'archived') {
        const live = (m.components ?? []).filter((x) => x.parent === c.id && x.status !== 'archived').map((x) => x.id);
        if (live.length) throw new RuleError('has_children', `${c.id}: archive or move its non-archived children first (${live.join(', ')})`, live);
      }
    } else if (kind === 'standards') {
      const std = next as unknown as StoredStandard;
      const from = (current as StoredStandard | undefined)?.status;
      if (from && from !== std.status && !STANDARD_TRANSITIONS[from].includes(std.status)) {
        throw new RuleError('invalid_transition', `${std.id}: ${from} -> ${std.status} is not allowed (allowed: ${STANDARD_TRANSITIONS[from].join(', ')})`);
      }
      if (std.status === 'deprecated') {
        if (!std.supersededBy) throw new RuleError('invalid_standard', `${std.id}: a deprecated standard needs supersededBy (its successor)`, undefined, 400);
        if (std.supersededBy === std.id || !m.standards.some((x) => x.id === std.supersededBy)) throw new RuleError('invalid_standard', `${std.id}: supersededBy '${std.supersededBy}' is not another standard`, undefined, 400);
      }
      // Standards hold rules; acceptance criteria are for specs (existing ones may stay until migrated).
      const added = next.sections.filter((s) => s.type === 'acceptance' && !current?.sections.some((x) => x.id === s.id && x.type === 'acceptance'));
      if (added.length) throw new RuleError('invalid_section_type', `standards use rule sections, not acceptance (${added.map((s) => s.id).join(', ')})`, undefined, 400);
    } else {
      const rules = next.sections.filter((s) => s.type === 'rule');
      if (rules.length) throw new RuleError('invalid_section_type', `rule sections belong to standards; specs use acceptance criteria (${rules.map((s) => s.id).join(', ')})`, undefined, 400);
    }
    if (current) this.frozen(kind, next, current);
    // Identity (C3).
    if (!current) {
      const path = this.repo(kind).pathOf(next.id);
      if ((await this.deps.git.fileHistory(['specs', 'standards', 'components'])).has(path)) throw new RuleError('id_reused', `${kind}/${next.id} existed before; ids are never reused`, undefined, 409);
    } else {
      const removed = current.sections.filter((s) => !next.sections.some((x) => x.id === s.id));
      const problems: string[] = [];
      for (const s of removed) {
        const refs = await this.inbound(kind, next.id, s.id, m);
        if (refs.length) problems.push(`section "${s.id}" is referenced (${refs.join(', ')}); archive it instead (archived: true)`);
      }
      if (problems.length) throw new RuleError('section_referenced', problems.join('; '), problems);
      const added = next.sections.filter((s) => !current.sections.some((x) => x.id === s.id));
      if (added.length) {
        const ever = await this.everSectionIds(kind, next.id);
        const reused = added.filter((s) => ever.has(s.id)).map((s) => s.id);
        if (reused.length) throw new RuleError('id_reused', `section ids ${reused.join(', ')} existed before in ${next.id}; ids are never reused`, undefined, 409);
      }
    }
    let out = await this.deps.links.validate(kind, next, current, ctx);
    if (kind === 'specs' && current) {
      const spec = out as unknown as StoredSpec;
      const cur = current as unknown as StoredSpec;
      const claimed = (await this.deps.workOrders()).some((w) => w.spec === spec.id && w.claim && OPEN_WORK_ORDER_STATUSES.includes(w.status));
      if (cur.status === 'done' || claimed) {
        const removed = await this.deps.verification.shrunk(spec, cur, m);
        if (removed.length) {
          if (!approvalOf(ctx.meta.trailers)) {
            throw new RuleError('criteria_shrink', `this change removes ${removed.length} criteria from ${spec.id} (${cur.status === 'done' ? 'done' : 'in progress'}): ${removed.map((u) => u.replace('mandate://', '')).join(', ')}; it needs the user's approval: question_ask (purpose approval), wait for the answer, retry with cause: the answered question`, removed);
          }
        }
      }
    }
    // MW-6: a standard write must not drop criteria from done or claimed specs without accepted feedback either.
    if (kind === 'standards' && current) {
      const after: Model = { ...m, standards: m.standards.map((x) => (x.id === next.id ? (out as unknown as StoredStandard) : x)) };
      const claimedSpecs = new Set((await this.deps.workOrders()).filter((w) => w.claim && OPEN_WORK_ORDER_STATUSES.includes(w.status)).map((w) => w.spec));
      const removed = m.specs.filter((sp) => sp.status === 'done' || claimedSpecs.has(sp.id)).flatMap((sp) => this.deps.verification.shrunkBy(sp, m, after).map((u) => `${sp.id}: ${u.replace('mandate://', '')}`));
      if (removed.length) {
        if (!approvalOf(ctx.meta.trailers)) throw new RuleError('criteria_shrink', `this change removes ${removed.length} criteria from done or in-progress specs (${removed.join(', ')}); it needs the user's approval: question_ask (purpose approval), wait for the answer, retry with cause: the answered question`, removed);
      }
    }
    if (kind === 'specs') out = (await this.deps.verification.gate(out as unknown as StoredSpec, current as unknown as StoredSpec | undefined, ctx)) as unknown as D;
    return out;
  }
}

/** Key-order independent JSON (frozen-content comparisons). */
function stable(v: unknown): string {
  return JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b))) : x));
}

export { ConflictError };

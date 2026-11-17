import { checkLinks, parseLinkTarget } from '@mandate/doc';
import type { Backlink, DocLinks, ResolvedLink, Section, SectionChange, SectionLinkInfo, StoredComponent, StoredSpec, StoredStandard } from '@mandate/shared';
import { userOfTrailers } from '@mandate/shared';
import type { GitStore } from '../git/GitStore.js';
import { componentCodec, specCodec, standardCodec } from './codecs.js';
import { actorOf, type WriteContext } from './GitBackedRepository.js';
import type { MarkdownDirRepository } from './MarkdownDirRepository.js';
import {
  approval,
  dependencyState,
  docArchived,
  finder,
  graphProblems,
  liveSuccessors,
  NO_SUPERSEDED_RELS,
  sectionUri,
  specCriteria,
  UPSTREAM_RELS,
  waiverPin,
  type Doc,
  type Kind,
  type Model,
} from './model.js';

class LinkValidationError extends Error {
  readonly statusCode = 400;
  readonly code = 'invalid_links';
  constructor(readonly details: string[]) {
    super(`invalid_links: ${details.join('; ')}`);
  }
}

/** The user's approval a write carries: the answered approval question cited as cause (`User-Approved: ask-NNNN` trailer, set by the tool layer from a validated question). */
export const approvalOf = (trailers: Record<string, string> | undefined): string | undefined => {
  const hit = Object.entries(trailers ?? {}).find(([k]) => k.toLowerCase() === 'user-approved')?.[1]?.trim();
  return hit || undefined;
};

/** A waiver / exemption / criteria removal that needs the user's approval and has none (409 `approval_required`). */
export class ApprovalRequiredError extends Error {
  readonly statusCode = 409;
  readonly code = 'approval_required';
  constructor(what: string) {
    super(`approval_required: ${what} needs the user's approval: ask with question_ask (purpose approval), wait for the answer, then retry with cause: the answered question`);
  }
}

/** Bodies only: a title-only rename is not an upstream change. */
const sameBody = (a?: Section, b?: Section) => !!a && !!b && a.body === b.body && a.type === b.type;
const sameLink = (a: Section['links'][number], b: Section['links'][number]) => a.to === b.to && a.rel === b.rel;

/**
 * Section-to-section links: validation at write time (direction / rel rules from @mandate/doc,
 * target existence, no new links to archived or superseded targets, waiver approval, the combined
 * cycle checks), and the derived view (resolved targets, backlinks, blocked / broken, upstream
 * changed with acknowledgement, pin lost, superseded targets, waiver states).
 */
export class LinkService {
  private atCommit = new Map<string, Doc | null>();
  /** Full repository snapshot incl. work orders and feedback (wired by createStorage). */
  model?: () => Promise<Model>;

  constructor(
    private readonly specs: MarkdownDirRepository<StoredSpec>,
    private readonly standards: MarkdownDirRepository<StoredStandard>,
    private readonly git: GitStore,
  ) {}

  /** Components repository (wired by createStorage). */
  components?: MarkdownDirRepository<StoredComponent>;

  private repo(kind: Kind): MarkdownDirRepository<Doc> {
    return (kind === 'specs' ? this.specs : kind === 'standards' ? this.standards : this.components!) as MarkdownDirRepository<Doc>;
  }

  /** A document at a commit; `undefined` when the commit itself cannot be read (pin lost). */
  async docAt(kind: Kind, id: string, commit: string): Promise<Doc | null | undefined> {
    const key = `${kind}/${id}@${commit}`;
    if (!this.atCommit.has(key)) {
      const full = await this.git.resolveCommit(commit).catch(() => null);
      if (!full) return undefined;
      const raw = await this.git.readFileAt(full, this.repo(kind).pathOf(id)).catch(() => null);
      let doc: Doc | null = null;
      try {
        doc = raw === null ? null : kind === 'specs' ? specCodec.decode(raw, id) : kind === 'standards' ? standardCodec.decode(raw, id) : componentCodec.decode(raw, id);
      } catch {
        doc = null;
      }
      this.atCommit.set(key, doc);
    }
    return this.atCommit.get(key)!;
  }

  private async all(): Promise<Model> {
    return this.model ? this.model() : { specs: await this.specs.list(), standards: await this.standards.list(), components: (await this.components?.list()) ?? [] };
  }

  /**
   * Storage hook (inside the write lock): validate the links of a document about to be written and
   * stamp server-set waiver fields (`by`, `pin`). Returns the document to store.
   */
  async validate<D extends Doc>(kind: Kind, next: D, current?: D, ctx?: WriteContext): Promise<D> {
    const problems = checkLinks(kind, next.id, next.sections);
    const m = await this.all();
    const others = { specs: m.specs.filter((d) => !(kind === 'specs' && d.id === next.id)), standards: m.standards.filter((d) => !(kind === 'standards' && d.id === next.id)) };
    const withNext: Model = {
      ...m,
      specs: kind === 'specs' ? [...others.specs, next as unknown as StoredSpec] : m.specs,
      standards: kind === 'standards' ? [...others.standards, next as unknown as StoredStandard] : m.standards,
      components: kind === 'components' ? [...(m.components ?? []).filter((d) => d.id !== next.id), next as unknown as StoredComponent] : m.components,
    };
    const head = kind === 'components' ? await this.git.resolveCommit('HEAD').catch(() => null) : null;
    const f = finder(withNext);
    const successors = liveSuccessors(m);
    // MW-2: the writer's principal: the server-resolved user (Mandate-User trailer, set from the authenticated
    // principal only), else the agent identity. Compared trimmed and case-folded (approval()).
    const actor = (ctx ? (userOfTrailers(ctx.meta.trailers) ?? actorOf(ctx.meta)) : 'local').trim();
    const approvedBy = ctx ? approvalOf(ctx.meta.trailers) : undefined;
    const sections = next.sections.map((s) => {
      const before = current?.sections.find((x) => x.id === s.id);
      const links = s.links.map((l) => {
        const t = parseLinkTarget(l.to);
        if (!t || (t.kind === kind && t.id === next.id)) return l; // reported by checkLinks
        const target = f.target(l.to);
        const isNew = !before?.links.some((b) => sameLink(b, l));
        if (!target?.doc) {
          problems.push(`section "${s.id}": ${t.kind.slice(0, -1)} '${t.id}' does not exist`);
          return l;
        }
        if (t.sectionId && !target.section) {
          problems.push(`section "${s.id}": section '${t.sectionId}' does not exist in ${t.id}`);
          return l;
        }
        if (isNew && (target.section?.archived || docArchived(target.doc))) problems.push(`section "${s.id}": ${l.to} is archived; link to what replaced it`);
        if (isNew && NO_SUPERSEDED_RELS.has(l.rel) && successors.has(l.to)) {
          problems.push(`section "${s.id}": ${l.to} is superseded; link to ${successors.get(l.to)!.join(' or ')} instead`);
        }
        // A component's dependency is pinned when added, so later interface changes show as "upstream changed".
        if (kind === 'components' && l.rel === 'depends_on' && isNew && !l.seenAt && head) return { ...l, seenAt: head };
        if (l.rel !== 'deviates_from') return l;
        // Waiver: in force only with the user's approval: an answered question_ask (purpose approval) cited as cause
        // (the tool layer validates it and adds the `User-Approved` trailer). Without it the waiver is recorded but pending.
        const prev = before?.links.find((b) => sameLink(b, l));
        if (prev && prev.note === l.note && (prev.feedback ?? '') === (l.feedback ?? '') && !(approvedBy && !prev.feedback)) return l;
        if (!approvedBy) {
          const { feedback: _f, pin: _p, by: _b, ...rest } = l;
          return { ...rest, by: actor };
        }
        return { ...l, feedback: approvedBy, by: actor, pin: waiverPin(l.to, withNext) };
      });
      return { ...s, links };
    });
    // Exemptions (spec-level opt-out of appliesTo): same approval rule as waivers.
    let exemptFrom = (next as StoredSpec).exemptFrom;
    if (kind === 'specs' && exemptFrom?.length) {
      const spec = next as unknown as StoredSpec;
      exemptFrom = exemptFrom.map((e) => {
        const prev = (current as StoredSpec | undefined)?.exemptFrom?.find((x) => x.standard === e.standard);
        if (prev && prev.reason === e.reason) return { ...e, ...(prev.feedback ? { feedback: prev.feedback } : {}), by: prev.by };
        const std = f.stds.get(e.standard);
        if (!std) problems.push(`exemptFrom: standard '${e.standard}' does not exist`);
        else if (!specCriteria({ ...spec, exemptFrom: [] }, withNext).standards.some((x) => x.id === e.standard && x.appliesBy.length)) {
          problems.push(`exemptFrom: ${e.standard} does not apply to this spec through appliesTo`);
        }
        if (!approvedBy) problems.push(`exemptFrom ${e.standard}: needs the user's approval: ask (question_ask purpose approval), wait for the answer, then retry with cause: the answered question`);
        return { ...e, feedback: approvedBy ?? e.feedback, by: actor };
      });
    }
    // Only problems that involve this document block the write (pre-existing ones elsewhere are lint issues). MW-3:
    // cycles are searched through this document's nodes (an unrelated cycle never hides a new one); exact URIs (no
    // prefix match: specs/auth is not specs/auth-flow).
    const self = `mandate://${kind}/${next.id}`;
    const mine = (u: string) => u === self || u.startsWith(`${self}/`);
    for (const p of graphProblems(withNext, mine)) if ((p.nodes ?? [p.uri]).some(mine)) problems.push(p.message);
    if (problems.length) throw new LinkValidationError([...new Set(problems)]);
    return { ...next, sections, ...(kind === 'specs' ? { exemptFrom } : {}) };
  }

  /** Every link in the repository as (source, link) pairs. */
  private allLinks(m: Model) {
    const out: { kind: Kind; doc: Doc; section: Section; link: Section['links'][number] }[] = [];
    for (const [kind, list] of [['specs', m.specs], ['standards', m.standards], ['components', m.components ?? []]] as const) {
      for (const doc of list) for (const section of doc.sections) for (const link of section.links) out.push({ kind, doc: doc as Doc, section, link });
    }
    return out;
  }

  /**
   * The edits of a section after `since` (oldest first): who, when, commit and the plain-language change summary the editor
   * gave (`Change-Summary` trailer; null for legacy edits). Whole-document targets: every section that changed.
   */
  async changes(kind: Kind, id: string, sectionId: string | undefined, since: string): Promise<SectionChange[]> {
    const path = this.repo(kind).pathOf(id);
    const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
    const hist = (await this.git.fileHistory([dir])).get(path) ?? [];
    const base = await this.git.resolveCommit(since).catch(() => null);
    const chain: typeof hist = [];
    for (const c of hist) {
      if (c.id === base) break;
      chain.push(c);
    }
    const out: SectionChange[] = [];
    const view = async (commit: string) => {
      const d = await this.docAt(kind, id, commit);
      return sectionId ? [d?.sections.find((x) => x.id === sectionId)] : (d?.sections ?? []);
    };
    let prev = await view(since);
    for (const c of chain.slice(0, 30).reverse()) {
      const cur = await view(c.id);
      const differs = sectionId ? !sameBody(prev[0], cur[0]) : cur.length !== prev.length || cur.some((x) => !sameBody(prev.find((y) => y?.id === x?.id), x));
      if (differs) {
        const m = /^Change-Summary:[ \t]*(.+)$/im.exec(c.message);
        out.push({ commit: c.id, by: c.authorName, at: c.date, summary: m ? m[1]!.trim() : null });
      }
      prev = cur;
    }
    return out;
  }

  /** Has the target changed since `pin` (pinLost when the commit cannot be read)? */
  private async changedSince(target: NonNullable<ReturnType<ReturnType<typeof finder>['target']>>, pin: string): Promise<{ changed: boolean; pinLost: boolean }> {
    const then = await this.docAt(target.kind, target.id, pin);
    if (then === undefined) return { changed: false, pinLost: true };
    if (target.sectionId) return { changed: !sameBody(then?.sections.find((x) => x.id === target.sectionId), target.section), pinLost: false };
    const now = target.doc?.sections ?? [];
    const was = then?.sections ?? [];
    return { changed: now.length !== was.length || now.some((s) => !sameBody(was.find((x) => x.id === s.id), s)), pinLost: false };
  }

  /** Links, backlinks and derived states for every section of a document. */
  async forDoc(kind: Kind, doc: Doc): Promise<DocLinks> {
    const m = await this.all();
    const f = finder(m);
    const links = this.allLinks(m);
    const successors = liveSuccessors(m);
    const waivers = kind === 'specs' ? specCriteria(doc as StoredSpec, m).waivers : new Map();
    const sections: Record<string, SectionLinkInfo> = {};
    for (const s of doc.sections) {
      const outgoing: ResolvedLink[] = [];
      for (const l of s.links) {
        const t = f.target(l.to);
        if (!t) continue;
        let upstreamChanged = false;
        let pinLost = false;
        // Only relations that oblige the source; acknowledged via `seenAt` (else compared with implementedCommit).
        const pin = l.seenAt ?? s.implementedCommit;
        if (UPSTREAM_RELS.has(l.rel) && t.doc && (t.section || !t.sectionId) && pin) {
          ({ changed: upstreamChanged, pinLost } = await this.changedSince(t, pin));
        }
        const archived = !!t.section?.archived || docArchived(t.doc);
        const waiver = l.rel === 'deviates_from' ? [...waivers.values()].find((w) => w.section === s.id && (w.feedback ?? '') === (l.feedback ?? ''))?.state ?? approval({ feedback: l.feedback, by: l.by }, m) : undefined;
        outgoing.push({
          to: l.to,
          rel: l.rel,
          ...(l.note ? { note: l.note } : {}),
          kind: t.kind,
          docId: t.id,
          docTitle: t.doc?.title ?? null,
          ...(t.sectionId ? { sectionId: t.sectionId } : {}),
          sectionTitle: t.sectionId ? (t.section?.title ?? null) : (t.doc?.title ?? null),
          ...(t.section?.summary ? { summary: t.section.summary } : {}),
          exists: !!t.doc && (!t.sectionId || !!t.section),
          ...(t.kind === 'specs' ? { implemented: !!t.section?.implementedCommit } : {}),
          ...(archived ? { archived } : {}),
          upstreamChanged,
          ...(upstreamChanged && pin ? { changes: await this.changes(t.kind, t.id, t.sectionId, pin).catch(() => [] as SectionChange[]) } : {}),
          ...(pinLost ? { pinLost } : {}),
          ...(successors.has(l.to) ? { supersededBy: successors.get(l.to)![0] } : {}),
          ...(waiver ? { waiver } : {}),
          ...(l.feedback ? { feedback: l.feedback } : {}),
          ...(l.seenAt ? { seenAt: l.seenAt } : {}),
        });
      }
      const uri = sectionUri(kind, doc.id, s.id);
      const docRef = `mandate://${kind}/${doc.id}`;
      const backlinks: Backlink[] = links
        .filter((x) => x.link.to === uri || (kind === 'standards' && x.link.to === docRef && s === doc.sections[0]))
        .map((x) => ({
          from: sectionUri(x.kind, x.doc.id, x.section.id),
          kind: x.kind,
          docId: x.doc.id,
          docTitle: x.doc.title,
          sectionId: x.section.id,
          sectionTitle: x.section.title,
          rel: x.link.rel,
          ...(x.link.note ? { note: x.link.note } : {}),
          ...('status' in x.doc ? { docStatus: x.doc.status } : {}),
        }));
      // depends_on, and affects links to components (an archived component makes both a "Broken dependency").
      const deps = s.links.filter((l) => l.rel === 'depends_on' || (l.rel === 'affects' && l.to.startsWith('mandate://components/'))).map((l) => dependencyState(l.to, f));
      sections[s.id] = {
        outgoing,
        backlinks,
        blocked: deps.includes('blocked'),
        broken: deps.includes('broken'),
        upstreamChanged: outgoing.some((o) => o.upstreamChanged),
        pinLost: outgoing.some((o) => o.pinLost),
        supersededTargets: outgoing.filter((o) => o.supersededBy).map((o) => o.to),
      };
    }

    const warnings: string[] = [];
    const supersededStandards: string[] = [];
    if (kind === 'specs') {
      const spec = doc as StoredSpec;
      const used = specCriteria(spec, m).standards.filter((x) => !x.exempt).map((x) => f.stds.get(x.id)).filter((x): x is StoredStandard => !!x);
      const usedIds = new Set(used.map((u) => u.id));
      for (const std of used) {
        const superseded = links.filter((x) => x.link.rel === 'supersedes' && x.link.to.startsWith(`mandate://standards/${std.id}/sections/`));
        if (superseded.length) {
          supersededStandards.push(std.id);
          warnings.push(`${std.title} is partly superseded by ${[...new Set(superseded.map((x) => x.doc.title))].join(', ')}.`);
        }
      }
      for (const x of links.filter((l) => l.kind === 'standards' && l.link.rel === 'conflicts_with')) {
        const other = parseLinkTarget(x.link.to);
        if (other && usedIds.has(x.doc.id) && usedIds.has(other.id)) {
          warnings.push(`Uses conflicting standards: ${x.doc.title} (${x.section.title}) conflicts with ${f.stds.get(other.id)?.title ?? other.id}.`);
        }
      }
    }
    return { sections, warnings, supersededStandards };
  }

  /** Sections blocked by section-level depends_on (target exists but is not implemented), for list views. */
  async blockedSections(specs: StoredSpec[]): Promise<Record<string, string[]>> {
    return this.depSections(specs, 'blocked');
  }

  /** Sections whose depends_on target is archived or missing ("Broken dependency"). */
  async brokenSections(specs: StoredSpec[]): Promise<Record<string, string[]>> {
    return this.depSections(specs, 'broken');
  }

  private async depSections(specs: StoredSpec[], state: 'blocked' | 'broken'): Promise<Record<string, string[]>> {
    const f = finder({ specs: await this.specs.list(), standards: await this.standards.list() });
    const out: Record<string, string[]> = {};
    for (const spec of specs) {
      out[spec.id] = spec.sections.filter((s) => !s.archived && s.links.some((l) => l.rel === 'depends_on' && dependencyState(l.to, f) === state)).map((s) => s.id);
    }
    return out;
  }
}

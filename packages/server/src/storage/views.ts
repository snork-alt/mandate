/**
 * Document VIEWS for the web UI (served over MCP): the full, derived payloads the UI renders — lists with rollups,
 * detail with verification / links / derived states, versions, raw files, usage, implementation, per-doc feedback,
 * git log. (These were the REST responses; MCP is now the only interface.) Inputs are validated by the schemas in
 * `@mandate/shared` (`docListInputSchema`, ...).
 */
import {
  docFeedbackInputSchema,
  docGetInputSchema,
  docListInputSchema,
  docRawInputSchema,
  gitLogInputSchema,
  sectionTypesInputSchema,
  specImplementationInputSchema,
  standardUsage,
  standardUsageInputSchema,
  versionGetInputSchema,
  type DocFeedbackInput,
  type DocGetInput,
  type DocListInput,
  type DocRawInput,
  type FileMeta,
  type GitLogInput,
  type SectionTypeInfo,
  type SpecImplementationInput,
  type StandardUsage,
  type StandardUsageInput,
  type StoredComponent,
  type StoredSpec,
  type StoredStandard,
  type VersionGetInput,
} from '@mandate/shared';
import { deriveComponents, deriveSpecs, model, sectionTypes, type Storage } from './index.js';
import { ReadError } from './read.js';

type FileKind = 'specs' | 'standards' | 'components';

export class DocViewService {
  constructor(private readonly storage: Storage) {}

  private repo(kind: FileKind) {
    return kind === 'specs' ? this.storage.specs : kind === 'standards' ? this.storage.standards : this.storage.components;
  }

  private meta(kind: FileKind, id: string): Promise<FileMeta> {
    return this.storage.history.meta(this.repo(kind).pathOf(id));
  }

  /** Every entity of a kind with git-derived times and list rollups (files: newest change first; work orders: file order). */
  async list(input: DocListInput): Promise<{ items: Record<string, unknown>[] }> {
    const { kind } = docListInputSchema.parse(input);
    const s = this.storage;
    if (kind === 'work-orders') return { items: (await s.workOrderService.list()) as unknown as Record<string, unknown>[] };
    if (kind === 'feedback') return { items: (await s.feedbackService.list()) as unknown as Record<string, unknown>[] };
    const raw = (await this.repo(kind).list()) as (StoredSpec | StoredStandard | StoredComponent)[];
    let extra: Record<string, Record<string, unknown>> = {};
    if (kind === 'specs') {
      const specs = raw as StoredSpec[];
      const rollups = await s.verificationService.rollups(specs);
      const blocked = await s.linkService.blockedSections(specs);
      const derived = await deriveSpecs(specs, await s.model(), s.verificationService);
      extra = Object.fromEntries(specs.map((x) => [x.id, { ...derived[x.id], verification: rollups[x.id], blockedSections: blocked[x.id] ?? [] }]));
    } else if (kind === 'standards') {
      const specs = (await s.specs.list()).filter((x) => x.status !== 'archived');
      // usedBy counts approved exemptions only (unapproved ones do not exempt).
      const counts = (std: StoredStandard) => {
        const c = { must: 0, should: 0, may: 0 };
        for (const sec of std.sections) if (sec.type === 'rule' && !sec.archived) c[(sec.level as 'must' | 'should' | 'may' | undefined) ?? 'should']++;
        return c;
      };
      extra = Object.fromEntries(
        (raw as StoredStandard[]).map((std) => [std.id, { usedBy: std.status === 'draft' ? 0 : standardUsage(std, specs).length, ruleCounts: counts(std), inForce: model.standardInForce(std) }]),
      );
    } else {
      extra = (await deriveComponents(raw as StoredComponent[], await s.model(), { verification: s.verificationService })) as unknown as Record<string, Record<string, unknown>>;
    }
    const items = await Promise.all(raw.map(async (e) => ({ ...e, ...(await this.meta(kind, e.id)), ...extra[e.id] })));
    items.sort((a, b) => (b as unknown as FileMeta).updatedAt.localeCompare((a as unknown as FileMeta).updatedAt));
    return { items };
  }

  /** One spec / standard / component with derived detail (verification, links, derived states). */
  async get(input: DocGetInput): Promise<Record<string, unknown>> {
    const { kind, id } = docGetInputSchema.parse(input);
    const s = this.storage;
    const entity = await this.repo(kind).get(id);
    let detail: Record<string, unknown> = {};
    if (kind === 'specs') {
      const spec = entity as StoredSpec;
      detail = {
        ...(await deriveSpecs([spec], await s.model(), s.verificationService))[spec.id],
        verification: await s.verificationService.forSpec(spec),
        links: await s.linkService.forDoc('specs', spec),
      };
    } else if (kind === 'standards') {
      const std = entity as StoredStandard;
      detail = { verification: await s.verificationService.forStandard(std), links: await s.linkService.forDoc('standards', std) };
    } else {
      const c = entity as StoredComponent;
      detail = {
        ...((await deriveComponents([c], await s.model(), { verification: s.verificationService, links: s.linkService })) as unknown as Record<string, Record<string, unknown>>)[c.id],
        links: await s.linkService.forDoc('components', c),
      };
    }
    return { ...entity, ...(await this.meta(kind, id)), ...detail };
  }

  /** A version of a document at a commit, with what it is compared against (works for deleted docs: history is in git). */
  async version(input: VersionGetInput) {
    const { kind, id, commit, against, base } = versionGetInputSchema.parse(input);
    const full = await this.storage.git.resolveCommit(commit);
    if (!full) throw new ReadError(`unknown commit '${commit}'`, 'unknown_commit', 'take a sha from history_get', 'commit', 404);
    return this.storage.history.version(this.repo(kind).pathOf(id), full, against, base);
  }

  /** The stored file text at HEAD (null when the file does not exist). */
  async raw(input: DocRawInput): Promise<{ text: string | null }> {
    const { kind, id } = docRawInputSchema.parse(input);
    return { text: await this.repo(kind).raw(id) };
  }

  /** Specs using a standard (directly, in sections, via appliesTo or follows links), archived ones included. */
  async standardUsage(input: StandardUsageInput): Promise<{ items: StandardUsage[] }> {
    const { id } = standardUsageInputSchema.parse(input);
    return { items: standardUsage(await this.storage.standards.get(id), await this.storage.specs.list()) };
  }

  /** Per-section implementation state of a spec (implementedCommit, outdated). */
  async specImplementation(input: SpecImplementationInput) {
    const { id } = specImplementationInputSchema.parse(input);
    return { sections: await this.storage.workOrderService.implementation(id) };
  }

  /** Feedback targeting one document, with open counts per section. */
  async docFeedback(input: DocFeedbackInput) {
    const { kind, id } = docFeedbackInputSchema.parse(input);
    await this.repo(kind).get(id);
    return this.storage.feedbackService.forDoc(kind as never, id);
  }

  sectionTypes(input: Record<string, never> = {}): { items: SectionTypeInfo[] } {
    sectionTypesInputSchema.parse(input);
    return { items: sectionTypes.list().map(({ id, label, description, fence }) => ({ id, label: label ?? id, description, fence })) };
  }

  async gitLog(input: GitLogInput) {
    const { limit } = gitLogInputSchema.parse(input);
    return { items: await this.storage.git.log(limit) };
  }
}

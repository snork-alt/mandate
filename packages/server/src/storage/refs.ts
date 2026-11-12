import { buildArchitectureRef, buildRef, parseNodeUri, parseRef, resolveReferenceSchema, type ResolveReferenceInput, type ResolvedReference } from '@mandate/shared';
import { NotFoundError } from './GitBackedRepository.js';
import { componentCodec, specCodec, standardCodec } from './codecs.js';
import type { Storage } from './index.js';

class ValidationError extends Error {
  readonly statusCode = 400;
}

/**
 * Resolve a reference (service for MCP tools): short shas become full ones, versioned references
 * read the document AT that commit (sections may since have moved or been deleted), and `#L`
 * ranges are mapped to the text of the file at that version.
 */
export async function resolveReference(storage: Pick<Storage, 'git' | 'specs' | 'standards' | 'components'>, input: ResolveReferenceInput): Promise<ResolvedReference> {
  const { uri } = resolveReferenceSchema.parse(input);
  const node = parseNodeUri(uri);
  if (node?.kind === 'architecture') {
    const commit = node.commit ? ((await storage.git.resolveCommit(node.commit)) ?? undefined) : undefined;
    if (node.commit && !commit) throw new NotFoundError(`unknown commit '${node.commit}'`);
    if (node.focus && !(await storage.components.raw(node.focus))) throw new NotFoundError(`component '${node.focus}' does not exist`);
    return { uri: buildArchitectureRef({ commit, focus: node.focus }), kind: 'architecture', id: node.focus ?? 'architecture', ...(commit ? { commit } : {}), existsAtHead: true };
  }
  const ref = parseRef(uri);
  if (!ref) throw new ValidationError(`not a mandate:// reference: ${uri}`);
  if (ref.kind !== 'specs' && ref.kind !== 'standards' && ref.kind !== 'components') {
    return { uri: buildRef(ref), kind: ref.kind, id: ref.id, existsAtHead: true };
  }
  const repo = (ref.kind === 'specs' ? storage.specs : ref.kind === 'standards' ? storage.standards : storage.components) as Storage['specs'];
  const file = repo.pathOf(ref.id);
  let commit: string | undefined;
  if (ref.commit) {
    commit = (await storage.git.resolveCommit(ref.commit)) ?? undefined;
    if (!commit) throw new NotFoundError(`unknown commit '${ref.commit}'`);
  }
  const text = commit ? await storage.git.readFileAt(commit, file) : await repo.raw(ref.id);
  if (text === null) throw new NotFoundError(`${ref.kind}/${ref.id} does not exist${commit ? ` at ${commit.slice(0, 7)}` : ''}`);
  let sectionTitle: string | null | undefined;
  let existsAtHead = true;
  if (ref.sectionId) {
    const doc = ref.kind === 'specs' ? specCodec.decode(text, ref.id) : ref.kind === 'standards' ? standardCodec.decode(text, ref.id) : componentCodec.decode(text, ref.id);
    sectionTitle = doc.sections.find((s) => s.id === ref.sectionId)?.title ?? null;
    const head = await repo.get(ref.id).catch(() => null);
    existsAtHead = !!head?.sections.some((s) => s.id === ref.sectionId);
  } else {
    existsAtHead = (await repo.raw(ref.id)) !== null;
  }
  const lines = ref.lines;
  const all = text.split('\n');
  return {
    uri: buildRef({ ...ref, commit }),
    kind: ref.kind,
    id: ref.id,
    ...(commit ? { commit } : {}),
    ...(ref.sectionId ? { sectionId: ref.sectionId, sectionTitle } : {}),
    existsAtHead,
    ...(lines ? { lines, text: all.slice(lines.start - 1, lines.end).join('\n') } : {}),
  };
}

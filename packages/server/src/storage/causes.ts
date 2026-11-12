/**
 * `cause` of a write (lineage-brief §2): every reference must resolve to an existing feedback item, audit finding,
 * work order, spec / standard / component (or section), audit, verification, comment or Mandate commit. Returns the
 * canonical references (`mandate://...`, no `@mandate:` prefix, no pinned version or line range).
 */
import { buildNodeUri, buildRef, CAUSE_KINDS, parseNodeUri, WO_RESERVED_SECTIONS } from '@mandate/shared';
import { woSectionId } from './work-order-docs.js';
import type { Storage } from './index.js';

export class CauseError extends Error {
  readonly statusCode = 400;
  readonly code = 'invalid_cause';
  constructor(
    message: string,
    readonly path: string,
  ) {
    super(message);
  }
}

type CauseStorage = Pick<Storage, 'git' | 'specs' | 'standards' | 'components' | 'feedback' | 'workOrders' | 'audits' | 'verifications' | 'commentService'> & { questionService?: Pick<Storage['questionService'], 'lines'> };

/** Validate and canonicalize causes (max 20). Throws `CauseError` naming the first unresolvable one. */
export async function resolveCauses(storage: CauseStorage, input: string | string[] | undefined): Promise<string[]> {
  if (input === undefined) return [];
  const list = Array.isArray(input) ? input : [input];
  const out: string[] = [];
  for (let i = 0; i < list.length; i++) {
    const raw = list[i]!;
    const path = Array.isArray(input) ? `cause.${i}` : 'cause';
    const n = parseNodeUri(raw);
    if (!n || !(CAUSE_KINDS as readonly string[]).includes(n.kind)) throw new CauseError(`'${raw}' is not a cause reference (${CAUSE_KINDS.join(', ')})`, path);
    const missing = (what: string) => new CauseError(`cause ${what} does not exist`, path);
    let uri: string;
    switch (n.kind) {
      case 'specs':
      case 'standards':
      case 'components': {
        const repo = (n.kind === 'specs' ? storage.specs : n.kind === 'standards' ? storage.standards : storage.components) as Storage['specs'];
        const doc = await repo.get(n.id).catch(() => null);
        if (!doc) throw missing(`${n.kind}/${n.id}`);
        if (n.sectionId && !doc.sections.some((s) => s.id === n.sectionId)) throw missing(`section ${n.kind}/${n.id}/sections/${n.sectionId}`);
        uri = buildRef({ kind: n.kind, id: n.id, ...(n.sectionId ? { sectionId: n.sectionId } : {}) });
        break;
      }
      case 'feedback':
        if (!(await storage.feedback.get(n.id).catch(() => null))) throw missing(`feedback/${n.id}`);
        uri = buildRef({ kind: 'feedback', id: n.id });
        break;
      case 'work-orders': {
        const wo = await storage.workOrders.get(n.id).catch(() => null);
        if (!wo) throw missing(`work-orders/${n.id}`);
        // MW-25: a work-order section is one of its sections (spec section id or wo-section id).
        const sid = n.sectionId;
        if (sid && !(WO_RESERVED_SECTIONS as readonly string[]).includes(sid) && !wo.sections.some((s) => s.id === sid || woSectionId(s.id) === sid)) throw missing(`section work-orders/${n.id}/sections/${sid}`);
        uri = buildRef({ kind: 'work-orders', id: n.id, ...(n.sectionId ? { sectionId: n.sectionId } : {}) });
        break;
      }
      case 'audits': {
        const a = await storage.audits.get(n.id).catch(() => null);
        if (!a) throw missing(`audits/${n.id}`);
        uri = buildRef({ kind: 'audits', id: n.id });
        break;
      }
      case 'findings': {
        const a = await storage.audits.get(n.audit).catch(() => null);
        const found = (a?.sections as { findings?: { id: string }[] }[] | undefined)?.some((s) => (s.findings ?? []).some((f) => f.id === n.id));
        if (!found) throw missing(`finding ${n.id} of audit ${n.audit}`);
        uri = buildNodeUri(n);
        break;
      }
      case 'verifications':
        if (!(await storage.verifications.get(n.id).catch(() => null))) throw missing(`verification ${n.id}`);
        uri = buildNodeUri(n);
        break;
      case 'comments': {
        const lines = await storage.commentService.lines();
        if (!lines.some((l) => (l as { id?: string }).id === n.id)) throw missing(`comment ${n.id}`);
        uri = buildNodeUri(n);
        break;
      }
      case 'questions': {
        const lines = (await storage.questionService?.lines()) ?? [];
        if (!lines.some((l) => !('questionId' in l) && l.id === n.id)) throw missing(`question ${n.id}`);
        uri = buildNodeUri(n);
        break;
      }
      case 'commits': {
        const sha = await storage.git.resolveCommit(n.sha).catch(() => null);
        if (!sha) throw missing(`commit ${n.sha}`);
        uri = buildNodeUri({ kind: 'commits', sha });
        break;
      }
      default:
        throw new CauseError(`'${raw}' is not a cause reference`, path);
    }
    if (!out.includes(uri)) out.push(uri);
  }
  return out;
}

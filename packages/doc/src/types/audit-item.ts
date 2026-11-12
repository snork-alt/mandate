import { z } from 'zod';
import type { GraphEdge, GraphNode, SectionTypeDef } from '../registry.js';
import { AUDIT_ITEM_RESULTS, auditFindingSchema, auditItemRecheckSchema, type AuditFindingMeta, type Section } from '../schema.js';
import type { IndexLine } from '../split/extract.js';

/** Frontmatter entry of an audit item: the checked criterion / rule, its level, the result and the findings. */
export const auditItemMetaSchema = z
  .object({
    ref: z.string().regex(/^mandate:\/\/(specs|standards)\/[a-z0-9-]+\/sections\/[a-z0-9-]+$/, 'ref must be a criterion or rule section URI'),
    kind: z.enum(['criterion', 'rule'], { message: 'kind must be criterion or rule' }),
    level: z.enum(['must', 'should', 'may'], { message: 'level must be must, should or may' }),
    result: z.enum(AUDIT_ITEM_RESULTS, { message: `result must be one of ${AUDIT_ITEM_RESULTS.join(', ')}` }),
    hash: z.string().min(1).optional(),
    findings: z.array(auditFindingSchema).optional(),
    itemRechecks: z.array(auditItemRecheckSchema).optional(),
  })
  .superRefine((m, ctx) => {
    const ids = (m.findings ?? []).map((f) => f.id);
    const dup = ids.find((id, i) => ids.indexOf(id) !== i);
    if (dup) ctx.addIssue({ code: 'custom', path: ['findings'], message: `duplicate finding id "${dup}"` });
    if (m.level === 'may' && (m.findings ?? []).some((f) => f.severity !== 'info')) ctx.addIssue({ code: 'custom', path: ['findings'], message: 'findings of may items are info at most' });
    if (m.level === 'should' && (m.findings ?? []).some((f) => f.severity === 'critical')) ctx.addIssue({ code: 'custom', path: ['findings'], message: 'findings of should items are major at most' });
  });

const findingText = (f: AuditFindingMeta) => [f.title, f.description, f.suggestedFix ?? '', f.evidence ?? '', f.codeRefs.join(' ')].filter(Boolean).join('\n');

/**
 * One checklist item of an audit report: the meta names the criterion / rule checked (`ref`, `kind`, `level`),
 * the `result` and the `findings` (severity, classification, code refs, resolution, re-checks); the body explains in
 * prose how the code was checked and why it passes or fails. Findings are graph nodes
 * (`mandate://audits/<id>/findings/<fid>`).
 */
export const auditItemType: SectionTypeDef = {
  id: 'audit-item',
  label: 'Audit item',
  description: 'One checklist item of an audit: ref (criterion / rule URI), kind, level, result (pending|pass|fail|partial|n_a), findings[] (severity, classification, codeRefs, description, suggestedFix, resolution); body: how it was checked and why it passes or fails.',
  metaSchema: auditItemMetaSchema,
  toIndexText(section: Section): IndexLine[] {
    const lines: IndexLine[] = section.body.split('\n').map((text, i) => ({ text, line: i + 1 }));
    for (const f of section.findings ?? []) for (const text of findingText(f).split('\n')) lines.push({ text, line: 1 });
    return lines;
  },
  extractNodes(section, docUri): GraphNode[] {
    return (section.findings ?? []).map((f) => ({ uri: `${docUri}/findings/${f.id}`, kind: 'finding', label: f.title, text: findingText(f) }));
  },
  extractEdges(section, docUri): GraphEdge[] {
    const out: GraphEdge[] = section.ref ? [{ from: `${docUri}/sections/${section.id}`, to: section.ref, kind: 'checks' }] : [];
    for (const f of section.findings ?? []) out.push({ from: `${docUri}/findings/${f.id}`, to: `${docUri}/sections/${section.id}`, kind: 'finding-of' });
    return out;
  },
};

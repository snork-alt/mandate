/**
 * `spec_match`: where does a natural-language request fit? Hybrid search over specs and sections, scored by term
 * coverage (title, summary, body) and search rank, with graph context (components affected, standards followed) and a
 * heuristic decision hint (extend a section / new section in a spec / new spec). The agent decides; this ranks.
 */
import { z } from 'zod';
import type { SearchGroup } from '@mandate/shared';
import { finder, sectionUri, specComponents } from '../../storage/model.js';
import { defineTool, needIndex } from '../define.js';

const STOP = new Set(
  'a an and are as at be but by can do for from has have how i in into is it its let make me my need needs new not of on or our please should so some that the their them then there these this to us use want we when which will with would you your add allow support change update feature able also more than just like each every user users'.split(' '),
);

/** Significant terms of a request: lowercase words of 3+ letters, minus stop words, crude singular. */
export function terms(text: string): string[] {
  const out = new Set<string>();
  for (const w of text.toLowerCase().match(/[a-z0-9][a-z0-9_-]{2,}/g) ?? []) {
    if (STOP.has(w)) continue;
    out.add(w.length > 4 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w);
  }
  return [...out].slice(0, 40);
}

/** Share of `ts` found in `text` (prefix match on words, so "token" matches "tokens"). */
export function coverage(ts: string[], text: string): { share: number; hit: string[] } {
  if (!ts.length) return { share: 0, hit: [] };
  const words = new Set(text.toLowerCase().match(/[a-z0-9][a-z0-9_-]*/g) ?? []);
  const hit = ts.filter((t) => words.has(t) || [...words].some((w) => w.startsWith(t)));
  return { share: hit.length / ts.length, hit };
}

export const specMatchInputSchema = z
  .object({
    /** The user's request, in their words. */
    request: z.string().trim().min(3, 'describe the request (3+ characters)').max(2000),
    /** Candidate specs (default 5). */
    limit: z.number().int().min(1).max(10).default(5),
    /** Sections per candidate (default 3). */
    sectionsPerSpec: z.number().int().min(1).max(5).default(3),
    /** Include archived specs (default false). */
    includeArchived: z.boolean().default(false),
    /** The request this match is for: records the match on it (flow_next and the work-order gate read it). */
    for: z.string().trim().min(1).optional(),
  })
  .strict();

type Decision = 'extend_section' | 'new_section' | 'new_spec';

export const matchTools = [
  defineTool({
    name: 'spec_match',
    title: 'Match a request to specs',
    kind: 'read',
    description: `Where does a feature / change request fit? Pass it in the user's words; call right after request_create with for: <request id> (records the match on the request; the work-order gate needs it).
Returns top candidate specs (fit 0..1, reasons, best sections, affected components, standards, criteria count) and a suggestion extend_section | new_section | new_spec (you decide; also consider "already covered" or a standard).
Example: {"request":"let users stay signed in for 30 days"}`,
    input: specMatchInputSchema,
    run: async (a, ctx) => {
      const index = needIndex(ctx);
      const ts = terms(a.request);
      const res = await index.search({ q: a.request.slice(0, 500), kinds: ['spec', 'section'], limit: 20 });
      const model = await ctx.storage.model();
      const f = finder(model);
      const groups = res.groups.filter((g: SearchGroup) => g.docKind === 'spec');
      const top = groups[0]?.score ?? 0;
      const candidates = [];
      for (const g of groups) {
        const t = f.target(g.docUri);
        const spec = t?.kind === 'specs' ? f.specs.get(t.id) : undefined;
        if (!spec || (!a.includeArchived && spec.status === 'archived')) continue;
        const live = spec.sections.filter((s) => !s.archived);
        const specText = [spec.title, ...live.map((s) => `${s.title} ${s.summary ?? ''} ${s.body}`)].join(' ');
        const specCov = coverage(ts, specText);
        // Sections: the search hits first, then the best-covering sections of the spec.
        const hitIds = [...new Set(g.hits.map((h) => h.sectionId).filter((x): x is string => !!x))];
        const scored = live
          .filter((s) => s.type !== 'acceptance')
          .map((s) => {
            const cov = coverage(ts, `${s.title} ${s.summary ?? ''} ${s.body}`);
            const hit = g.hits.find((h) => h.sectionId === s.id);
            const searchBoost = hit ? 0.3 * (1 - hitIds.indexOf(s.id) / Math.max(hitIds.length, 1)) : 0;
            return { s, cov, hit, fit: cov.share, rank: cov.share + searchBoost };
          })
          .filter((x) => x.hit || x.cov.share > 0)
          .sort((x, y) => y.rank - x.rank)
          .slice(0, a.sectionsPerSpec);
        const rel = top > 0 ? g.score / top : 0;
        // Fit is driven by term coverage (absolute); the search rank only adds a little when terms match at all.
        const bestSection = Math.max(0, ...scored.map((x) => x.fit));
        const fit = Math.round(Math.min(1, 0.5 * specCov.share + 0.4 * bestSection + (specCov.share > 0 ? 0.1 * rel : 0)) * 100) / 100;
        const sectionIds = scored.map((x) => x.s.id);
        const components = specComponents(spec, model, sectionIds.length ? sectionIds : undefined).map((c) => ({ ref: `mandate://components/${c.id}`, via: c.via, sections: c.sections }));
        const standards = [...new Set(live.filter((s) => !sectionIds.length || sectionIds.includes(s.id)).flatMap((s) => s.links.filter((l) => l.rel === 'follows').map((l) => l.to)))];
        const criteria = live.filter((s) => s.type === 'acceptance').length;
        const reasons = [
          `covers ${specCov.hit.length}/${ts.length} request terms${specCov.hit.length ? ` (${specCov.hit.slice(0, 6).join(', ')})` : ''}`,
          ...(scored[0] ? [`best section "${scored[0].s.title}"${scored[0].hit ? ` matched by ${scored[0].hit.matchedBy.join('+')}` : ''}`] : []),
          `search rank ${groups.indexOf(g) + 1}${res.semantic.used ? '' : ' (text only: semantic search unavailable)'}`,
          ...(spec.status === 'done' ? ['spec is done: a change reopens it (new work order)'] : []),
          ...(components.length ? [`affects ${components.map((c) => c.ref.split('/').pop()).join(', ')}`] : []),
        ];
        candidates.push({
          spec: { ref: `mandate://specs/${spec.id}`, title: spec.title, status: spec.status },
          fit,
          reasons,
          sections: scored.map((x) => ({
            ref: sectionUri('specs', spec.id, x.s.id),
            title: x.s.title,
            type: x.s.type,
            ...(x.s.summary ? { summary: x.s.summary } : {}),
            ...(x.hit ? { snippet: x.hit.snippet } : {}),
            fit: Math.round(x.fit * 100) / 100,
          })),
          components,
          standards,
          criteria,
        });
      }
      candidates.sort((x, y) => y.fit - x.fit);
      const best = candidates[0];
      const decision: Decision = !best || best.fit < 0.3 ? 'new_spec' : best.fit >= 0.6 && Math.max(0, ...best.sections.map((x) => x.fit)) >= 0.5 ? 'extend_section' : 'new_section';
      // `for`: record the match on the request (the flow gates read it). Not for read-only users or the web UI.
      let recorded: string | undefined;
      if (a.for && ctx.access !== 'read' && ctx.principal?.kind !== 'ui') {
        const id = a.for.replace(/^@mandate:/, '').replace(/^mandate:\/\/(?:requests|feedback)\//, '');
        const refs = candidates.slice(0, a.limit).flatMap((c) => [c.spec.ref, ...c.sections.map((x) => x.ref)]);
        await ctx.storage.lock.run(() => ctx.storage.feedbackService.recordSpecMatch(id, { by: ctx.clientName ?? 'agent', refs, decision }, { agent: ctx.clientName ?? 'agent' }));
        recorded = id;
      }
      return {
        ...(recorded ? { recordedOn: `mandate://requests/${recorded}` } : {}),
        request: a.request,
        terms: ts,
        candidates: candidates.slice(0, a.limit),
        suggestion: {
          decision,
          target: decision === 'extend_section' ? [...best!.sections].sort((x, y) => y.fit - x.fit)[0]!.ref : decision === 'new_section' ? best!.spec.ref : null,
          note: 'Heuristic: read the candidates, check whether the behaviour is already covered, and whether this is a cross-cutting rule (a standard) rather than a feature. Then confirm with the user (approval checkpoint).',
        },
        semantic: res.semantic,
      };
    },
  }),
];

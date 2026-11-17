/**
 * `spec_match`: where does a natural-language request fit? Hybrid search over specs and sections, scored by term
 * coverage (title, summary, body) and search rank, with graph context (components affected, standards followed) and a
 * heuristic decision hint (extend a section / new section in a spec / new spec). The agent decides; this ranks.
 */
import { z } from 'zod';
import { ownerOf, type SearchGroup, type StoredComponent } from '@mandate/shared';
import { rulesForCode } from '../../storage/rules.js';
import { liveComponents } from '../component-gate.js';
import { finder, levelOf, sectionUri, specComponents, standardInForce } from '../../storage/model.js';
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

/** Planned files (`repo:path`, `repo:path#L1-L9` or a bare path) as { repo?, path }. */
export function parseFiles(files: string[]): { repo?: string; path: string; label: string }[] {
  return files.map((f) => {
    const m = /^([A-Za-z0-9_.-]+):([^#\s]+)/.exec(f.trim());
    const path = (m?.[2] ?? f.split('#')[0]!.trim()).replace(/^\.\//, '');
    return { ...(m?.[1] ? { repo: m[1] } : {}), path, label: m ? `${m[1]}:${path}` : path };
  });
}
const round2 = (n: number) => Math.round(n * 100) / 100;
const matchInput = (what: string) =>
  z
    .object({
      /** The user's request, in their words. */
      request: z.string().trim().min(3, 'describe the request (3+ characters)').max(2000),
      /** Files you plan to change or add (`repo:path` or a bare path): ranks by the code ${what} covers. */
      files: z.array(z.string().trim().min(1).max(400)).max(100).optional(),
      limit: z.number().int().min(1).max(10).default(5),
      /** The request this match is for: records it on the request (flow_next and the work-order gate read it). */
      for: z.string().trim().min(1).optional(),
    })
    .strict();
export const componentMatchInputSchema = matchInput('components own');
export const standardMatchInputSchema = matchInput('standards apply to');
const requestIdOf = (v: string) => v.replace(/^@mandate:/, '').replace(/^mandate:\/\/(?:requests|feedback)\//, '');

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
  defineTool({
    name: 'component_match',
    title: 'Match a request to components',
    kind: 'read',
    description: `Which component does this change belong to? Pass the request in the user's words and, when known, the files you plan to change (repo:path). Ranks components by meaning (responsibility, tldr, interfaces: the search index) and by how many planned files their owns globs cover; each candidate has a fit 0..1 and reasons. Suggests extend_component (update the matched component: owns / interfaces, affects links from the changed spec sections) or new_component (only with a request_decision_add "no existing component covers ..."). With for: <request id> the match is recorded on the request: work_order_create is refused until it is (flow_next says when).
Example: {"request":"let users stay signed in for 30 days","files":["app:src/auth/session.ts"],"for":"fb-0007"}`,
    input: componentMatchInputSchema,
    run: async (a, ctx) => {
      const index = needIndex(ctx);
      const comps = (await liveComponents(ctx)) as StoredComponent[];
      const ts = terms(a.request);
      const files = parseFiles(a.files ?? []);
      const res = await index.search({ q: a.request.slice(0, 500), kinds: ['component'], limit: 20 });
      const rank = new Map<string, number>();
      for (const g of res.groups.filter((x: SearchGroup) => x.docKind === 'component')) rank.set(g.docUri.split('/').pop()!, rank.size + 1);
      const top = Math.max(1, rank.size);
      const owned = new Map<string, string[]>();
      const unowned: string[] = [];
      for (const f of files) {
        const o = ownerOf(f.repo, f.path, comps);
        if (o) owned.set(o.component.id, [...(owned.get(o.component.id) ?? []), f.label]);
        else unowned.push(f.label);
      }
      const candidates = comps
        .map((c) => {
          const text = [c.title, c.tldr ?? '', ...(c.sections ?? []).filter((x) => !x.archived).map((x) => `${x.title} ${x.summary ?? ''} ${x.body}`), ...c.owns.flatMap((o) => o.paths)].join(' ');
          const cov = coverage(ts, text);
          const r = rank.get(c.id);
          const rel = r ? 1 - (r - 1) / top : 0;
          const fl = owned.get(c.id) ?? [];
          const fileShare = files.length ? fl.length / files.length : 0;
          const fit = round2(Math.min(1, 0.45 * cov.share + 0.2 * rel + 0.6 * fileShare));
          const reasons = [
            ...(cov.hit.length ? [`responsibility covers ${cov.hit.length}/${ts.length} request terms (${cov.hit.slice(0, 6).join(', ')})`] : []),
            ...(r ? [`search rank ${r}${res.semantic.used ? '' : ' (text only: semantic search unavailable)'}`] : []),
            ...(fl.length ? [`owns ${fl.length}/${files.length} planned file(s): ${fl.slice(0, 4).join(', ')}`] : []),
          ];
          return { component: { ref: `mandate://components/${c.id}`, title: c.title, ...(c.tldr ? { tldr: c.tldr } : {}) }, fit, reasons, owns: c.owns, files: fl };
        })
        .filter((x) => x.fit > 0.05)
        .sort((x, y) => y.fit - x.fit)
        .slice(0, a.limit);
      const best = candidates[0];
      const decision = best && (best.fit >= 0.3 || best.files.length) ? ('extend_component' as const) : ('new_component' as const);
      let recorded: string | undefined;
      if (a.for && ctx.access !== 'read' && ctx.principal?.kind !== 'ui') {
        const id = requestIdOf(a.for);
        await ctx.storage.lock.run(() => ctx.storage.feedbackService.recordKindMatch(id, 'component', { by: ctx.clientName ?? 'agent', refs: candidates.map((c) => c.component.ref), decision }, { agent: ctx.clientName ?? 'agent' }));
        recorded = id;
      }
      return {
        ...(recorded ? { recordedOn: `mandate://requests/${recorded}` } : {}),
        request: a.request,
        candidates,
        ...(unowned.length ? { unownedFiles: unowned } : {}),
        suggestion: {
          decision,
          target: decision === 'extend_component' ? best!.component.ref : null,
          note: decision === 'extend_component' ? 'Update the matched component (component_update: extend owns / interface sections; link the changed spec sections with affects).' : 'No component fits: create one only after request_decision_add { text: "no existing component covers ...", reason }; new code that fits a component extends its owns instead.',
        },
        semantic: res.semantic,
      };
    },
  }),
  defineTool({
    name: 'standard_match',
    title: 'Match a request to standards',
    kind: 'read',
    description: `Which standards must this change follow? Pass the request in the user's words and, when known, the files you plan to change (repo:path). Ranks standards in force by their appliesTo / rule scopes for those files and by meaning (the search index); each candidate has a fit 0..1, reasons and its rules (level must | should | may). Then link the changed spec sections with section_link_add rel follows (they inherit the standard's criteria). A rule you cannot meet: a waiver (question_ask purpose approval). A new convention the request introduces: a draft standard proposal (needs the user's confirmation, never blocks). With for: <request id> the match is recorded on the request: work_order_create is refused until it is.
Example: {"request":"let users stay signed in for 30 days","files":["app:src/auth/session.ts"],"for":"fb-0007"}`,
    input: standardMatchInputSchema,
    run: async (a, ctx) => {
      const index = needIndex(ctx);
      const model = await ctx.storage.model();
      const stds = model.standards.filter((x) => standardInForce(x));
      const ts = terms(a.request);
      const files = parseFiles(a.files ?? []);
      const res = await index.search({ q: a.request.slice(0, 500), kinds: ['standard'], limit: 20 });
      const rank = new Map<string, number>();
      for (const g of res.groups.filter((x: SearchGroup) => x.docKind === 'standard')) rank.set(g.docUri.split('/').pop()!, rank.size + 1);
      const top = Math.max(1, rank.size);
      const byFile = new Map<string, { files: Set<string>; rules: Map<string, { uri: string; title: string; level: string }> }>();
      for (const f of files) {
        for (const h of rulesForCode({ ...(f.repo ? { repo: f.repo } : {}), path: f.path }, model)) {
          const id = h.standard.split('/').pop()!;
          const e = byFile.get(id) ?? { files: new Set<string>(), rules: new Map() };
          e.files.add(f.label);
          e.rules.set(h.uri, { uri: h.uri, title: h.title, level: h.level });
          byFile.set(id, e);
        }
      }
      const candidates = stds
        .map((st) => {
          const rules = st.sections.filter((x) => x.type === 'rule' && !x.archived);
          const text = [st.title, st.tldr ?? '', ...rules.map((x) => `${x.title} ${x.summary ?? ''} ${x.body}`)].join(' ');
          const cov = coverage(ts, text);
          const r = rank.get(st.id);
          const rel = r ? 1 - (r - 1) / top : 0;
          const hit = byFile.get(st.id);
          const fileShare = files.length && hit ? hit.files.size / files.length : 0;
          const fit = round2(Math.min(1, 0.4 * cov.share + 0.2 * rel + 0.7 * fileShare));
          const reasons = [
            ...(hit ? [`applies to ${hit.files.size}/${files.length} planned file(s) (appliesTo / rule scope): ${[...hit.files].slice(0, 4).join(', ')}`] : []),
            ...(cov.hit.length ? [`covers ${cov.hit.length}/${ts.length} request terms (${cov.hit.slice(0, 6).join(', ')})`] : []),
            ...(r ? [`search rank ${r}${res.semantic.used ? '' : ' (text only: semantic search unavailable)'}`] : []),
          ];
          const shown = hit ? [...hit.rules.values()] : rules.slice(0, 5).map((x) => ({ uri: `mandate://standards/${st.id}/sections/${x.id}`, title: x.title, level: levelOf(x) }));
          return { standard: { ref: `mandate://standards/${st.id}`, title: st.title, ...(st.tldr ? { tldr: st.tldr } : {}) }, fit, reasons, rules: shown, files: hit ? [...hit.files] : [] };
        })
        .filter((x) => x.fit > 0.1 || x.files.length)
        .sort((x, y) => y.fit - x.fit)
        .slice(0, a.limit);
      const decision = candidates.some((c) => c.fit >= 0.3 || c.files.length) ? ('follow' as const) : ('none' as const);
      let recorded: string | undefined;
      if (a.for && ctx.access !== 'read' && ctx.principal?.kind !== 'ui') {
        const id = requestIdOf(a.for);
        await ctx.storage.lock.run(() => ctx.storage.feedbackService.recordKindMatch(id, 'standard', { by: ctx.clientName ?? 'agent', refs: candidates.map((c) => c.standard.ref), decision }, { agent: ctx.clientName ?? 'agent' }));
        recorded = id;
      }
      return {
        ...(recorded ? { recordedOn: `mandate://requests/${recorded}` } : {}),
        request: a.request,
        candidates,
        suggestion: {
          decision,
          note: decision === 'follow' ? 'Link the changed spec sections to these standards (section_link_add rel follows) so they inherit the criteria; read the rules before coding (rules_for_code).' : 'No standard applies: nothing to follow. A convention this request introduces: propose a draft standard (needs the user\'s confirmation; it never blocks the work).',
        },
        semantic: res.semantic,
      };
    },
  }),
];

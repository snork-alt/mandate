/**
 * Component and architecture tools (read): component_list / component_get / component_section_get, architecture_get,
 * code_owner. Input schemas of the component write tools live here too (used by write.ts).
 */
import { slugSchema } from '@mandate/doc';
import {
  architectureGetInputSchema,
  COMPONENT_KINDS,
  COMPONENT_STATUSES,
  DEFAULT_LAYER_ORDER,
  componentDocRefSchema,
  commitRefSchema,
  docRefSchema,
  layerSchema,
  ownsSchema,
  componentSectionCreateSchema,
  sectionRefSchema,
} from '@mandate/shared';
import { z } from 'zod';
import { defineTool } from '../define.js';
import { sectionGetWithImage, withImageMeta } from '../images.js';

const line = (max: number) => z.string().trim().min(1).max(max).regex(/^[^\r\n]*$/, 'single line');
const list = <T extends z.ZodType>(item: T, max = 20) => z.array(item).min(1).max(max);
const REF_NOTE = 'ref: an id or any mandate://components reference form (@sha reads that version, #Lx-Ly an excerpt).';

/* ---------------------------------------------------------------- read schemas */

export const componentListInputSchema = z
  .object({
    kind: list(z.enum(COMPONENT_KINDS), 5).optional(),
    status: list(z.enum(COMPONENT_STATUSES), 2).optional(),
    /** Components owning code in any of these repos. */
    repo: list(line(120)).optional(),
    tags: list(line(80)).optional(),
    /** Case-insensitive substring of the id or title. */
    q: line(200).optional(),
    limit: z.number().int().min(1).max(200).default(50),
    cursor: z.string().max(200).regex(/^[0-9]+$/, 'invalid cursor').optional(),
  })
  .strict();
export const componentGetInputSchema = z
  .object({
    ref: docRefSchema(['components']),
    at: commitRefSchema.optional(),
    metadataOnly: z.boolean().default(false),
    sections: list(slugSchema, 100).optional(),
  })
  .strict();
export const componentSectionGetInputSchema = z
  .object({
    ref: sectionRefSchema(['components']).optional(),
    doc: docRefSchema(['components'], { sections: false }).optional(),
    section: slugSchema.optional(),
    at: commitRefSchema.optional(),
    includeImage: z.boolean().optional(),
  })
  .strict()
  .refine((v) => !!v.ref !== !!(v.doc && v.section), { message: 'give either ref, or doc and section' });
export const codeOwnerInputSchema = z
  .object({
    /** Repository name (as in `owns`); omitted: any repository. */
    repo: line(120).optional(),
    /** File path relative to the repository root. */
    path: line(1000),
  })
  .strict();

/* ---------------------------------------------------------------- write schemas */

const componentMeta = {
  title: line(300).optional(),
  summary: line(1000).nullable().optional(),
  kind: z.enum(COMPONENT_KINDS).optional(),
  /** Code the component owns: path globs per repo (the most specific glob across components wins). */
  owns: z.array(ownsSchema).max(50).optional(),
  tags: z.array(line(80)).max(50).optional(),
  owner: line(200).nullable().optional(),
  /** Architecture layer (ui, api, service, domain, data, infra or another slug); null: derive from depends_on. */
  layer: layerSchema.nullable().optional(),
  /** Containing component id (a tree: one parent, no cycles); null: top level. */
  parent: slugSchema.nullable().optional(),
};
export const componentCreateInputSchema = z
  .object({
    title: line(300),
    summary: line(1000).optional(),
    kind: z.enum(COMPONENT_KINDS),
    owns: z.array(ownsSchema).max(50).default([]),
    tags: z.array(line(80)).max(50).default([]),
    owner: line(200).optional(),
    layer: layerSchema.optional(),
    parent: slugSchema.optional(),
    sections: z.array(componentSectionCreateSchema).max(100).optional(),
  })
  .strict();
export const componentUpdateMetaInputSchema = z
  .object({ ref: componentDocRefSchema, ...componentMeta })
  .strict()
  .refine((v) => Object.keys(v).some((k) => k !== 'ref'), 'nothing to change: pass at least one field');
export const componentArchiveInputSchema = z.object({ ref: componentDocRefSchema, reason: line(500).optional() }).strict();
export const componentStatusSetInputSchema = z.object({ ref: componentDocRefSchema, status: z.enum(COMPONENT_STATUSES), reason: line(500).optional() }).strict();

/* ---------------------------------------------------------------- read tools */

export const componentTools = [
  defineTool({
    name: 'component_list',
    title: 'List components',
    kind: 'read',
    description: `List architecture components (id order) with frontmatter (kind ${COMPONENT_KINDS.join('|')}, status, layer, owns, tags) and derived counts: dependsOn, dependents, specs affecting it, open work orders, open feedback. Filters: kind, status, repo (owns code there), tags, q. Paginated.
Example: {"kind":["service"]}`,
    input: componentListInputSchema,
    run: (a, ctx) => ctx.reads.componentList(componentListInputSchema.parse(a)),
  }),
  defineTool({
    name: 'component_get',
    title: 'Get a component',
    kind: 'read',
    description: `Get one component: frontmatter, sections (responsibility, interfaces, context, ...) and, at HEAD, derived facts (dependsOn / dependents, specs affecting it, open work orders, rules that apply, empty owns globs) and section links. ${REF_NOTE}
Example: {"ref":"auth-service","metadataOnly":true}`,
    input: componentGetInputSchema,
    run: async (a, ctx) => {
      const r = await ctx.reads.componentGet(componentGetInputSchema.parse(a));
      return withImageMeta(r, ctx, 'components', (r as { id: string }).id);
    },
  }),
  defineTool({
    name: 'component_section_get',
    title: 'Get a component section',
    kind: 'read',
    description: `Get one component section (body, type, metadata incl. links, lines; #Lx-Ly excerpt). ${REF_NOTE}
Example: {"ref":"mandate://components/auth-service/sections/responsibility"}`,
    input: componentSectionGetInputSchema,
    run: async (a, ctx) => {
      const inp = componentSectionGetInputSchema.parse(a);
      return sectionGetWithImage(await ctx.reads.componentSectionGet(inp), ctx, inp.includeImage);
    },
  }),
  defineTool({
    name: 'architecture_get',
    title: 'Get the architecture',
    kind: 'read',
    description: `The generated architecture view (mandate://architecture): components by layer (default order ${DEFAULT_LAYER_ORDER.join(' > ')}), parent / children, depends_on edges (violation: an upward edge) and, at HEAD, overlays (work orders, claims, specs, feedback, drift, blocked, failing). Options: at (commit), compare (older commit), focus (component id), includeArchived, format graph | mermaid.
Example: {"focus":"auth-service","format":"mermaid"}`,
    input: architectureGetInputSchema,
    run: (a, ctx) => ctx.storage.architecture.get(a),
  }),
  defineTool({
    name: 'code_owner',
    title: 'Owner of a code path',
    kind: 'read',
    description: `Which component owns a file: glob match on the components' owns (the most specific glob wins; repo optional). Returns owner null when no component owns it.
Example: {"repo":"app","path":"src/auth/session.ts"}`,
    input: codeOwnerInputSchema,
    run: (a, ctx) => ctx.reads.codeOwner(codeOwnerInputSchema.parse(a)),
  }),
];

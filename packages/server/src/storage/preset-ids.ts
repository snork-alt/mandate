/**
 * TEST / IN-PROCESS ONLY: explicit ids for create tools. Agents never choose ids (the MCP create schemas have no `id`);
 * in-process callers whose ToolContext sets `presetIds` (test fixtures, seeds — never an HTTP or MCP session, whose
 * contexts come from the project opener) may still pin them, so existing fixtures keep their readable ids.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

export interface PresetIds {
  doc?: string;
  /** Ids of a create's sections, by position. */
  sections?: (string | undefined)[];
  /** Id of an inserted section. */
  section?: string;
}

const store = new AsyncLocalStorage<PresetIds>();
export const presetIds = (): PresetIds | undefined => store.getStore();
export const withPresetIds = <T>(p: PresetIds, fn: () => Promise<T>): Promise<T> => store.run(p, fn);

/** Take `id` / `sections[].id` / `section.id` out of a create tool's raw arguments. */
export function takePresetIds(tool: string, raw: unknown): { args: unknown; presets: PresetIds | null } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { args: raw, presets: null };
  const a = { ...(raw as Record<string, unknown>) };
  const p: PresetIds = {};
  const strip = (s: unknown) => {
    if (!s || typeof s !== 'object') return { s, id: undefined };
    const { id, ...rest } = s as Record<string, unknown>;
    return { s: rest, id: typeof id === 'string' ? id : undefined };
  };
  if (/_create$/.test(tool) && /^(spec|standard|component)_/.test(tool)) {
    if (typeof a.id === 'string') p.doc = a.id;
    delete a.id;
    if (Array.isArray(a.sections)) {
      const out = a.sections.map(strip);
      a.sections = out.map((x) => x.s);
      if (out.some((x) => x.id)) p.sections = out.map((x) => x.id);
    }
  } else if (/_section_insert$/.test(tool) && a.section) {
    const x = strip(a.section);
    a.section = x.s;
    if (x.id) p.section = x.id;
  } else return { args: raw, presets: null };
  return { args: a, presets: p.doc || p.sections || p.section ? p : null };
}

import type { MermaidConfig } from 'mermaid';
import { stripWrappingFence } from '../../../lib/fence';

/**
 * Diagram engine: mermaid 12 with the `neo` look, ELK layout (flowchart / state / class / ER)
 * and a theme derived from our palette. Everything is loaded lazily on first use.
 * (beautiful-mermaid was evaluated too; see plans/screens/diagrams.)
 */
type Mermaid = (typeof import('mermaid'))['default'];
let loader: Promise<Mermaid> | null = null;
const load = () =>
  (loader ??= Promise.all([import('mermaid'), import('@mermaid-js/layout-elk')]).then(([m, elk]) => {
    m.default.registerLayoutLoaders(elk.default);
    return m.default;
  }));

/** mermaid.render is not re-entrant: serialize all renders. */
let queue: Promise<unknown> = Promise.resolve();

const FONT = "'Geist Variable', -apple-system, BlinkMacSystemFont, sans-serif";

const PALETTE = {
  light: {
    bg: '#fbfbfc',
    fg: '#1f1f23',
    muted: '#6b6f76',
    line: '#9a9ea6',
    node: '#f6f3fc',
    border: '#d9ccf1',
    note: '#fdf9ec',
    noteBorder: '#eedfb0',
    shadow: 'drop-shadow(0 1px 2px rgba(31, 31, 35, 0.07))',
  },
  dark: {
    bg: '#24252a',
    fg: '#e4e6eb',
    muted: '#9196a0',
    line: '#6f737c',
    node: '#2f2b3c',
    border: '#54487a',
    note: '#34322a',
    noteBorder: '#5b5336',
    shadow: 'drop-shadow(0 1px 2px rgba(0, 0, 0, 0.35))',
  },
};

function config(scheme: 'light' | 'dark', layout: 'elk' | 'dagre'): MermaidConfig {
  const c = PALETTE[scheme];
  return {
    startOnLoad: false,
    securityLevel: 'strict',
    theme: 'base',
    look: 'neo',
    layout,
    fontFamily: FONT,
    suppressErrorRendering: true,
    flowchart: { useMaxWidth: false, curve: 'rounded' as never, padding: 12 },
    sequence: { useMaxWidth: false, mirrorActors: false, actorMargin: 60, boxMargin: 8, noteMargin: 10 },
    state: { useMaxWidth: false },
    er: { useMaxWidth: false },
    class: { useMaxWidth: false },
    themeVariables: {
      darkMode: scheme === 'dark',
      fontFamily: FONT,
      fontSize: '14px',
      background: c.bg,
      primaryColor: c.node,
      primaryBorderColor: c.border,
      primaryTextColor: c.fg,
      secondaryColor: c.bg,
      tertiaryColor: c.bg,
      mainBkg: c.node,
      nodeBorder: c.border,
      lineColor: c.line,
      textColor: c.fg,
      clusterBkg: c.bg,
      clusterBorder: c.border,
      edgeLabelBackground: c.bg,
      labelBoxBkgColor: c.node,
      actorBkg: c.node,
      actorBorder: c.border,
      actorTextColor: c.fg,
      actorLineColor: c.border,
      signalColor: c.muted,
      signalTextColor: c.fg,
      noteBkgColor: c.note,
      noteBorderColor: c.noteBorder,
      noteTextColor: c.fg,
      sequenceNumberColor: scheme === 'dark' ? '#1d1e22' : '#ffffff',
      attributeBackgroundColorOdd: c.bg,
      attributeBackgroundColorEven: c.node,
      dropShadow: c.shadow,
    },
  };
}

let counter = 0;

/** Render mermaid source to an SVG string; falls back to the dagre layout if ELK fails. */
export function renderMermaid(source: string, scheme: 'light' | 'dark'): Promise<string> {
  // A body wrapped in its own ```mermaid fence would read as "No diagram type detected".
  const code = stripWrappingFence(source);
  const job = queue.then(async () => {
    const mermaid = await load();
    let lastError: unknown;
    for (const layout of ['elk', 'dagre'] as const) {
      mermaid.initialize(config(scheme, layout));
      try {
        return (await mermaid.render(`mmd-${++counter}`, code)).svg;
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  });
  queue = job.catch(() => undefined);
  return job;
}

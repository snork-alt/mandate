/**
 * Syntax highlighting with Shiki (fine-grained core + JS regex engine, no WASM). This module is
 * imported lazily; grammars load on demand, each in its own chunk.
 */
import type { HighlighterCore } from 'shiki/core';

const ALIASES: Record<string, string> = {
  ts: 'typescript',
  js: 'javascript',
  sh: 'bash',
  shell: 'bash',
  zsh: 'bash',
  yml: 'yaml',
  md: 'markdown',
  htm: 'html',
  text: 'plaintext',
  txt: 'plaintext',
};

let highlighter: Promise<HighlighterCore> | null = null;

async function get(): Promise<HighlighterCore> {
  highlighter ??= (async () => {
    const [{ createHighlighterCore }, { createJavaScriptRegexEngine }, light, dark] = await Promise.all([
      import('shiki/core'),
      import('shiki/engine/javascript'),
      import('shiki/themes/github-light.mjs'),
      import('shiki/themes/github-dark-dimmed.mjs'),
    ]);
    return createHighlighterCore({ themes: [light.default, dark.default], langs: [], engine: createJavaScriptRegexEngine() });
  })();
  return highlighter;
}

/** Highlighted HTML (dual light/dark theme via CSS variables) or null for unknown languages. */
export async function highlightToHtml(code: string, lang: string): Promise<string | null> {
  const id = ALIASES[lang] ?? lang;
  if (!id || id === 'plaintext') return null;
  const h = await get();
  if (!h.getLoadedLanguages().includes(id)) {
    const { bundledLanguages } = await import('shiki/langs');
    const loader = (bundledLanguages as Record<string, () => Promise<unknown>>)[id];
    if (!loader) return null;
    await h.loadLanguage((await loader()) as never);
  }
  return h.codeToHtml(code, {
    lang: id,
    themes: { light: 'github-light', dark: 'github-dark-dimmed' },
    defaultColor: false,
  });
}

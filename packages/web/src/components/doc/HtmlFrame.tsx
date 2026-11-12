import { useEffect, useMemo, useRef, useState } from 'react';
import { useComputedColorScheme } from '@mantine/core';
import { stripWrappingFence } from '../../lib/fence';

const FONT = "'Geist Variable', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";

/** The app's own @font-face rules (Geist), so sandboxed content can use the UI font. */
function fontFaceCss(): string {
  const rules: string[] = [];
  for (const sheet of Array.from(document.styleSheets)) {
    let list: CSSRuleList;
    try {
      list = sheet.cssRules;
    } catch {
      continue; // cross-origin sheet
    }
    for (const rule of Array.from(list)) {
      if (rule instanceof CSSFontFaceRule && /geist/i.test(rule.style.getPropertyValue('font-family'))) rules.push(rule.cssText);
    }
  }
  return rules.join('\n');
}

/**
 * Renders untrusted HTML in a sandboxed iframe (no scripts, no forms, no popups).
 * `allow-same-origin` without `allow-scripts` only lets this page measure the content height.
 */
export function HtmlFrame({ html, title, width }: { html: string; title: string; /** Fixed layout width (viewport presets); default fills the container. */ width?: number }) {
  const scheme = useComputedColorScheme('light');
  const ref = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(120);

  const srcDoc = useMemo(
    () => `<!doctype html><html><head><meta charset="utf-8"><style>
${fontFaceCss()}
:root{color-scheme:${scheme}}
*,*::before,*::after{box-sizing:border-box}
html,body{margin:0;background:transparent}
body{padding:20px;font:14px/1.55 ${FONT};color:${scheme === 'dark' ? '#e2e4e9' : '#1f1f23'};overflow:hidden}
</style></head><body>${stripWrappingFence(html)}</body></html>`,
    [html, scheme],
  );

  useEffect(() => {
    const frame = ref.current;
    if (!frame) return;
    let observer: ResizeObserver | undefined;
    const measure = () => {
      const doc = frame.contentDocument;
      if (!doc?.body) return;
      setHeight(Math.ceil(doc.documentElement.scrollHeight));
      observer?.disconnect();
      observer = new ResizeObserver(() => setHeight(Math.ceil(doc.documentElement.scrollHeight)));
      observer.observe(doc.body);
    };
    frame.addEventListener('load', measure);
    measure();
    return () => {
      frame.removeEventListener('load', measure);
      observer?.disconnect();
    };
  }, [srcDoc]);

  return (
    <div className="html-frame" style={width ? { width } : undefined}>
      <iframe ref={ref} title={title} sandbox="allow-same-origin" srcDoc={srcDoc} style={{ height }} />
    </div>
  );
}

/**
 * Built-in section renderers. To add a type: create `<type>.ts` exporting a SectionRenderer
 * (with a lazy Body component) and register it here.
 */
import { acceptanceRenderer } from './acceptance';
import { htmlRenderer } from './html';
import { markdownRenderer } from './markdown';
import { mermaidRenderer } from './mermaid';
import { ruleRenderer } from './rule';
import { registerSectionRenderer } from './registry';

for (const r of [markdownRenderer, mermaidRenderer, htmlRenderer, acceptanceRenderer, ruleRenderer]) registerSectionRenderer(r);

export { getSectionRenderer, registerSectionRenderer, type SectionBodyProps, type SectionRenderer } from './registry';

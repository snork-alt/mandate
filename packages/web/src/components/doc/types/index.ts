/**
 * Built-in section renderers. To add a type: create `<type>.ts` exporting a SectionRenderer
 * (with a lazy Body component) and register it here.
 */
import { acceptanceRenderer } from './acceptance';
import { htmlRenderer } from './html';
import { imageRenderer } from './image';
import { contextRenderer, markdownRenderer, overviewRenderer } from './markdown';
import { mermaidRenderer } from './mermaid';
import { ruleRenderer } from './rule';
import { auditItemRenderer } from './audit-item';
import { woSectionRenderer } from './wo-section';
import { registerSectionRenderer } from './registry';

for (const r of [markdownRenderer, overviewRenderer, contextRenderer, mermaidRenderer, htmlRenderer, imageRenderer, acceptanceRenderer, ruleRenderer, auditItemRenderer, woSectionRenderer]) registerSectionRenderer(r);

export { getSectionRenderer, registerSectionRenderer, type SectionBodyProps, type SectionRenderer } from './registry';

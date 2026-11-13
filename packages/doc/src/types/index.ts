import { createRegistry, type SectionTypeRegistry } from '../registry.js';
import { acceptanceType } from './acceptance.js';
import { htmlType } from './html.js';
import { imageType } from './image.js';
import { markdownType } from './markdown.js';
import { mermaidType } from './mermaid.js';
import { ruleType } from './rule.js';
import { auditItemType } from './audit-item.js';
import { woSectionType } from './wo-section.js';

export { acceptanceType, auditItemType, htmlType, imageType, markdownType, mermaidType, ruleType, woSectionType };

/** A registry with the built-in types (markdown, mermaid, html, image, acceptance, rule, audit-item, wo-section), registered through the public API. */
export function createDefaultRegistry(): SectionTypeRegistry {
  return createRegistry().register(markdownType).register(mermaidType).register(htmlType).register(imageType).register(acceptanceType).register(ruleType).register(auditItemType).register(woSectionType);
}

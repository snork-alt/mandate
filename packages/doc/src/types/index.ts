import { createRegistry, type SectionTypeRegistry } from '../registry.js';
import { acceptanceType } from './acceptance.js';
import { htmlType } from './html.js';
import { markdownType } from './markdown.js';
import { mermaidType } from './mermaid.js';
import { ruleType } from './rule.js';
import { auditItemType } from './audit-item.js';
import { woSectionType } from './wo-section.js';

export { acceptanceType, auditItemType, htmlType, markdownType, mermaidType, ruleType, woSectionType };

/** A registry with the built-in types (markdown, mermaid, html, acceptance, rule, audit-item, wo-section), registered through the public API. */
export function createDefaultRegistry(): SectionTypeRegistry {
  return createRegistry().register(markdownType).register(mermaidType).register(htmlType).register(acceptanceType).register(ruleType).register(auditItemType).register(woSectionType);
}

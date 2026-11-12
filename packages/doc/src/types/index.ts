import { createRegistry, type SectionTypeRegistry } from '../registry.js';
import { acceptanceType } from './acceptance.js';
import { htmlType } from './html.js';
import { markdownType } from './markdown.js';
import { mermaidType } from './mermaid.js';
import { ruleType } from './rule.js';

export { acceptanceType, htmlType, markdownType, mermaidType, ruleType };

/** A registry with the built-in types (markdown, mermaid, html, acceptance, rule), registered through the public API. */
export function createDefaultRegistry(): SectionTypeRegistry {
  return createRegistry().register(markdownType).register(mermaidType).register(htmlType).register(acceptanceType).register(ruleType);
}

import { Markdown } from '../../Markdown';
import type { SectionBodyProps } from './registry';

export default function MarkdownBody({ section }: SectionBodyProps) {
  return <Markdown>{section.body}</Markdown>;
}

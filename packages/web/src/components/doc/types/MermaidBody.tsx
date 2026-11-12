import { MermaidBlock } from '../MermaidBlock';
import type { SectionBodyProps } from './registry';

export default function MermaidBody({ section }: SectionBodyProps) {
  return <MermaidBlock code={section.body} title={section.title} />;
}

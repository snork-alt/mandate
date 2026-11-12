import { IconBrowser } from '@tabler/icons-react';
import { CanvasViewer } from '../CanvasViewer';
import { HtmlFrame } from '../HtmlFrame';
import type { SectionBodyProps } from './registry';

export default function HtmlBody({ section }: SectionBodyProps) {
  return (
    <CanvasViewer
      title={section.title}
      icon={<IconBrowser size={15} color="var(--app-text-muted)" />}
      source={section.body}
      sourceLang="html"
      viewports
      fill
      render={({ width }) => <HtmlFrame html={section.body} title={section.title} width={width} />}
    />
  );
}

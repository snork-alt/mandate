import { useEffect, useState } from 'react';
import { Alert, Code, Skeleton, useComputedColorScheme } from '@mantine/core';
import { IconAlertTriangle, IconSitemap } from '@tabler/icons-react';
import { CanvasViewer } from './CanvasViewer';
import { renderMermaid } from './diagram/renderMermaid';

/** Rendered SVG for mermaid source, themed to the current color scheme. */
export function useMermaidSvg(code: string) {
  const scheme = useComputedColorScheme('light');
  const [state, setState] = useState<{ svg?: string; error?: string; code?: string }>({});
  useEffect(() => {
    let cancelled = false;
    renderMermaid(code, scheme).then(
      (svg) => !cancelled && setState({ svg, code }),
      (err: Error) => !cancelled && setState({ error: err.message, code }),
    );
    return () => {
      cancelled = true;
    };
  }, [code, scheme]);
  return state.code === code ? state : {};
}

function DiagramError({ code, error }: { code: string; error: string }) {
  return (
    <Alert color="red" variant="light" icon={<IconAlertTriangle size={16} />} title="Diagram error" radius="md">
      <div style={{ fontSize: 13, marginBottom: 8 }}>{error.split('\n')[0]}</div>
      <Code block fz="sm">
        {code}
      </Code>
    </Alert>
  );
}

/** Bare diagram (no toolbar). */
export function MermaidSvg({ code }: { code: string }) {
  const { svg, error } = useMermaidSvg(code);
  if (error) return <DiagramError code={code} error={error} />;
  if (!svg) return <Skeleton height={160} radius="md" />;
  return <div className="mermaid-diagram" dangerouslySetInnerHTML={{ __html: svg }} />;
}

/** A diagram in the shared canvas viewer (zoom, source, copy, fullscreen). */
export function MermaidBlock({ code, title }: { code: string; title?: string }) {
  const { svg, error } = useMermaidSvg(code);
  if (error) return <DiagramError code={code} error={error} />;
  if (!svg) return <Skeleton height={200} radius="md" />;
  return (
    <CanvasViewer
      title={title ?? 'Diagram'}
      icon={<IconSitemap size={15} color="var(--app-text-muted)" />}
      source={code}
      sourceLang="mermaid"
      extraCopies={[{ label: 'Copy as SVG', value: () => svg }]}
      render={() => <div className="mermaid-diagram" dangerouslySetInnerHTML={{ __html: svg }} />}
    />
  );
}

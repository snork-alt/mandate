import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { ActionIcon, CopyButton, Modal, SegmentedControl, Text, Tooltip } from '@mantine/core';
import {
  IconArrowsMaximize,
  IconCheck,
  IconChevronDown,
  IconCode,
  IconCopy,
  IconEye,
  IconFocusCentered,
  IconHandStop,
  IconMinus,
  IconPlus,
  IconPointer,
  IconX,
} from '@tabler/icons-react';
import { CodeBlock } from '../CodeBlock';
import { Menu } from '@mantine/core';
import { IconAt } from '@tabler/icons-react';
import { copyText } from '../../lib/copy';
import { blockReference, useDocSource } from './DocSourceContext';
import { useSectionTarget } from '../copy';
import { PanZoom, type PanZoomApi } from './diagram/PanZoom';
import { useDocInfo } from './DocInfoContext';

export type ViewportWidth = 'mobile' | 'tablet' | 'desktop' | 'fill';
const VIEWPORTS: Record<Exclude<ViewportWidth, 'fill'>, number> = { mobile: 375, tablet: 768, desktop: 1280 };

export interface CanvasViewerProps {
  /** Section title for the fullscreen bar. */
  title?: string;
  icon?: ReactNode;
  /** Source text (copy / source view) and its Shiki language. */
  source: string;
  sourceLang: string;
  /**
   * The rendered content. `width` is the requested layout width (viewport presets in fullscreen,
   * else undefined = natural / container width).
   */
  render: (opts: { width?: number; fullscreen: boolean; exitFullscreen: () => void }) => ReactNode;
  /** Offer Mobile / Tablet / Desktop / Fill widths in fullscreen (UI mockups). */
  viewports?: boolean;
  /** Inline height above which the canvas is clamped with a fade and "Expand". */
  maxInlineHeight?: number;
  /** Content fills the available width (HTML) instead of having a natural size (SVG). */
  fill?: boolean;
  /** Extra secondary copy actions (e.g. "Copy as SVG"). */
  extraCopies?: { label: string; value: () => string }[];
  /** Content has its own controls (links, buttons, hover): fullscreen pans only by dragging elsewhere. */
  interactive?: boolean;
  /** The Mandate reference(s) the default copy puts on the clipboard when the content is not a doc section (e.g. an Ask graph). */
  reference?: () => string;
}

const ZOOM_STEPS = 1.2;

/** Size of an element's layout box (unaffected by CSS transforms). */
function useSize(ref: React.RefObject<HTMLElement | null>) {
  const [size, setSize] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.offsetWidth, h: el.offsetHeight }));
    ro.observe(el);
    setSize({ w: el.offsetWidth, h: el.offsetHeight });
    return () => ro.disconnect();
  }, [ref]);
  return size;
}

function IconBtn({ label, onClick, children, active }: { label: string; onClick: () => void; children: ReactNode; active?: boolean }) {
  return (
    <Tooltip label={label}>
      <ActionIcon size={24} variant={active ? 'light' : 'subtle'} color="gray" onClick={onClick} aria-label={label}>
        {children}
      </ActionIcon>
    </Tooltip>
  );
}

/**
 * Shared viewer for rendered section types (diagrams, HTML mockups, future types): inline canvas
 * with grid, zoom, source view, copy actions and a clamp-and-expand height; fullscreen with pan & zoom.
 */
export function CanvasViewer({ title, icon, source, sourceLang, render, viewports, maxInlineHeight = 560, fill, extraCopies, interactive, reference }: CanvasViewerProps) {
  const target = useSectionTarget();
  const doc = useDocInfo();
  const [zoom, setZoom] = useState<number | 'fit'>('fit');
  const [showSource, setShowSource] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [api, setApi] = useState<PanZoomApi | null>(null);
  const [vp, setVp] = useState<ViewportWidth>('fill');
  const [pan, setPan] = useState(!interactive);
  const exitFullscreen = () => setFullscreen(false);

  const frame = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  const frameSize = useSize(frame);
  const natural = useSize(inner);
  // The frame's own padding (44/20 by default, less in the rail) is not room for the content.
  const pad = (() => {
    const el = frame.current;
    if (!el) return { x: 40, y: 64 };
    const cs = getComputedStyle(el);
    return { x: parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight) || 0, y: parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom) || 0 };
  })();
  const avail = Math.max(0, frameSize.w - 2 - pad.x);
  const fitK = !fill && natural.w > avail && natural.w > 0 ? avail / natural.w : 1;
  const k = zoom === 'fit' ? fitK : zoom;
  const scaledH = natural.h * k;
  // The box keeps its "fit" size; zooming only scales the content inside it (scroll / drag to pan).
  const fitH = natural.h * fitK;
  const clamped = !expanded && fitH > maxInlineHeight;
  // + frame padding (border-box) and border
  const boxH = fitH ? (clamped ? maxInlineHeight : fitH + pad.y + 2) : undefined;
  const zoomed = zoom !== 'fit';

  // Drag to pan the inline canvas while zoomed.
  const drag = useRef<{ x: number; y: number; l: number; t: number } | null>(null);
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!zoomed || e.button !== 0 || !frame.current) return;
    drag.current = { x: e.clientX, y: e.clientY, l: frame.current.scrollLeft, t: frame.current.scrollTop };
    frame.current.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || !frame.current) return;
    frame.current.scrollLeft = d.l - (e.clientX - d.x);
    frame.current.scrollTop = d.t - (e.clientY - d.y);
  };
  const onPointerUp = () => {
    drag.current = null;
  };

  // Ctrl/Cmd + wheel zooms the inline canvas (needs a non-passive listener).
  useEffect(() => {
    const el = frame.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      setZoom((z) => Math.min(4, Math.max(0.2, (z === 'fit' ? k : z) * Math.exp(-e.deltaY * 0.01))));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [k]);

  const docSource = useDocSource();
  const rootRef = useRef<HTMLDivElement>(null);
  // Default copy = reference to this section with the fence's line range; source / SVG are secondary.
  const copyReference = async () => {
    const sid = rootRef.current?.closest<HTMLElement>('[data-section-id]')?.dataset.sectionId;
    if (reference) await copyText(reference(), 'Copied reference');
    else if (docSource && sid) await copyText(await blockReference(docSource, sid));
    else if (target) await copyText(target.ref);
    else await copyText(source, 'Copied source');
  };
  const copySource = (
    <Menu position="bottom-end" withinPortal width={200}>
      <Menu.Target>
        <ActionIcon size={28} variant="subtle" color="gray" aria-label="Copy options">
          <IconChevronDown size={14} />
        </ActionIcon>
      </Menu.Target>
      <Menu.Dropdown>
        <Menu.Item leftSection={<IconAt size={14} />} onClick={() => void copyReference()}>
          Copy reference
        </Menu.Item>
        <Menu.Item leftSection={<IconCopy size={14} />} onClick={() => void copyText(source, 'Copied source')}>
          Copy source
        </Menu.Item>
        {extraCopies?.map((x) => (
          <Menu.Item key={x.label} leftSection={<IconCopy size={14} />} onClick={() => void copyText(x.value(), 'Copied')}>
            {x.label}
          </Menu.Item>
        ))}
      </Menu.Dropdown>
    </Menu>
  );
  const copyButton = (
    <IconBtn label={reference ? 'Copy Mandate reference' : 'Copy reference to this section (with line range)'} onClick={() => void copyReference()}>
      <IconAt size={14} />
    </IconBtn>
  );

  return (
    <div className="canvas-viewer" ref={rootRef}>
      <div className="canvas-toolbar">
        {!showSource && (
          <>
            <IconBtn label="Zoom out" onClick={() => setZoom(Math.max(0.2, k / ZOOM_STEPS))}>
              <IconMinus size={14} />
            </IconBtn>
            <span className="fs-zoom">{Math.round(k * 100)}%</span>
            <IconBtn label="Zoom in" onClick={() => setZoom(Math.min(4, k * ZOOM_STEPS))}>
              <IconPlus size={14} />
            </IconBtn>
            <IconBtn label={zoom === 'fit' ? 'Actual size' : 'Fit'} onClick={() => setZoom(zoom === 'fit' ? 1 : 'fit')}>
              <IconFocusCentered size={14} />
            </IconBtn>
            <span className="fs-sep" />
          </>
        )}
        <IconBtn label={showSource ? 'Show rendering' : 'Show source'} onClick={() => setShowSource((s) => !s)} active={showSource}>
          {showSource ? <IconEye size={14} /> : <IconCode size={14} />}
        </IconBtn>
        {copyButton}
        {copySource}
        <IconBtn label="Fullscreen" onClick={() => setFullscreen(true)}>
          <IconArrowsMaximize size={14} />
        </IconBtn>
      </div>

      {showSource ? (
        <div className="canvas-source">
          <CodeBlock code={source} lang={sourceLang} />
        </div>
      ) : (
        <div
          ref={frame}
          className="canvas-frame diagram-grid"
          data-clamped={(clamped && !zoomed) || undefined}
          data-zoomed={zoomed || undefined}
          style={{ height: boxH, overflow: zoomed ? 'auto' : 'hidden' }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        >
          <div className="canvas-scaled" style={{ width: natural.w * k || undefined, height: scaledH || undefined, margin: '0 auto' }}>
            <div ref={inner} className="canvas-inner" style={{ transform: `scale(${k})`, width: fill && avail ? avail : undefined }}>
              {render({ fullscreen: false, exitFullscreen })}
            </div>
          </div>
          {clamped && !zoomed && (
            <button type="button" className="canvas-expand" onClick={() => setExpanded(true)}>
              <IconChevronDown size={14} /> Expand
            </button>
          )}
        </div>
      )}

      <Modal
        opened={fullscreen}
        onClose={() => setFullscreen(false)}
        fullScreen
        withCloseButton={false}
        radius={0}
        padding={0}
        transitionProps={{ duration: 120 }}
        styles={{ body: { padding: 0, height: '100dvh' }, content: { background: 'var(--app-surface)' } }}
      >
        <div className="fs-header">
          <div className="fs-title">
            {icon}
            <Text size="sm" fw={500} truncate>
              {title ?? 'Preview'}
            </Text>
            {doc && (
              <Text size="sm" c="var(--app-text-faint)" truncate>
                · {doc.title}
              </Text>
            )}
          </div>
          <div className="fs-actions">
            {viewports && (
              <>
                <SegmentedControl
                  size="xs"
                  value={vp}
                  onChange={(v) => setVp(v as ViewportWidth)}
                  data={[
                    { value: 'mobile', label: 'Mobile' },
                    { value: 'tablet', label: 'Tablet' },
                    { value: 'desktop', label: 'Desktop' },
                    { value: 'fill', label: 'Fill' },
                  ]}
                />
                <IconBtn label={pan ? 'Interact with content' : 'Pan & zoom'} onClick={() => setPan((p) => !p)} active={!pan}>
                  {pan ? <IconHandStop size={14} /> : <IconPointer size={14} />}
                </IconBtn>
                <span className="fs-sep" />
              </>
            )}
            <IconBtn label="Zoom out" onClick={() => api?.zoomBy(1 / 1.25)}>
              <IconMinus size={14} />
            </IconBtn>
            <span className="fs-zoom">{Math.round((api?.scale ?? 1) * 100)}%</span>
            <IconBtn label="Zoom in" onClick={() => api?.zoomBy(1.25)}>
              <IconPlus size={14} />
            </IconBtn>
            <IconBtn label="Fit (double-click)" onClick={() => api?.fit()}>
              <IconFocusCentered size={14} />
            </IconBtn>
            <span className="fs-sep" />
            {copyButton}
            {copySource}
            <IconBtn label="Close (Esc)" onClick={() => setFullscreen(false)}>
              <IconX size={14} />
            </IconBtn>
          </div>
        </div>
        <PanZoom onApi={setApi} overlay={pan} key={vp} passThrough={interactive ? 'button, a, [data-interactive]' : undefined}>
          {render({ fullscreen: true, exitFullscreen, width: viewports ? (vp === 'fill' ? Math.max(320, window.innerWidth - 80) : VIEWPORTS[vp]) : undefined })}
        </PanZoom>
      </Modal>
    </div>
  );
}

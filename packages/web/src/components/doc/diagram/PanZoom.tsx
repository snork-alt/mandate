import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

export interface PanZoomApi {
  scale: number;
  zoomBy: (factor: number) => void;
  fit: () => void;
  reset: () => void;
}

const GRID = 20;

/**
 * Pan (drag) and zoom (wheel / pinch) surface. The dot grid background moves and scales with the
 * content so it stays attached to the diagram. Exposes its controls through `onApi`.
 */
export function PanZoom({
  children,
  onApi,
  overlay = true,
  passThrough,
}: {
  children: ReactNode;
  onApi?: (api: PanZoomApi) => void;
  /** Capture pointer events above the content (needed over iframes); off = interact with the content. */
  overlay?: boolean;
  /** With the overlay off: pointer-downs on these elements reach the content, anywhere else pans (default: only the empty background pans). */
  passThrough?: string;
}) {
  const [t, setT] = useState({ x: 0, y: 0, k: 1 });
  const drag = useRef<{ x: number; y: number } | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);

  const zoomAt = useCallback((factor: number, cx?: number, cy?: number) => {
    setT((p) => {
      const k = Math.min(8, Math.max(0.1, p.k * factor));
      const rect = box.current?.getBoundingClientRect();
      const px = cx ?? (rect ? rect.width / 2 : 0);
      const py = cy ?? (rect ? rect.height / 2 : 0);
      return { k, x: px - ((px - p.x) * k) / p.k, y: py - ((py - p.y) * k) / p.k };
    });
  }, []);

  const fit = useCallback(() => {
    const b = box.current?.getBoundingClientRect();
    const c = content.current;
    if (!b || !c) return;
    const w = c.offsetWidth;
    const h = c.offsetHeight;
    if (!w || !h) return;
    const k = Math.min(b.width / w, b.height / h, 2) * 0.9;
    setT({ k, x: (b.width - w * k) / 2, y: (b.height - h * k) / 2 });
  }, []);

  // Fit when the content is laid out and whenever it resizes (e.g. an iframe measuring itself),
  // until the user pans or zooms.
  const touched = useRef(false);
  useEffect(() => {
    const id = requestAnimationFrame(fit);
    const el = content.current;
    const ro = el ? new ResizeObserver(() => !touched.current && fit()) : null;
    if (el) ro!.observe(el);
    return () => {
      cancelAnimationFrame(id);
      ro?.disconnect();
    };
  }, [fit]);

  useEffect(() => {
    onApi?.({
      scale: t.k,
      zoomBy: (f) => {
        touched.current = true;
        zoomAt(f);
      },
      fit,
      reset: () => setT({ x: 0, y: 0, k: 1 }),
    });
  }, [t.k, zoomAt, fit, onApi]);

  return (
    <div
      ref={box}
      className="panzoom diagram-grid"
      style={{ backgroundSize: `${GRID * t.k}px ${GRID * t.k}px`, backgroundPosition: `${t.x}px ${t.y}px` }}
      onWheel={(e) => {
        touched.current = true;
        const rect = e.currentTarget.getBoundingClientRect();
        zoomAt(Math.exp(-e.deltaY * 0.0015), e.clientX - rect.left, e.clientY - rect.top);
      }}
      onPointerDown={(e) => {
        if (!overlay && (passThrough ? (e.target as Element).closest(passThrough) : e.target !== e.currentTarget)) return;
        touched.current = true;
        drag.current = { x: e.clientX - t.x, y: e.clientY - t.y };
        e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        if (drag.current) setT((p) => ({ ...p, x: e.clientX - drag.current!.x, y: e.clientY - drag.current!.y }));
      }}
      onPointerUp={() => (drag.current = null)}
      onDoubleClick={fit}
    >
      <div ref={content} className="panzoom-content" style={{ transform: `translate(${t.x}px, ${t.y}px) scale(${t.k})` }}>
        {children}
      </div>
      {overlay && <div className="panzoom-overlay" aria-hidden="true" />}
    </div>
  );
}

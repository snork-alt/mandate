import { useRef, type PointerEvent } from 'react';
import { Tooltip } from '@mantine/core';
import { useLocation } from 'react-router';
import { IconActivity, IconChevronsRight, IconInfoCircle, IconSparkles } from '@tabler/icons-react';
import { ActivityPanel } from '../activity/ActivityPanel';
import { AskView } from '../ask/AskView';
import { useRail } from './RailProvider';
import type { RailTab } from './persistence';
import './rail.css';
import './rail-mobile.css';

const TAB_META: Record<RailTab, { label: string; icon: typeof IconActivity; keys?: string }> = {
  details: { label: 'Details', icon: IconInfoCircle },
  activity: { label: 'Activity', icon: IconActivity, keys: '⇧⌘A' },
  ask: { label: 'Ask', icon: IconSparkles, keys: '⌘J' },
};

/** Right rail on every page: Details (document pages), Activity and Ask share one resizable column. */
export function Rail() {
  const r = useRail();
  const { pathname } = useLocation();
  const drag = useRef(false);
  const docUri = r.pageType === 'doc' ? docRefOf(pathname) : undefined;

  const onDown = (e: PointerEvent<HTMLDivElement>) => {
    drag.current = true;
    e.currentTarget.setPointerCapture(e.pointerId);
    e.preventDefault();
  };
  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    if (drag.current) r.setWidth(window.innerWidth - e.clientX);
  };
  const onUp = () => {
    drag.current = false;
  };

  return (
    <>
    {!r.collapsed && <div className="rail-backdrop" aria-hidden data-testid="rail-backdrop" onClick={r.collapse} />}
    <aside
      className="rail"
      data-collapsed={r.collapsed}
      data-tab={r.activeTab}
      aria-label="Side panel"
      style={{ ['--rail-w' as string]: `${r.width}px` }}
      onKeyDown={(e) => {
        // Escape first closes an open menu (filters, copy menu); only a bare Escape collapses the rail.
        const t = e.target as HTMLElement;
        if (e.key !== 'Escape' || r.collapsed || t.closest('[aria-expanded="true"], .mantine-Popover-dropdown, .mantine-Menu-dropdown')) return;
        e.stopPropagation();
        r.collapse();
      }}
    >
      {!r.collapsed && (
        <div
          className="rail-resize"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize panel"
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onDoubleClick={() => r.setWidth(380)}
        />
      )}
      <div className="rail-tabs" role="tablist">
        {r.tabs.map((t) => {
          const { label, icon: Icon, keys } = TAB_META[t];
          const active = !r.collapsed && r.activeTab === t;
          return (
            <Tooltip key={t} label={keys ? `${label} (${keys})` : label} position="left" openDelay={300}>
              <button type="button" role="tab" className="rail-tab" aria-selected={active} aria-label={label} onClick={() => r.selectTab(t)}>
                <Icon size={16} stroke={1.6} />
                <span className="rail-tab-label">{label}</span>
                {t === 'activity' && r.unread > 0 && (
                  <span className="rail-badge" aria-label={`${r.unread} unread`}>
                    {r.unread > 99 ? '99+' : r.unread}
                  </span>
                )}
              </button>
            </Tooltip>
          );
        })}
        {!r.collapsed && (
          <Tooltip label="Collapse" position="left" openDelay={300}>
            <button type="button" className="rail-collapse" aria-label="Collapse panel" onClick={r.collapse}>
              <IconChevronsRight size={16} stroke={1.6} />
            </button>
          </Tooltip>
        )}
      </div>
      <div className="rail-body" hidden={r.collapsed}>
        <div className="rail-pane" data-pane="details" ref={r.setDetailsSlot} hidden={r.activeTab !== 'details'} />
        <div className="rail-pane" data-pane="activity" hidden={r.activeTab !== 'activity'}>
          <ActivityPanel events={r.events} docUri={docUri} connected={r.connected} loaded={r.loaded} paused={r.paused} onPausedChange={r.setPaused} buffered={r.buffered} fresh={r.fresh} />
        </div>
        <div className="rail-pane" data-pane="ask" hidden={r.activeTab !== 'ask'}>
          <AskView />
        </div>
      </div>
    </aside>
    </>
  );
}

import { buildRef, type RefKind } from '@mandate/shared/refs';
function docRefOf(pathname: string): string | undefined {
  const m = /^\/(specs|standards|components|work-orders|feedback|audits)\/([^/@]+)/.exec(pathname);
  return m ? buildRef({ kind: m[1] as RefKind, id: decodeURIComponent(m[2]!) }) : undefined;
}

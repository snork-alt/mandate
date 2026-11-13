/**
 * Getting started, for an EMPTY project (no specs, standards, components or work orders): a modal that opens on the
 * Overview with the compact per-agent installer and two ways to start (bootstrap an existing codebase, or spec something
 * new). "Don't show again" is remembered per project and user (localStorage); once closed, the Overview shows a banner
 * and the top bar a "Getting started" button to reopen it.
 */
import { ActionIcon, Button, Checkbox, Modal, UnstyledButton } from '@mantine/core';
import { IconArrowRight, IconCheck, IconCode, IconFileText, IconPlugConnected, IconShieldCheck, IconSparkles, IconX } from '@tabler/icons-react';
import { useState, type ReactNode } from 'react';
import { useAuth } from '../auth';
import { AgentMark } from './AgentMark';
import { CopyBtn } from './AgentSetup';
import { useConnectSetup } from './ConnectAgentGuide';
import { InstallOneLiner } from './InstallOneLiner';
import type { ProjectSummary } from './projects';
import './connect.css';

/** True when the project holds nothing yet (unknown counts: not empty). */
export const isEmptyProject = (p: Pick<ProjectSummary, 'counts'> | undefined | null): boolean => {
  const c = p?.counts;
  return !!c && c.specs === 0 && c.standards === 0 && c.components === 0 && c.workOrders === 0;
};

export const BOOTSTRAP_COMMAND = '/mandate-bootstrap';
export const NEW_PROJECT_PROMPT = 'Using Mandate, let’s spec a login with GitHub SSO';

const hideKey = (login: string | undefined, projectId: string, what: 'modal' | 'banner') => `mandate.gettingStarted.${what}.${login ?? 'local'}.${projectId}`;

function readFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}
function writeFlag(key: string, on: boolean) {
  try {
    if (on) localStorage.setItem(key, '1');
    else localStorage.removeItem(key);
  } catch {
    // Storage unavailable (private mode): the choice lasts for this page only.
  }
}

/** "Don't show again" (modal) and the banner's ×, per project and user. */
export function useGettingStartedPrefs(projectId: string) {
  const login = useAuth()?.user?.login;
  const [modalHidden, setModalHidden] = useState(() => readFlag(hideKey(login, projectId, 'modal')));
  const [bannerHidden, setBannerHidden] = useState(() => readFlag(hideKey(login, projectId, 'banner')));
  return {
    modalHidden,
    bannerHidden,
    setModalHidden: (on: boolean) => {
      writeFlag(hideKey(login, projectId, 'modal'), on);
      setModalHidden(on);
    },
    setBannerHidden: (on: boolean) => {
      writeFlag(hideKey(login, projectId, 'banner'), on);
      setBannerHidden(on);
    },
  };
}

/** Projects whose modal already opened by itself in this page session (it does not pop up on every visit). */
const autoOpened = new Set<string>();
export const shouldAutoOpen = (projectId: string, empty: boolean, hidden: boolean) => empty && !hidden && !autoOpened.has(projectId);
export const markAutoOpened = (projectId: string) => void autoOpened.add(projectId);
/** Tests only. */
export const resetAutoOpened = () => autoOpened.clear();

const SEAL = (s: number) => (
  <svg viewBox="0 0 24 24" width={s} height={s} fill="none" stroke="#fff" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M5 18V6l7 8 7-8v12" />
  </svg>
);

/** The hero: Mandate in the middle, the coding agents above, the kinds of documents around it. */
function HeroArt() {
  const card = (x: number, y: number, w: number, title: string, sub: string, color: string) => (
    <g transform={`translate(${x} ${y})`}>
      <rect width={w} height="44" rx="9" fill="var(--app-bg)" stroke="color-mix(in srgb, var(--mantine-color-lilac-5) 22%, var(--app-border))" />
      <rect x="10" y="11" width="22" height="22" rx="6" fill={color} opacity=".16" />
      <rect x="16" y="17" width="10" height="10" rx="2.5" fill={color} />
      <text x="40" y="20" fontFamily="var(--mantine-font-family-monospace)" fontSize="10.5" fontWeight="600" fill="var(--mantine-color-text)">
        {title}
      </text>
      <text x="40" y="34" fontSize="10.5" fill="var(--app-text-faint)">
        {sub}
      </text>
    </g>
  );
  const node = (x: number, y: number, agent: string) => (
    <g transform={`translate(${x - 17} ${y - 17})`}>
      <rect width="34" height="34" rx="9" fill="var(--app-bg)" stroke="color-mix(in srgb, var(--mantine-color-lilac-5) 22%, var(--app-border))" />
      <foreignObject x="9" y="9" width="16" height="16">
        <AgentMark agent={agent} size={16} />
      </foreignObject>
    </g>
  );
  return (
    <svg className="gs-art" width="880" height="210" viewBox="0 0 880 210" aria-hidden="true">
      <g stroke="color-mix(in srgb, var(--mantine-color-lilac-5) 45%, transparent)" strokeWidth="1.4" strokeDasharray="3 5" fill="none">
        <path d="M440 104 C380 104 360 60 300 60" />
        <path d="M440 104 C380 104 350 150 290 152" />
        <path d="M440 104 C500 104 520 60 580 58" />
        <path d="M440 104 C500 104 530 150 590 150" />
        <path d="M440 104 C410 80 400 40 392 30" />
        <path d="M440 104 C470 80 480 40 488 30" />
      </g>
      <circle cx="440" cy="104" r="64" fill="#8f6fd2" opacity=".07" />
      <circle cx="440" cy="104" r="46" fill="#8f6fd2" opacity=".09" />
      <rect x="408" y="72" width="64" height="64" rx="18" fill="#8f6fd2" />
      <g transform="translate(424 88)">
        <path d="M5 26V6l11 13 11-13v20" fill="none" stroke="#fff" strokeWidth="3.6" strokeLinecap="round" strokeLinejoin="round" />
      </g>
      {card(150, 38, 150, 'SPEC-001', 'Checkout flow', '#8f6fd2')}
      {card(140, 130, 150, 'STD-004', 'API errors', '#12b886')}
      {card(580, 36, 160, 'WO-001', 'Apply a coupon', '#f59f00')}
      {card(590, 128, 150, 'DEC-002', 'Payment provider', '#5c7cfa')}
      {node(392, 26, 'claude-code')}
      {node(488, 26, 'codex')}
    </svg>
  );
}

function PathCard({ selected, onSelect, icon, title, children, testId }: { selected: boolean; onSelect: () => void; icon: ReactNode; title: string; children: ReactNode; testId: string }) {
  return (
    <div
      className="gs-path"
      role="radio"
      aria-checked={selected}
      tabIndex={0}
      data-selected={selected || undefined}
      data-testid={testId}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault();
          onSelect();
        }
      }}
    >
      <span className="gs-radio" aria-hidden="true">
        {selected && <IconCheck size={12} stroke={3} />}
      </span>
      <span className="gs-p-ico">{icon}</span>
      <h3>{title}</h3>
      {children}
    </div>
  );
}

/** Install step + the two ways to start. */
export function GettingStartedModal({
  projectId,
  projectName,
  opened,
  onClose,
  dontShow,
  onDontShow,
  onOpenConnect,
}: {
  projectId: string;
  projectName: string;
  opened: boolean;
  onClose: () => void;
  dontShow: boolean;
  onDontShow: (on: boolean) => void;
  onOpenConnect: () => void;
}) {
  const [path, setPath] = useState<'existing' | 'new' | null>(null);
  const { info, url, ctx } = useConnectSetup(projectId);
  return (
    <Modal
      opened={opened}
      onClose={onClose}
      size={880}
      radius={16}
      padding={0}
      withCloseButton={false}
      overlayProps={{ backgroundOpacity: 0.28, blur: 3 }}
      classNames={{ content: 'gs-modal-content', body: 'gs-modal-body' }}
      aria-label={`Welcome to ${projectName}`}
    >
      <div className="gs" data-testid="getting-started">
        <div className="gs-hero">
          <HeroArt />
          <ActionIcon className="gs-close" variant="subtle" color="gray" size="lg" aria-label="Close" onClick={onClose}>
            <IconX size={17} />
          </ActionIcon>
        </div>
        <div className="gs-title">
          <h2>Welcome to {projectName}</h2>
          <p>This project is empty. Install Mandate for your coding agent, then choose how to start.</p>
        </div>
        <div className="gs-body">
          <section>
            <div className="gs-sec-h">
              <span className="cg2-num">1</span>
              <span className="gs-sec-t">Install Mandate for your coding agent</span>
              <span className="gs-sec-d">about a minute</span>
            </div>
            {info.data && url ? (
              <InstallOneLiner projectId={projectId} mcpUrl={url} ctx={ctx} />
            ) : (
              <div className="cg2-install">
                <p className="cg2-p" style={{ paddingTop: 12 }}>
                  {info.isError ? 'Cannot load the connection details. ' : 'Loading the install command… '}
                  <UnstyledButton onClick={onOpenConnect} c="var(--mantine-primary-color-filled)" fz={13}>
                    Open the connect guide
                  </UnstyledButton>
                </p>
              </div>
            )}
          </section>
          <section>
            <div className="gs-sec-h">
              <span className="cg2-num">2</span>
              <span className="gs-sec-t">Choose how to start</span>
            </div>
            <div className="gs-paths" role="radiogroup" aria-label="How to start">
              <PathCard selected={path === 'existing'} onSelect={() => setPath('existing')} icon={<IconCode size={22} stroke={1.7} />} title="Existing codebase" testId="gs-existing">
                <div className="gs-pd">Bootstrap it. Open your coding agent in the code repository and run the command.</div>
                <ul className="gs-bul">
                  {['Maps the components of your code', 'Drafts specs and standards from it', 'Asks you its decisions in Mandate', 'Everything starts as a draft you review in Actions'].map((t) => (
                    <li key={t}>
                      <IconCheck size={14} stroke={2.4} />
                      {t}
                    </li>
                  ))}
                </ul>
                <div className="gs-pcmd" onClick={(e) => e.stopPropagation()}>
                  <span className="gs-pcmd-v" data-mono>
                    {BOOTSTRAP_COMMAND}
                  </span>
                  <CopyBtn value={BOOTSTRAP_COMMAND} label="bootstrap command" tone={path === 'existing' ? 'primary' : 'default'} title="Copied command" />
                </div>
              </PathCard>
              <PathCard selected={path === 'new'} onSelect={() => setPath('new')} icon={<IconSparkles size={22} stroke={1.7} />} title="New project" testId="gs-new">
                <div className="gs-pd">Describe what you want to build to your coding agent. Mandate turns it into a plan you approve.</div>
                <div className="gs-pipe">
                  <span className="gs-pipe-n">Feedback</span>
                  <IconArrowRight size={13} className="gs-pipe-ar" />
                  <span className="gs-pipe-n">Specs</span>
                  <IconArrowRight size={13} className="gs-pipe-ar" />
                  <span className="gs-pipe-n" data-gate>
                    <IconShieldCheck size={13} /> You approve
                  </span>
                  <IconArrowRight size={13} className="gs-pipe-ar" />
                  <span className="gs-pipe-n">Work orders</span>
                </div>
                <div className="gs-pnote">The agent files your idea as feedback, drafts specs, and opens work orders only after you approve them.</div>
                <div className="gs-pcmd" onClick={(e) => e.stopPropagation()}>
                  <span className="gs-pcmd-v">“{NEW_PROJECT_PROMPT}”</span>
                  <CopyBtn value={NEW_PROJECT_PROMPT} label="example prompt" tone={path === 'new' ? 'primary' : 'default'} title="Copied prompt" />
                </div>
              </PathCard>
            </div>
          </section>
        </div>
        <div className="gs-foot">
          <Checkbox label="Don't show again for this project" checked={dontShow} onChange={(e) => onDontShow(e.currentTarget.checked)} data-testid="gs-dont-show" />
          <span className="gs-foot-sp" />
          <Button variant="subtle" size="sm" leftSection={<IconPlugConnected size={14} />} onClick={onOpenConnect} data-testid="gs-open-connect">
            Open the connect guide (advanced setup)
          </Button>
          <Button variant="default" size="sm" onClick={onClose} data-testid="gs-explore">
            Explore the empty project
          </Button>
        </div>
      </div>
    </Modal>
  );
}

/** Empty Overview: the reopen banner (unless dismissed), the zero counts and the empty state. */
export function EmptyProjectOverview({ projectName, showBanner, onOpen, onHideBanner, onConnect }: { projectName: string; showBanner: boolean; onOpen: () => void; onHideBanner: () => void; onConnect: () => void }) {
  return (
    <div data-testid="empty-overview">
      {showBanner && (
        <div className="gs-banner" data-testid="gs-banner">
          <span className="gs-seal">{SEAL(18)}</span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="gs-banner-t">Get started with {projectName}</div>
            <div className="gs-banner-d">Install Mandate for your coding agent, then bootstrap your codebase or spec something new.</div>
          </div>
          <Button leftSection={<IconSparkles size={14} />} onClick={onOpen} data-testid="gs-banner-open">
            Getting started
          </Button>
          <ActionIcon variant="subtle" color="gray" aria-label="Hide this banner" onClick={onHideBanner}>
            <IconX size={15} />
          </ActionIcon>
        </div>
      )}
      <div className="gs-tiles">
        {['Specs', 'Standards', 'Components', 'Work orders'].map((t) => (
          <div key={t} className="gs-tile">
            <b>0</b>
            <span>{t}</span>
          </div>
        ))}
      </div>
      <div className="gs-empty">
        <span className="gs-empty-icon">
          <IconFileText size={22} stroke={1.6} />
        </span>
        <div className="gs-empty-t">No specs yet</div>
        <div className="gs-empty-d">Specs appear here once your coding agent bootstraps the codebase or you spec something new.</div>
        <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap', justifyContent: 'center' }}>
          <Button size="sm" leftSection={<IconSparkles size={14} />} onClick={onOpen}>
            Getting started
          </Button>
          <Button size="sm" variant="default" leftSection={<IconPlugConnected size={14} />} onClick={onConnect}>
            Connect agent
          </Button>
        </div>
      </div>
    </div>
  );
}

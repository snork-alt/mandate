// @vitest-environment jsdom
/** Requests (was feedback): legacy route redirects, "Proved by" on criteria, "Implemented by" on spec sections, request links. */
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Question, Section } from '@mandate/shared';
import { installDom, Wrap } from './dom';
import { RequestsRedirect } from '../src/router';
import { SectionBlock } from '../src/components/doc/SectionBlock';
import { parseTestRef } from '../src/components/doc/ProvedBy';
import { ImplementationBadge } from '../src/pages/SpecDetailPage';
import { QuestionChip, WorkOrderChip } from '../src/components/FeedbackParts';
import { questionsByRequest, workOrdersByRequest } from '../src/lib/requestLinks';
import { normalizeFeedback } from '../src/lib/feedback';
import { sectionHref } from '../src/lib/links';
import '../src/components/doc/types';

vi.mock('../src/mcp/client', () => ({
  getMcpProject: () => 'acme',
  callTool: vi.fn(async () => ({})),
  McpToolError: class extends Error {},
  onNotification: () => () => undefined,
  onConnectionChange: () => () => undefined,
}));

beforeAll(installDom);
afterEach(cleanup);

let where = '';
function Where() {
  const l = useLocation();
  where = `${l.pathname}${l.search}`;
  return null;
}

describe('legacy /feedback routes', () => {
  const mount = (path: string) =>
    render(
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/feedback" element={<RequestsRedirect />} />
          <Route path="/feedback/:id" element={<RequestsRedirect />} />
          <Route path="/requests" element={<span>list</span>} />
          <Route path="/requests/:id" element={<span>item</span>} />
        </Routes>
        <Where />
      </MemoryRouter>,
    );
  it('/feedback/fb-1 redirects to /requests/fb-1, keeping the query string', () => {
    mount('/feedback/fb-1?x=1');
    expect(where).toBe('/requests/fb-1?x=1');
    expect(screen.getByText('item')).toBeTruthy();
  });
  it('/feedback redirects to /requests with its filters', () => {
    mount('/feedback?status=open');
    expect(where).toBe('/requests?status=open');
  });
  it('request refs link to /requests/', () => {
    expect(sectionHref('mandate://requests/fb-0001')).toBe('/requests/fb-0001');
    expect(sectionHref('mandate://feedback/fb-0001')).toBe('/requests/fb-0001');
  });
});

const criterion = (provedBy: unknown): Section => ({ id: 'login-works', title: 'Login works', type: 'acceptance', body: 'Given a user, login succeeds.', refs: [], symbols: [], links: [], verifiedBy: [], provedBy }) as unknown as Section;

describe('spec sections: proof and implementation', () => {
  it('parses test code refs; plain names stay names', () => {
    expect(parseTestRef('api:test/login.test.ts#L10-L24')).toEqual({ repo: 'api', path: 'test/login.test.ts', lines: '10-24' });
    expect(parseTestRef('api:test/login.test.ts')).toEqual({ repo: 'api', path: 'test/login.test.ts' });
    expect(parseTestRef('login works with a valid token')).toBeNull();
    expect(parseTestRef('auth: login works')).toBeNull();
  });

  it('criterion with provedBy: "Proved by" a code ref chip and a link to the work order; a plain name renders as text', () => {
    render(
      <Wrap><MemoryRouter>
        <SectionBlock section={criterion([{ test: 'api:test/login.test.ts#L10-L24', workOrder: 'q-0007' }, { test: 'login works with a valid token' }])} />
      </MemoryRouter></Wrap>,
    );
    const box = screen.getByTestId('proved-by');
    expect(box.textContent).toContain('Proved by');
    expect(box.querySelector('.chip-code')?.textContent).toContain('login.test.ts');
    expect(screen.getByTestId('proved-by-wo').getAttribute('href')).toBe('/work-orders/q-0007');
    expect(box.textContent).toContain('login works with a valid token');
  });

  it('criterion without provedBy shows no proof row', () => {
    render(<Wrap><MemoryRouter><SectionBlock section={criterion(undefined)} /></MemoryRouter></Wrap>);
    expect(screen.queryByTestId('proved-by')).toBeNull();
  });

  it('section with implementedBy: "Implemented by <WO>" next to the commit marker', () => {
    render(
      <Wrap><MemoryRouter>
        <ImplementationBadge state={{ implementedCommit: 'a'.repeat(40), outdated: false }} openItems={[]} by="q-0003" />
      </MemoryRouter></Wrap>,
    );
    const link = screen.getByTestId('implemented-by');
    expect(link.textContent).toContain('Implemented by');
    expect(link.getAttribute('href')).toBe('/work-orders/q-0003');
    expect(document.querySelector('.impl-badge[data-state="done"]')).toBeTruthy();
  });
});

describe('request links', () => {
  const q = (id: string, status: string, context: string[]) => ({ id, status, context, createdAt: '2026-11-01T00:00:00Z', questions: [{ id: 'a', header: 'H', question: 'Which?', options: [], recommended: 'x', multiSelect: false }] }) as unknown as Question;
  it('questions are matched by the request ref in their context (current and old form); superseded ones are left out', () => {
    const m = questionsByRequest([q('ask-0001', 'open', ['mandate://requests/fb-0001']), q('ask-0002', 'answered', ['mandate://feedback/fb-0001']), q('ask-0003', 'superseded', ['mandate://requests/fb-0001']), q('ask-0004', 'open', ['mandate://specs/x'])]);
    expect(m.get('fb-0001')!.map((x) => x.id)).toEqual(['ask-0001', 'ask-0002']);
    expect(m.size).toBe(1);
  });
  it('work orders are matched through reason', () => {
    const m = workOrdersByRequest([{ id: 'q-1', reason: ['fb-0001'] }, { id: 'q-2', reason: [] }] as never);
    expect(m.get('fb-0001')!.map((w) => w.id)).toEqual(['q-1']);
  });
  it('chips link to the question and the work order', () => {
    render(
      <Wrap><MemoryRouter>
        <QuestionChip q={q('ask-0001', 'open', [])} />
        <WorkOrderChip w={{ id: 'q-1', status: 'pending' }} />
      </MemoryRouter></Wrap>,
    );
    expect(screen.getByTestId('fb-question-chip').getAttribute('href')).toBe('/questions/ask-0001');
    expect(screen.getByTestId('fb-wo-chip').getAttribute('href')).toBe('/work-orders/q-1');
  });
  it('legacy accepted shows as open', () => {
    expect(normalizeFeedback({ status: 'accepted' as const }).status).toBe('open');
    expect(normalizeFeedback({ status: 'closed' as const }).status).toBe('closed');
  });
});

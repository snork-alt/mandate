import { Navigate, createBrowserRouter, useLocation, useParams, type RouteObject } from 'react-router';
import { AppLayout } from './components/AppLayout';
import { WorkOrderPage } from './pages/WorkOrderPage';
import { FeedbackItemPage } from './pages/FeedbackItemPage';
import { FeedbackListPage } from './pages/FeedbackListPage';
import { WorkOrderListPage } from './pages/WorkOrderListPage';
import { SpecDetailPage } from './pages/SpecDetailPage';
import { SpecListPage } from './pages/SpecListPage';
import { StandardDetailPage } from './pages/StandardDetailPage';
import { StandardListPage } from './pages/StandardListPage';
import { sectionOf } from './sections';
import { ComponentDetailPage, ComponentsPage } from './pages/ComponentPages';
import { AuditDetailPage, AuditListPage } from './pages/AuditPages';
import { LineagePage } from './pages/LineagePage';
import { OverviewPage } from './pages/OverviewPage';
import { IntegrityPage } from './pages/IntegrityPage';
import { QuestionPage } from './pages/QuestionPage';
import { QuestionsListPage } from './pages/QuestionsListPage';
import { ActionsPage } from './pages/ActionsPage';

/**
 * `/specs/<id>@<sha>#<section>` (a pasted versioned reference) opens that version read-only;
 * `#L<a>-L<b>` becomes a line highlight.
 */
function Versioned({ kind, children }: { kind: string; children: React.ReactNode }) {
  const { id = '' } = useParams();
  const at = id.indexOf('@');
  if (at < 0) return <>{children}</>;
  const hash = window.location.hash.slice(1);
  const lines = /^L(\d+)(?:-L(\d+))?$/.exec(hash.split('/').pop() ?? '');
  const section = hash && !hash.startsWith('L') ? hash.replace(/^section-/, '').split('#')[0] : '';
  const q = `version=${id.slice(at + 1)}&view=version${lines ? `&lines=${lines[1]}-${lines[2] ?? lines[1]}` : ''}`;
  return <Navigate to={`/${kind}/${id.slice(0, at)}?${q}${section ? `#section-${section}` : ''}`} replace />;
}

/** Old version links (/specs/:id/history/:commit) open the in-place tracked-changes view. */
function VersionRedirect({ kind }: { kind: string }) {
  const { id, commit } = useParams();
  return <Navigate to={`/${kind}/${id}?version=${commit}`} replace />;
}
const version = (kind: string) => <VersionRedirect kind={kind} />;
const workOrders = sectionOf('work-orders');

/** Legacy `/queue/*` links (before the rename to work orders). */
function QueueRedirect() {
  const { '*': rest } = useParams();
  const { search, hash } = useLocation();
  return <Navigate to={`/work-orders${rest ? `/${rest}` : ''}${search}${hash}`} replace />;
}

/** Legacy `/feedback[/:id]` links (the feedback pages are now requests). */
export function RequestsRedirect() {
  const { id } = useParams();
  const { search, hash } = useLocation();
  return <Navigate to={`/requests${id ? `/${id}` : ''}${search}${hash}`} replace />;
}

/** Project pages (rendered under the `/p/<projectId>` basename). */
export const projectRoutes: RouteObject[] = [
  {
    path: '/',
    element: <AppLayout />,
    children: [
      // The project landing: state, attention, work in progress, blocked, recent changes, coverage.
      { index: true, element: <OverviewPage /> },
      { path: 'overview', element: <Navigate to="/" replace /> },
      { path: 'specs', element: <SpecListPage /> },
      {
        path: 'specs/:id',
        element: (
          <Versioned kind="specs">
            <SpecDetailPage />
          </Versioned>
        ),
      },
      { path: 'specs/:id/history/:commit', element: version('specs') },
      { path: 'standards', element: <StandardListPage /> },
      {
        path: 'standards/:id',
        element: (
          <Versioned kind="standards">
            <StandardDetailPage />
          </Versioned>
        ),
      },
      { path: 'standards/:id/history/:commit', element: version('standards') },
      { path: 'components', element: <ComponentsPage /> },
      {
        path: 'components/:id',
        element: (
          <Versioned kind="components">
            <ComponentDetailPage />
          </Versioned>
        ),
      },
      { path: 'audits', element: <AuditListPage /> },
      {
        path: 'audits/:id',
        element: (
          <Versioned kind="audits">
            <AuditDetailPage />
          </Versioned>
        ),
      },
      { path: 'audits/:id/history/:commit', element: version('audits') },
      { path: 'work-orders', element: <WorkOrderListPage key="work-orders" section={workOrders} /> },
      {
        path: 'work-orders/:id',
        element: (
          <Versioned kind="work-orders">
            <WorkOrderPage />
          </Versioned>
        ),
      },
      { path: 'work-orders/:id/history/:commit', element: version('work-orders') },
      { path: 'queue/*', element: <QueueRedirect /> },
      { path: 'requests', element: <FeedbackListPage /> },
      { path: 'requests/:id', element: <FeedbackItemPage /> },
      { path: 'feedback', element: <RequestsRedirect /> },
      { path: 'feedback/:id', element: <RequestsRedirect /> },
      { path: 'lineage', element: <LineagePage /> },
      { path: 'integrity', element: <IntegrityPage /> },
      { path: 'actions', element: <ActionsPage /> },
      { path: 'questions', element: <QuestionsListPage /> },
      { path: 'questions/:id', element: <QuestionPage /> },
      { path: '*', element: <Navigate to="/specs" replace /> },
    ],
  },
];

/** The router of one project: every absolute app path (`/specs/x`) resolves inside `/p/<projectId>`. */
export const createProjectRouter = (basename: string) => createBrowserRouter(projectRoutes, { basename });

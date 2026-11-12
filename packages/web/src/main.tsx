import '@fontsource-variable/geist';
import '@fontsource-variable/geist-mono';
import '@mantine/core/styles.css';
import '@mantine/notifications/styles.css';
import './styles.css';

import { StrictMode, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import { Center, Loader, MantineProvider, Text } from '@mantine/core';
import { Notifications } from '@mantine/notifications';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from 'react-router';
import { createProjectRouter } from './router';
import { theme } from './theme';
import { setMcpProject } from './mcp/client';
import { listProjects } from './connect/projects';
import { ProjectsPage } from './pages/ProjectsPage';
import { AuthContext, fetchAuthStatus, loginPath, safeReturnTo, type AuthStatus } from './auth';
import { LoginPage, SetupPage } from './pages/AuthPages';
import { goTo, lastProject, legacyTarget, NAVIGATE_EVENT, parseProjectPath, projectBase, setCurrentProject } from './project';

const newQueryClient = () =>
  new QueryClient({
    defaultOptions: { queries: { retry: 1, staleTime: 5_000, refetchOnWindowFocus: true } },
  });

/** The browser path, re-read on back/forward and on `goTo` (picker <-> projects). */
function usePathname(): string {
  return useSyncExternalStore(
    (cb) => {
      window.addEventListener('popstate', cb);
      window.addEventListener(NAVIGATE_EVENT, cb);
      return () => {
        window.removeEventListener('popstate', cb);
        window.removeEventListener(NAVIGATE_EVENT, cb);
      };
    },
    () => window.location.pathname,
  );
}

/**
 * One project: its own router (basename `/p/<id>`, so app paths like `/specs/x` stay unchanged), query cache and MCP
 * session (`/p/<id>/mcp`). Remounted (keyed) when the project changes.
 */
function ProjectApp({ projectId }: { projectId: string }) {
  const [state] = useState(() => {
    // Before any page renders: every MCP call of this tree goes to the project's endpoint.
    setMcpProject(projectId);
    setCurrentProject(projectId);
    return { router: createProjectRouter(projectBase(projectId)), queryClient: newQueryClient() };
  });
  useEffect(() => {
    // StrictMode re-runs effects: re-assert the scope (cheap no-op when unchanged).
    setMcpProject(projectId);
    setCurrentProject(projectId);
    return () => state.queryClient.clear();
  }, [projectId, state]);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      // Dispose only on a real unmount (StrictMode unmounts and remounts synchronously in development).
      setTimeout(() => !mounted.current && state.router.dispose(), 0);
    };
  }, [state]);
  return (
    <QueryClientProvider client={state.queryClient}>
      <RouterProvider router={state.router} />
    </QueryClientProvider>
  );
}

function HomeApp() {
  const [queryClient] = useState(newQueryClient);
  useEffect(() => {
    setMcpProject(null);
    setCurrentProject(null);
  }, []);
  return (
    <QueryClientProvider client={queryClient}>
      <ProjectsPage />
    </QueryClientProvider>
  );
}

/** Pre-projects links (`/specs/x`): open the same page in the last-used project, else the default one. */
function LegacyRedirect() {
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const { pathname, search, hash } = window.location;
    const go = (id: string) => goTo(legacyTarget(id, pathname, search, hash), true);
    const last = lastProject();
    listProjects()
      .then((r) => go(last && r.items.some((p) => p.id === last) ? last : r.defaultProject))
      .catch((e: Error) => (last ? go(last) : setError(e.message)));
  }, []);
  return <Center h="100vh">{error ? <Text c="red">{error}</Text> : <Loader size="sm" />}</Center>;
}

function App() {
  const pathname = usePathname();
  const project = parseProjectPath(pathname);
  if (project) return <ProjectApp key={project.id} projectId={project.id} />;
  if (pathname === '/' || pathname === '') return <HomeApp />;
  return <LegacyRedirect key={pathname} />;
}

/**
 * Auth gate (always on): until GitHub sign-in is configured, the setup page (polling /auth/status every 3 s);
 * then `/login` until signed in; then the app.
 */
function Root() {
  const pathname = usePathname();
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = () =>
      fetchAuthStatus()
        .then((s) => {
          if (stop) return;
          setError(null);
          setStatus(s);
          if (!s.configured) timer = setTimeout(load, 3_000);
        })
        .catch((e: Error) => {
          if (stop) return;
          setError(e.message);
          timer = setTimeout(load, 3_000);
        });
    void load();
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, []);

  const onLogin = pathname === '/login';
  const needsLogin = !!status && status.configured && !status.authenticated && !onLogin;
  const leaveLogin = !!status && status.authenticated && onLogin;
  useEffect(() => {
    if (needsLogin) goTo(loginPath(), true);
    else if (leaveLogin) goTo(safeReturnTo(new URLSearchParams(window.location.search).get('returnTo')), true);
  }, [needsLogin, leaveLogin]);

  if (!status) return <Center h="100vh">{error ? <Text c="red">{error}</Text> : <Loader size="sm" />}</Center>;
  if (!status.configured) return <SetupPage status={status} />;
  if (onLogin || !status.authenticated) return <LoginPage status={status} />;
  return (
    <AuthContext.Provider value={status}>
      <App />
    </AuthContext.Provider>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <MantineProvider theme={theme} defaultColorScheme="auto">
      <Notifications position="bottom-right" limit={4} />
      <Root />
    </MantineProvider>
  </StrictMode>,
);

/**
 * `/cli-login?code=ABCD-2345`: approve a `mandate channel login` started in a terminal. You are signed in (the app's
 * auth gate sends you through GitHub first); the page names what you authorize (computer, project, your account) and the
 * code to compare with the one in the terminal. Approving gives that computer a personal token (event channel) that you
 * can revoke under Connect agent -> Personal tokens.
 */
import { useState } from 'react';
import { Alert, Button, Center, Code, Group, Loader, Paper, Stack, Text, Title } from '@mantine/core';
import { IconAlertTriangle, IconCheck, IconTerminal2 } from '@tabler/icons-react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { uiRequest } from '../lib/ui';

interface LoginInfo {
  code: string;
  project: { id: string; name: string };
  hostname: string;
  user: string;
  status: 'pending' | 'approved' | 'denied';
  expiresAt: string;
}

export function CliLoginPage() {
  const code = new URLSearchParams(window.location.search).get('code') ?? '';
  // The decision is remembered for this tab: once the CLI collects its token the code is gone (single use), so a later
  // refetch or remount would otherwise fall back to an error / the initial prompt.
  const doneKey = `mandate.cli-login.${code}`;
  const [done, setDone] = useState<'approved' | 'denied' | null>(() => {
    try {
      const v = sessionStorage.getItem(doneKey);
      return v === 'approved' || v === 'denied' ? v : null;
    } catch {
      return null;
    }
  });
  const info = useQuery({
    queryKey: ['cli-login', code],
    queryFn: () => uiRequest<LoginInfo>('GET', `/ui/cli-login/${encodeURIComponent(code)}`),
    enabled: !!code && !done,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const decide = useMutation({
    mutationFn: (approve: boolean) => uiRequest<{ status: 'approved' | 'denied' }>('POST', `/ui/cli-login/${encodeURIComponent(code)}/${approve ? 'approve' : 'deny'}`, {}),
    onSuccess: (r) => {
      try {
        sessionStorage.setItem(doneKey, r.status);
      } catch {
        // storage unavailable: the in-memory state still shows the result
      }
      setDone(r.status);
    },
  });
  const d = info.data;
  return (
    <Center mih="100vh" p="md">
      <Paper withBorder p="xl" radius="md" maw={460} w="100%" data-testid="cli-login">
        <Stack gap="md">
          <Group gap={8}>
            <IconTerminal2 size={20} />
            <Title order={3}>{done === 'approved' ? 'Mandate CLI authorized' : 'Authorize Mandate CLI'}</Title>
          </Group>
          {!code && <Alert color="red" icon={<IconAlertTriangle size={16} />}>No code in the link. Run <Code>mandate channel login</Code> again.</Alert>}
          {info.isLoading && <Loader size="sm" />}
          {info.isError && !done && (
            <Alert color="red" icon={<IconAlertTriangle size={16} />} data-testid="cli-login-error">
              {(info.error as Error).message}
            </Alert>
          )}
          {d && !done && (
            <>
              <Text>
                Authorize Mandate CLI on <b data-testid="cli-login-host">{d.hostname}</b> for project <b>{d.project.name}</b>?
              </Text>
              <Text size="sm" c="dimmed">
                This computer gets a personal token acting as <b>{d.user}</b> with your access to this project. It lets Mandate wake Claude Code (the event channel). You can revoke it any time under Connect agent, Personal tokens.
              </Text>
              <div>
                <Text size="xs" c="dimmed">
                  Confirm this code is the one in your terminal
                </Text>
                <Code fz="xl" fw={700} data-testid="cli-login-code">
                  {d.code}
                </Code>
              </div>
              {d.status !== 'pending' ? (
                <Alert color="gray">This login was already decided.</Alert>
              ) : (
                <Group>
                  <Button loading={decide.isPending} onClick={() => decide.mutate(true)} data-testid="cli-login-approve">
                    Approve
                  </Button>
                  <Button variant="default" disabled={decide.isPending} onClick={() => decide.mutate(false)} data-testid="cli-login-deny">
                    Deny
                  </Button>
                </Group>
              )}
              {decide.isError && <Alert color="red">{(decide.error as Error).message}</Alert>}
            </>
          )}
          {done === 'approved' && (
            <Alert color="green" icon={<IconCheck size={16} />} data-testid="cli-login-approved">
              Approved. Go back to your terminal: it has the token now. Start Claude Code with <Code>mandate claude</Code>. You can close this tab.
            </Alert>
          )}
          {done === 'denied' && <Alert color="gray">Denied. Nothing was given to that computer.</Alert>}
        </Stack>
      </Paper>
    </Center>
  );
}

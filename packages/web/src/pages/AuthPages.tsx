import { ActionIcon, Alert, Anchor, Box, Button, Code, Group, List, Stack, Text, Tooltip } from '@mantine/core';
import { IconAlertTriangle, IconBrandGithub, IconCopy, IconLoader2 } from '@tabler/icons-react';
import { useEffect, type ReactNode } from 'react';
import { APP_NAME, Logo } from '../components/Logo';
import { copyText } from '../lib/copy';
import { cli, AUTH_CONFIG_EXAMPLE, DEFAULT_CALLBACK_URL, githubLoginUrl, loginErrorMessage, safeReturnTo, type AuthStatus } from '../auth';

function AuthShell({ children, wide }: { children: ReactNode; wide?: boolean }) {
  return (
    <div className="auth-page">
      <div className={`auth-card${wide ? ' auth-card-wide' : ''}`}>
        <Group gap={10} mb="lg">
          <Logo size={28} />
          <Text fw={600} size="lg" style={{ letterSpacing: '-0.015em' }}>
            {APP_NAME}
          </Text>
        </Group>
        {children}
      </div>
    </div>
  );
}

/** `/login?returnTo=&error=`: Continue with GitHub (a top-level navigation; the server sets the HttpOnly session cookie). */
export function LoginPage({ status }: { status: AuthStatus }) {
  const params = new URLSearchParams(window.location.search);
  const returnTo = safeReturnTo(params.get('returnTo'));
  const error = loginErrorMessage(params.get('error'));
  useEffect(() => {
    document.title = `Sign in · ${APP_NAME}`;
  }, []);
  return (
    <AuthShell>
      <Text component="h1" fw={600} size="xl" style={{ letterSpacing: '-0.02em' }}>
        Sign in to {APP_NAME}
      </Text>
      <Text size="sm" c="var(--app-text-muted)" mt={6} mb="lg">
        {APP_NAME} keeps the specifications your coding agents work from.{' '}
        {status.mode === 'local' ? 'It runs on this computer.' : "Sign in with a GitHub account on this server's allow-list."}
      </Text>
      {error && (
        <Alert color="red" variant="light" icon={<IconAlertTriangle size={16} />} mb="md" data-testid="login-error">
          {error}
        </Alert>
      )}
      {status.mode === 'local' ? (
        <div className="np-stack" data-testid="local-login">
          <Text size="sm">Mandate runs on this computer. Open it from a terminal; the command opens your browser signed in with a one-time link:</Text>
          <CopyLine value={cli('open').npx} label="command" />
          <Text size="xs" c="var(--app-text-faint)">
            In a development checkout: <Code>{cli('open').dev}</Code>
          </Text>
        </div>
      ) : (
      <Button
        fullWidth
        size="md"
        color="dark"
        leftSection={<IconBrandGithub size={18} />}
        onClick={() => window.location.assign(githubLoginUrl(returnTo, status.loginUrl))}
        data-testid="github-login"
      >
        Continue with GitHub
      </Button>
      )}
    </AuthShell>
  );
}

function CopyLine({ value, label }: { value: string; label: string }) {
  return (
    <Group gap={6} wrap="nowrap" className="auth-copy-line">
      <Code className="auth-copy-code">{value}</Code>
      <Tooltip label={`Copy ${label}`}>
        <ActionIcon variant="subtle" size="sm" aria-label={`Copy ${label}`} onClick={() => void copyText(value, `Copied ${label}`)}>
          <IconCopy size={14} />
        </ActionIcon>
      </Tooltip>
    </Group>
  );
}

/** First run: GitHub sign-in is not configured yet. The parent polls `/auth/status` and continues once it is. */
export function SetupPage({ status }: { status: AuthStatus }) {
  const callback = status.callbackUrl ?? DEFAULT_CALLBACK_URL;
  const homepage = (() => {
    try {
      return new URL(callback).origin;
    } catch {
      return 'http://localhost:5173';
    }
  })();
  const example = JSON.stringify({ auth: { ...AUTH_CONFIG_EXAMPLE, github: { ...AUTH_CONFIG_EXAMPLE.github, callbackUrl: callback } } }, null, 2);
  useEffect(() => {
    document.title = `Set up sign-in · ${APP_NAME}`;
  }, []);
  return (
    <AuthShell wide>
      <Text component="h1" fw={600} size="xl" style={{ letterSpacing: '-0.02em' }}>
        Set up GitHub sign-in
      </Text>
      <Text size="sm" c="var(--app-text-muted)" mt={6} mb="md">
        {APP_NAME} always requires sign-in. Connect a GitHub OAuth App once; this page continues by itself when the server picks up the config.
      </Text>
      {status.missing.length > 0 && (
        <Alert color="yellow" variant="light" icon={<IconAlertTriangle size={16} />} mb="md" title="Missing" data-testid="auth-missing">
          <List size="sm" spacing={2}>
            {status.missing.map((m) => (
              <List.Item key={m}>
                <Code>{m}</Code>
              </List.Item>
            ))}
          </List>
        </Alert>
      )}
      <ol className="auth-steps">
        <li>
          <Text size="sm" fw={600}>
            Create a GitHub OAuth App
          </Text>
          <Text size="sm" c="var(--app-text-muted)">
            At{' '}
            <Anchor href="https://github.com/settings/applications/new" target="_blank" rel="noreferrer">
              github.com/settings/applications/new
            </Anchor>{' '}
            (or your organization's developer settings). Homepage URL:
          </Text>
          <CopyLine value={homepage} label="homepage URL" />
        </li>
        <li>
          <Text size="sm" fw={600}>
            Authorization callback URL
          </Text>
          <Text size="sm" c="var(--app-text-muted)">
            Exactly:
          </Text>
          <CopyLine value={callback} label="callback URL" />
        </li>
        <li>
          <Text size="sm" fw={600}>
            Client id and secret
          </Text>
          <Text size="sm" c="var(--app-text-muted)">
            Put <Code>clientId</Code> in <Code>~/.mandate/config.json</Code> under <Code>auth.github</Code>. Put the secret in <Code>~/.mandate/secrets.env</Code> (or the environment) as:
          </Text>
          <CopyLine value={`${AUTH_CONFIG_EXAMPLE.github.clientSecretEnv}=...`} label="secret line" />
          <Text size="xs" c="var(--app-text-faint)" mt={4}>
            Or whichever variable <Code>auth.github.clientSecretEnv</Code> names. Never put the secret in config.json.
          </Text>
        </li>
        <li>
          <Text size="sm" fw={600}>
            Who may sign in
          </Text>
          <Text size="sm" c="var(--app-text-muted)">
            List GitHub logins in <Code>allowedUsers</Code> and/or organizations in <Code>allowedOrgs</Code>.
          </Text>
        </li>
      </ol>
      <Box className="connect-snippet" mt="md">
        <Group justify="space-between" gap={6} className="connect-snippet-head" wrap="nowrap">
          <Text size="xs" c="dimmed">
            ~/.mandate/config.json (the auth block)
          </Text>
          <ActionIcon size="sm" variant="subtle" aria-label="Copy auth block" onClick={() => void copyText(example, 'Copied auth block')}>
            <IconCopy size={14} />
          </ActionIcon>
        </Group>
        <Code block className="connect-code">
          {example}
        </Code>
      </Box>
      <Group gap={6} mt="md" c="var(--app-text-faint)">
        <IconLoader2 size={14} className="spin" />
        <Text size="xs">Waiting for the configuration…</Text>
      </Group>
    </AuthShell>
  );
}

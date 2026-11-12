import { Alert, Button, Skeleton, Stack, Text, ThemeIcon } from '@mantine/core';
import { IconAlertTriangle, IconRefresh } from '@tabler/icons-react';
import type { ReactNode } from 'react';

const WIDTHS = [62, 48, 70, 40, 55, 66, 44];

/** Placeholder rows matching `.row` geometry. */
export function RowsSkeleton({ rows = 7 }: { rows?: number }) {
  return (
    <div aria-busy="true" aria-label="Loading">
      {WIDTHS.slice(0, rows).map((w, i) => (
        <div key={i} className="row" style={{ pointerEvents: 'none' }}>
          <Skeleton circle height={14} width={14} />
          <Skeleton height={10} width={90} radius="sm" />
          <Skeleton height={10} width={`${w}%`} maw={420} radius="sm" />
          <Skeleton height={10} width={48} radius="sm" ml="auto" />
        </div>
      ))}
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: Error; onRetry?: () => void }) {
  return (
    <Alert
      m="md"
      color="red"
      variant="light"
      icon={<IconAlertTriangle size={16} />}
      title="Couldn't load data"
      radius="md"
    >
      <Stack gap="xs" align="flex-start">
        <Text size="md">{error.message}</Text>
        {onRetry && (
          <Button variant="default" leftSection={<IconRefresh size={14} />} onClick={onRetry}>
            Try again
          </Button>
        )}
      </Stack>
    </Alert>
  );
}

export function EmptyView({ icon, title, description, action }: { icon: ReactNode; title: string; description: ReactNode; action?: ReactNode }) {
  return (
    <Stack align="center" gap={8} py={80} px="md" ta="center">
      <ThemeIcon size={44} radius="lg" variant="light" color="gray">
        {icon}
      </ThemeIcon>
      <Text fw={600} size="lg" mt={4}>
        {title}
      </Text>
      <Text size="md" c="var(--app-text-muted)" maw={380}>
        {description}
      </Text>
      {action}
    </Stack>
  );
}

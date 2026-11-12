import { Button, Text } from '@mantine/core';
import { IconArrowRight, IconPlugConnected } from '@tabler/icons-react';
import { ConnectAgentGuide } from './ConnectAgentGuide';

/** Last step of New project (both modes): connect a coding agent to the new project, then open it. */
export function PostCreateConnect({ project, onOpen }: { project: { id: string; name: string }; onOpen: () => void }) {
  return (
    <div data-testid="post-create-connect">
      <header className="np-head">
        <div className="np-tile">
          <IconPlugConnected size={17} stroke={1.8} />
        </div>
        <div style={{ minWidth: 0, flex: 1 }}>
          <Text fw={600} size="md" className="np-title">
            Connect your coding agent
          </Text>
          <Text size="sm" className="np-subtitle">
            {project.name} is ready. Point your coding agent at it so it can read specs and pick up work orders.
          </Text>
        </div>
      </header>
      <div className="np-body cg-body">
        <ConnectAgentGuide projectId={project.id} compact />
      </div>
      <footer className="np-foot">
        <span className="np-muted np-foot-count">
          Show this again any time: <b>Connect agent</b> in the project&apos;s sidebar.
        </span>
        <Button type="button" onClick={onOpen} rightSection={<IconArrowRight size={15} />} data-testid="post-create-open">
          Done, open project
        </Button>
      </footer>
    </div>
  );
}

import { Button, Text } from '@mantine/core';
import { IconArrowRight, IconPlugConnected } from '@tabler/icons-react';
import { ConnectAgentGuide } from './ConnectAgentGuide';
import './newProject.css';

/** Last step of New project: connect a coding agent to the new project, then open it. */
export function PostCreateConnect({ project, onOpen }: { project: { id: string; name: string }; onOpen: () => void }) {
  return (
    <div data-testid="post-create-connect" className="pj-form">
      <header className="pj-head">
        <div className="pj-tile" data-tone="ok">
          <IconPlugConnected size={20} stroke={1.7} />
        </div>
        <div className="pj-head-text">
          <Text component="h2" className="pj-title">
            Connect your coding agent
          </Text>
          <Text size="sm" className="np-muted">
            {project.name} is ready. Point your coding agent at it so it can read specs and pick up work orders.
          </Text>
        </div>
      </header>
      <div className="pj-body cg-body">
        <ConnectAgentGuide projectId={project.id} compact />
      </div>
      <footer className="pj-foot">
        <Text size="xs" className="np-muted pj-foot-note">
          Show this again any time: <b>Connect agent</b> in the project&apos;s sidebar.
        </Text>
        <Button type="button" size="sm" onClick={onOpen} rightSection={<IconArrowRight size={15} />} data-testid="post-create-open">
          Done, open project
        </Button>
      </footer>
    </div>
  );
}

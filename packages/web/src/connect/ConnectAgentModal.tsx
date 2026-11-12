import { Group, Modal, Text } from '@mantine/core';
import { IconPlugConnected } from '@tabler/icons-react';
import { ConnectAgentGuide } from './ConnectAgentGuide';

export type { ConnectInfo } from './ConnectAgentGuide';

let opener: (() => void) | undefined;
/** Open the project's "Connect agent" dialog from anywhere (command palette); a no-op outside a project layout. */
export const openConnectAgent = () => opener?.();
/** Registers the layout's dialog opener (AppLayout). */
export function registerConnectAgentOpener(fn: () => void) {
  opener = fn;
  return () => {
    if (opener === fn) opener = undefined;
  };
}

/** "Connect agent": how a coding agent reaches this project's MCP endpoint with its bearer key. Read-only: never creates keys. */
export function ConnectAgentModal({ projectId, opened, onClose }: { projectId: string; opened: boolean; onClose: () => void }) {
  return (
    <Modal
      opened={opened}
      onClose={onClose}
      size="xl"
      radius={14}
      overlayProps={{ backgroundOpacity: 0.28, blur: 3 }}
      title={
        <Group gap={8}>
          <IconPlugConnected size={18} stroke={1.7} />
          <Text fw={600}>Connect a coding agent</Text>
        </Group>
      }
    >
      {opened && <ConnectAgentGuide projectId={projectId} />}
    </Modal>
  );
}

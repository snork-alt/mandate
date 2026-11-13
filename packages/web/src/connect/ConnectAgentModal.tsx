import { Modal, Text } from '@mantine/core';
import { IconPlugConnected } from '@tabler/icons-react';
import { AccessBadge } from './AccessBadge';
import { ConnectAgentGuide, useConnectSetup } from './ConnectAgentGuide';

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

/** Dialog header: tile, title, then "<project> · <host>/p/<id>" and the access badge. */
function ConnectHeader({ projectId }: { projectId: string }) {
  const { info, base, ctx } = useConnectSetup(projectId);
  const name = info.data?.project.name ?? projectId;
  const host = base.replace(/^https?:\/\//, '');
  return (
    <div className="cg2-head">
      <span className="cg2-tile">
        <IconPlugConnected size={20} stroke={1.7} />
      </span>
      <div style={{ minWidth: 0 }}>
        <Text fw={600} className="cg2-title">
          Connect a coding agent
        </Text>
        <div className="cg2-sub">
          <span>{name}</span>
          {host && (
            <>
              <span className="np-faint">·</span>
              <span className="cg2-mono-sm">{`${host}/p/${projectId}`}</span>
            </>
          )}
          <AccessBadge access={ctx.access} />
        </div>
      </div>
    </div>
  );
}

/** "Connect agent": per-agent install and sign-in for this project's MCP endpoint; manual setup under Advanced. */
export function ConnectAgentModal({ projectId, opened, onClose }: { projectId: string; opened: boolean; onClose: () => void }) {
  return (
    <Modal
      opened={opened}
      onClose={onClose}
      size={800}
      radius={14}
      overlayProps={{ backgroundOpacity: 0.28, blur: 3 }}
      classNames={{ header: 'cg2-modal-header', body: 'cg2-modal-body' }}
      title={opened ? <ConnectHeader projectId={projectId} /> : null}
    >
      {opened && <ConnectAgentGuide projectId={projectId} />}
    </Modal>
  );
}

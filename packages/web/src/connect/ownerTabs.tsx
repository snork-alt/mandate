/** GitHub owner pieces shared by the New-project repository pickers (specs and code repositories). */
import { Avatar, Tabs, Tooltip } from '@mantine/core';
import { IconExternalLink, IconLock, IconPlus } from '@tabler/icons-react';
import type { GithubOwner } from './github';

export const ownerLabel = (o: GithubOwner) => o.name || o.login;

export function OwnerAvatar({ url, login, size = 20 }: { url?: string | null; login: string; size?: number }) {
  return (
    <Avatar src={url ?? undefined} size={size} radius={size >= 20 ? 6 : 5} className="np-avatar" alt="">
      {login.slice(0, 1).toUpperCase()}
    </Avatar>
  );
}

/** Account / organization picker: the app's underline tabs, with avatars. */
/**
 * `addUrl`: where the user gives Mandate access to another account / organization (GitHub App: install it there;
 * OAuth App: GitHub's page with the per-organization Grant / Request buttons). Opens in a new tab; refresh after.
 */
export function OwnerTabs({ owners, value, onChange, addUrl, app }: { owners: GithubOwner[]; value: string; onChange: (v: string) => void; addUrl?: string | null; app?: boolean }) {
  return (
    <Tabs value={value} onChange={(v) => v && onChange(v)} className="pj-owners" data-testid="owner-switcher" aria-label="Repository owner">
      <Tabs.List>
        <Tabs.Tab value="all" data-testid="owner-all">
          All
        </Tabs.Tab>
        {owners.map((o) => (
          <Tooltip key={o.login} label={o.restricted ? `${ownerLabel(o)} has not approved Mandate yet` : o.type === 'user' ? 'Your own repositories' : ownerLabel(o)}>
            <Tabs.Tab
              value={o.login}
              data-restricted={o.restricted || undefined}
              data-testid={`owner-${o.login}`}
              leftSection={<OwnerAvatar url={o.avatarUrl} login={o.login} size={18} />}
              rightSection={o.restricted ? <IconLock size={12} className="np-owner-lock" /> : undefined}
            >
              {o.type === 'user' ? o.login : ownerLabel(o)}
            </Tabs.Tab>
          </Tooltip>
        ))}
        {addUrl && (
          <Tooltip label={app ? 'Install the Mandate GitHub App on another account or organization, then come back' : 'Grant (or request) access for another organization on GitHub, then come back'}>
            <a href={addUrl} target="_blank" rel="noreferrer" className="pj-owner-add" data-testid="owner-add">
              <IconPlus size={14} />
              Add organization
              <IconExternalLink size={12} className="pj-owner-add-ext" />
            </a>
          </Tooltip>
        )}
      </Tabs.List>
    </Tabs>
  );
}


/**
 * "+ New request": the web equivalent of `/mandate <text>` in the CLI. What do you want (with @-references), who
 * handles it (the comments / Ask agent picker: online idle / busy with what / offline = queued until it connects /
 * Any agent = the next free one), priority and "Plan only". Submit navigates to the request page.
 */
import { useEffect, useState } from 'react';
import { Button, Checkbox, Modal, SegmentedControl } from '@mantine/core';
import { useNavigate } from 'react-router';
import { extractRefs } from '@mandate/shared';
import { activeAgents, AgentPicker, defaultAgent } from '../comments/CommentsPanel';
import { RefMentionBox } from '../mentions/RefMentionBox';
import { useAgentsPresence } from '../../lib/comments';
import { useCreateRequest, type Priority } from '../../lib/requests';
import '../comments/comments.css';
import './requests.css';

export function NewRequestModal({ opened, onClose, initialBody }: { opened: boolean; onClose: () => void; /** Prefilled text (an @-reference and a change summary). */ initialBody?: string }) {
  const navigate = useNavigate();
  const presence = useAgentsPresence(undefined);
  const [body, setBody] = useState('');
  const [pick, setPick] = useState<string | undefined>();
  const [priority, setPriority] = useState<Priority>('normal');
  const [planOnly, setPlanOnly] = useState(false);
  const [touched, setTouched] = useState(false);
  const create = useCreateRequest((id) => {
    onClose();
    navigate(`/requests/${id}`);
  });
  useEffect(() => {
    if (opened) {
      if (initialBody) setBody(initialBody);
      return;
    }
    setBody('');
    setPick(undefined);
    setPriority('normal');
    setPlanOnly(false);
    setTouched(false);
  }, [opened, initialBody]);

  const p = presence.data;
  const assignee = pick && activeAgents(p).some((a) => a.handle === pick) ? pick : defaultAgent(p);
  const chosen = p?.agents?.find((a) => a.handle === assignee);
  const target = chosen?.label ?? 'agent';
  const empty = body.trim().length === 0;
  const submit = () => {
    setTouched(true);
    if (empty || !assignee || create.isPending) return;
    create.mutate({ body: body.trim(), assignee, priority, planOnly, context: extractRefs(body) });
  };

  return (
    <Modal opened={opened} onClose={onClose} title="New request" size="lg" centered data-testid="new-request">
      <form
        className="nr-form"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <div>
          <div className="nr-label">What do you want?</div>
          <RefMentionBox
            value={body}
            onChange={setBody}
            presence={p}
            label="What do you want?"
            placeholder="Describe the change or fix in your own words…"
            minRows={4}
            maxRows={12}
            autoFocus
            onSubmit={submit}
            error={touched && empty ? 'Tell the agent what you want' : undefined}
          />
          <div className="nr-hint">Type @ to point at a spec, section, standard, component, request or work order. Leave them out: the agent matches the request to specs itself.</div>
        </div>
        <div>
          <div className="nr-label">Who should handle it?</div>
          <AgentPicker presence={p} value={assignee} onChange={setPick} name="nr-agent" />
        </div>
        <div className="nr-row">
          <div>
            <div className="nr-label">Priority</div>
            <SegmentedControl
              size="xs"
              value={priority}
              onChange={(v) => setPriority(v as Priority)}
              data={[
                { value: 'low', label: 'Low' },
                { value: 'normal', label: 'Normal' },
                { value: 'high', label: 'High' },
              ]}
              aria-label="Priority"
            />
          </div>
          <Checkbox
            checked={planOnly}
            onChange={(e) => setPlanOnly(e.currentTarget.checked)}
            label="Plan only"
            description="Stop after the spec update and the work-order plan, so you can review before any code is written."
          />
        </div>
        <div className="nr-foot">
          <span className="nr-hint">The agent asks only when it must; questions appear in Waiting for you.</span>
          <Button variant="default" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={create.isPending} disabled={!assignee} data-testid="new-request-submit">
            Send to {target}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

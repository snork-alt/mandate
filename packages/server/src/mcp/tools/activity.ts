/** Live activity feed tools: git-backed listing and per-session notification filters. */
import { ACTIVITY_NOTIFICATION, activityListInputSchema, activitySubscribeInputSchema } from '@mandate/shared';
import { defineTool, type ToolContext } from '../define.js';
import { ToolError } from '../errors.js';

const needBus = (ctx: ToolContext) => {
  if (!ctx.activity) throw new ToolError('activity_unavailable', 'the activity feed is not enabled on this server', 'restart the server; check its log');
  return ctx.activity;
};

export const activityTools = [
  defineTool({
    name: 'activity_list',
    title: 'Activity feed',
    kind: 'read',
    description: `Events derived from commits, newest first (git-backed, survives restarts): spec.* / standard.* (created, updated, status_changed, deleted, section.inserted|updated|moved|deleted with a word-diff preview), work_order.* (created, claimed, heartbeat (flagged heartbeat: true), section_done, completed, released, ...), feedback.* (created, updated, closed), verification.recorded, git.pulled, commit.
Filters: since (commit sha, exclusive, or ISO date: reconnect backfill; pass the returned head), until, types (exact or patterns like spec.* or *.created), agent, ref (a document matches events on its sections, work orders and feedback), includeHeartbeats. Paginated (limit ≤ 500, cursor).
Example: {"ref":"mandate://specs/login-sso","limit":20} or {"since":"<head from the last call>"}`,
    input: activityListInputSchema,
    run: (a, ctx) => needBus(ctx).list(a),
  }),
  defineTool({
    name: 'activity_subscribe',
    title: 'Subscribe to activity',
    kind: 'read',
    description: `Filter the live \`${ACTIVITY_NOTIFICATION}\` notifications this session receives over the SSE stream (default: every event). types (exact or patterns), ref, agent; enabled: false stops them. Replaces the previous filter. Backfill with activity_list({ since }).
Example: {"types":["work_order.*"],"ref":"mandate://specs/login-sso"}`,
    input: activitySubscribeInputSchema,
    run: async (a, ctx) => {
      needBus(ctx);
      if (!ctx.session) throw new ToolError('no_session', 'subscriptions need a Streamable HTTP session', 'connect over /mcp');
      ctx.session.subscription = { enabled: a.enabled, ...(a.types ? { types: a.types } : {}), ...(a.ref ? { ref: a.ref } : {}), ...(a.agent ? { agent: a.agent } : {}) };
      return { subscribed: a.enabled, filter: ctx.session.subscription };
    },
  }),
];

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
    description: `Events derived from commits, newest first: spec.* / standard.* (incl. section.* with word-diff preview), work_order.*, feedback.*, verification.recorded, git.pulled, commit.
Filters: since (sha, exclusive, or ISO date; pass the returned head to backfill), until, types (exact or patterns like spec.*, *.created), agent, user (server mode), ref (a doc also matches its sections, work orders, feedback), includeHeartbeats. Paginated.
Example: {"ref":"mandate://specs/login-sso","limit":20}`,
    input: activityListInputSchema,
    run: (a, ctx) => needBus(ctx).list(a),
  }),
  defineTool({
    name: 'activity_subscribe',
    title: 'Subscribe to activity',
    kind: 'read',
    description: `Filter the live \`${ACTIVITY_NOTIFICATION}\` notifications this session receives (default: all). types (exact or patterns), ref, agent, user; enabled: false stops them. Replaces the previous filter; backfill with activity_list({ since }).
Example: {"types":["work_order.*"],"ref":"mandate://specs/login-sso"}`,
    input: activitySubscribeInputSchema,
    run: async (a, ctx) => {
      needBus(ctx);
      if (!ctx.session) throw new ToolError('no_session', 'subscriptions need a Streamable HTTP session', 'connect over /mcp');
      ctx.session.subscription = { enabled: a.enabled, ...(a.types ? { types: a.types } : {}), ...(a.ref ? { ref: a.ref } : {}), ...(a.agent ? { agent: a.agent } : {}), ...(a.user ? { user: a.user } : {}) };
      return { subscribed: a.enabled, filter: ctx.session.subscription };
    },
  }),
];

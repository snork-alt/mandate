/**
 * The Mandate MCP server: tool registry (`defineTool`), resources and instructions. One `McpServer` per session
 * (the SDK binds a server to one transport); all sessions share the same ToolContext (storage, IndexService).
 * Tools and resources go through low-level handlers so every call runs the shared `callTool` validation wrapper.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { MCP_SERVER_NAME } from '@mandate/shared';
import { callTool, describeTool, type AnyToolDef, type SessionState, type ToolContext } from './define.js';
import { listResources, readResource, RESOURCE_TEMPLATES } from './resources.js';
import { docTools } from './tools/docs.js';
import { graphTools } from './tools/graph.js';
import { opsTools } from './tools/ops.js';
import { viewTools } from './tools/views.js';
import { activityTools } from './tools/activity.js';
import { askTools, setAskRegistry } from './tools/ask.js';
import { searchTools } from './tools/search.js';
import { ruleTools } from './tools/rules.js';
import { writeTools } from './tools/write.js';
import { componentTools } from './tools/components.js';

export const MCP_VERSION = '0.1.0';

export const INSTRUCTIONS = `Mandate is a git-backed specification system for coding agents.
Model: specs (what to build) and standards (rules specs follow) are markdown documents split into typed sections (markdown, mermaid, acceptance criteria, ...); work orders ask agents to implement / update / review / verify sections of one spec at a pinned commit; feedback items record the why behind changes and target sections; verification results record pass/fail per acceptance criterion and spec.
References are the keys everywhere: mandate://specs/<id>[@sha][/sections/<sid>][#Lx-Ly], mandate://standards/..., mandate://work-orders/<id>, mandate://feedback/<id>, mandate://symbols/<name>, mandate://code/<repo>/<path>#L.., mandate://commits/<sha>. Every tool accepts them as copied (the @mandate: prefix is optional; @sha pins a version).
Workflow: 1) search (or symbol_search / code_search / text_search) to find entry points; 2) graph_* tools (graph_neighbors, graph_impact, graph_path, graph_query with Cypher) to follow dependencies, standards and code; 3) spec_get / spec_section_get / work_order_get to read exactly what you need (use metadataOnly and sections to stay small). activity_list shows what agents changed recently; live events arrive as notifications/mandate/activity.
Errors are structured { code, message, path, hint }: fix the input using the hint and retry.`;

/** Every tool, in tools/list order. Write tools will be appended here (they share `defineTool` and `callTool`). */
export const TOOLS: AnyToolDef[] = [...searchTools, ...graphTools, ...docTools, ...componentTools, ...writeTools, ...activityTools, ...askTools, ...ruleTools, ...viewTools, ...opsTools];
setAskRegistry(() => TOOLS);
const BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

export function createMcpServer(base: ToolContext, session: SessionState = { subscription: null }): McpServer {
  const mcp = new McpServer(
    { name: MCP_SERVER_NAME, title: 'Mandate', version: MCP_VERSION },
    { capabilities: { tools: { listChanged: false }, resources: { listChanged: false }, logging: {} }, instructions: INSTRUCTIONS },
  );
  const server = mcp.server;
  const ctx = (): ToolContext => ({ ...base, session, clientName: server.getClientVersion()?.name });

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const c = ctx();
    const tools = await Promise.all(TOOLS.map(async (t) => describeTool(t, typeof t.description === 'function' ? await t.description(c) : t.description)));
    return { tools };
  });

  server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
    const def = BY_NAME.get(req.params.name);
    if (!def) {
      return {
        isError: true,
        content: [{ type: 'text', text: JSON.stringify({ error: { code: 'unknown_tool', message: `no tool '${req.params.name}'`, path: 'name', hint: 'call tools/list' } }) }],
      };
    }
    return callTool(def, req.params.arguments, {
      ...ctx(),
      signal: extra.signal,
      // Related to this request, so the notifications travel on its stream (POST SSE response).
      notify: (method, params) => extra.sendNotification({ method, params } as never),
    });
  });

  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({ resourceTemplates: RESOURCE_TEMPLATES }));
  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    try {
      return { resources: await listResources(ctx()) };
    } catch (e) {
      throw new McpError(ErrorCode.InternalError, (e as Error).message);
    }
  });
  server.setRequestHandler(ReadResourceRequestSchema, async (req) => readResource(ctx(), req.params.uri));

  return mcp;
}

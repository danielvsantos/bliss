import * as Sentry from '@sentry/nextjs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createLoopbackClient } from './loopback.js';
import { toolError } from './errors.js';
import { capResponse, omitDeep } from './shape.js';
import { toolsForRole } from './registry.js';
import { MCP_INSTRUCTIONS } from './instructions.js';

/**
 * MCP server factory and stateless Streamable HTTP handling (#89).
 * A new server + transport per request: no sessions, any replica can answer.
 */

const MCP_SERVER_NAME = 'bliss';
const MCP_SERVER_VERSION = '1.0.0';

/**
 * Wrap a tool handler: bind a loopback client tagged with the tool name,
 * shape the result, map failures to MCP tool errors and log one line.
 */
export function wrapTool(tool, req) {
  return async (args) => {
    const started = Date.now();
    const api = createLoopbackClient({ req, tool: tool.name });
    let ok = false;
    try {
      const result = capResponse(omitDeep(await tool.handler(args ?? {}, { api })));
      ok = true;
      return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
    } catch (err) {
      return toolError(err, { tool: tool.name, notFoundHint: tool.notFoundHint });
    } finally {
      console.info(JSON.stringify({
        event: 'mcp_tool_call',
        tenantId: req.user?.tenantId,
        integrationId: req.user?.integrationId,
        apiKeyId: req.user?.apiKeyId,
        tool: tool.name,
        ok,
        calls: api.calls,
        ms: Date.now() - started,
      }));
    }
  };
}

/** Build an McpServer exposing only the tools the caller's role may use. */
function createMcpServer(req) {
  const server = new McpServer(
    { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
    { capabilities: { tools: {} }, instructions: MCP_INSTRUCTIONS },
  );
  for (const tool of toolsForRole(req.user?.role)) {
    server.registerTool(
      tool.name,
      { title: tool.title, description: tool.description, inputSchema: tool.input, annotations: tool.annotations },
      wrapTool(tool, req),
    );
  }
  return server;
}

export async function handleMcpRequest(req, res) {
  const server = createMcpServer(req);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on('close', () => {
    transport.close().catch(() => {});
    server.close().catch(() => {});
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    Sentry.captureException(err);
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
    }
  }
}

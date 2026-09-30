import { StatusCodes } from 'http-status-codes';
import { withAuth } from '../../utils/withAuth.js';
import { handleMcpRequest } from '../../lib/mcp/server.js';
import { mcpChallenge } from '../../utils/oauth.js';

/**
 * MCP server for AI agents (#89) — `POST /api/mcp`.
 *
 * Streamable HTTP transport in stateless JSON mode: every request builds a
 * fresh server, so any API replica can answer any call. Authenticated by
 * Bliss integration API keys only (#84); cookie sessions and user JWTs get
 * 401. Read-only keys may POST here (exact-path allowance in
 * utils/integrationPolicy.js) and only see the read tools. Each tool calls the
 * existing REST route over loopback with the caller's key, so withAuth's role
 * cap, denylist and tenant scoping apply to every tool call.
 */
const mcpHandler = withAuth(async function handler(req, res) {
  if (req.user?.authType !== 'integration') {
    return res.status(StatusCodes.UNAUTHORIZED).json({
      error: 'MCP requires a Bliss integration API key',
      code: 'INTEGRATION_KEY_REQUIRED',
    });
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(StatusCodes.METHOD_NOT_ALLOWED).json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Method not allowed' },
      id: null,
    });
  }

  return handleMcpRequest(req, res);
});

/**
 * Every 401 from this route carries the OAuth challenge (RFC 9728 §5.1), so
 * OAuth-only clients (Claude Cowork / claude.ai connectors) can discover the
 * authorization server. A rejected `bliss_` token also gets
 * error="invalid_token", which makes an OAuth client refresh.
 */
export default function handler(req, res) {
  const status = res.status.bind(res);
  res.status = (code) => {
    if (code === StatusCodes.UNAUTHORIZED) {
      const presentedKey = /^bearer\s+bliss_/i.test(req.headers?.authorization || '');
      res.setHeader('WWW-Authenticate', mcpChallenge({ invalidToken: presentedKey }));
    }
    return status(code);
  };
  return mcpHandler(req, res);
}

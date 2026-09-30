#!/usr/bin/env node
/**
 * MCP smoke test (#89): initialize → tools/list → tools/call list_accounts
 * against a running Bliss API, in stateless Streamable HTTP mode.
 *
 *   BLISS_URL=http://localhost:3000 BLISS_API_KEY=bliss_… pnpm --filter @bliss/api mcp:smoke
 *
 * Exits non-zero on any failure. Never prints the key.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const baseUrl = (process.env.BLISS_URL || 'http://localhost:3000').replace(/\/+$/, '');
const key = process.env.BLISS_API_KEY;
if (!key) {
  console.error('Set BLISS_API_KEY to a Bliss integration key (bliss_…).');
  process.exit(2);
}

const url = new URL(`${baseUrl}/api/mcp`);
const client = new Client({ name: 'bliss-mcp-smoke', version: '1.0.0' });
const transport = new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: `Bearer ${key}` } } });

try {
  await client.connect(transport);
  const server = client.getServerVersion();
  console.log(`✓ initialize: ${server?.name} ${server?.version}`);
  if (transport.sessionId) throw new Error(`expected a stateless server, got session id ${transport.sessionId}`);
  console.log('✓ stateless (no Mcp-Session-Id)');

  const { tools } = await client.listTools();
  const writes = tools.filter((t) => !t.annotations?.readOnlyHint).length;
  console.log(`✓ tools/list: ${tools.length} tools (${tools.length - writes} read, ${writes} write)`);

  const result = await client.callTool({ name: 'list_accounts', arguments: {} });
  if (result.isError) throw new Error(`list_accounts failed: ${result.content?.[0]?.text}`);
  console.log(`✓ tools/call list_accounts: ${result.structuredContent?.items?.length ?? 0} account(s)`);
  await client.close();
  process.exit(0);
} catch (err) {
  console.error(`✗ ${err.message}`);
  process.exit(1);
}

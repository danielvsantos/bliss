/**
 * Integration test helper — a real HTTP server for the MCP loopback (#89).
 *
 * MCP tools call the REST API over HTTP. This helper starts `http.createServer`
 * on an ephemeral port that dispatches `/api/*` to the real Pages Router
 * handlers (a minimal stand-in for Next's API resolver: dynamic segments,
 * query arrays, JSON body, `res.status()/json()/send()`), and points
 * `MCP_LOOPBACK_URL` at it. `/api/mcp` itself is served the same way, so an
 * SDK client exercises withAuth, the MCP route, the loopback and every REST
 * handler end to end against the real bliss_test database.
 */

import http from 'http';
import { readdirSync, statSync } from 'fs';
import { join, relative, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import type { AddressInfo } from 'net';
import { OAUTH_REWRITES } from '../../lib/oauthRewrites.js';

const API_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../pages/api');

interface RouteEntry {
  file: string;
  regex: RegExp;
  params: string[];
  dynamicCount: number;
}

function listRouteFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return listRouteFiles(full);
    return /\.(js|ts)$/.test(name) ? [relative(API_ROOT, full).split('\\').join('/')] : [];
  });
}

function buildRoutes(): RouteEntry[] {
  return listRouteFiles(API_ROOT)
    .map((file) => {
      const params: string[] = [];
      const segments = file.replace(/\.(js|ts)$/, '').replace(/(^|\/)index$/, '').split('/').filter(Boolean);
      const pattern = segments.map((seg) => {
        const catchAll = seg.match(/^\[\.\.\.(.+)\]$/);
        if (catchAll) { params.push(catchAll[1]); return '(.+)'; }
        const dyn = seg.match(/^\[(.+)\]$/);
        if (dyn) { params.push(dyn[1]); return '([^/]+)'; }
        return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      }).join('/');
      return { file, regex: new RegExp(`^/api${pattern ? `/${pattern}` : ''}/?$`), params, dynamicCount: params.length };
    })
    // Static routes win over dynamic ones, like Next.
    .sort((a, b) => a.dynamicCount - b.dynamicCount);
}

function parseQuery(search: URLSearchParams) {
  const query: Record<string, string | string[]> = {};
  for (const key of new Set(search.keys())) {
    const all = search.getAll(key);
    query[key] = all.length > 1 ? all : all[0];
  }
  return query;
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export interface LoopbackServer {
  baseUrl: string;
  close: () => Promise<void>;
}

export async function startLoopbackServer(): Promise<LoopbackServer> {
  const routes = buildRoutes();
  const handlers = new Map<string, any>();

  const server = http.createServer(async (req: any, res: any) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      // Mirror next.config.mjs rewrites (OAuth discovery, #89).
      for (const { source, destination } of OAUTH_REWRITES) {
        const base = source.replace('/:path*', '');
        if (url.pathname === base || (source.endsWith('/:path*') && url.pathname.startsWith(`${base}/`))) {
          url.pathname = destination;
          break;
        }
      }
      const route = routes.find((r) => r.regex.test(url.pathname));
      res.status = (code: number) => { res.statusCode = code; return res; };
      res.json = (body: unknown) => {
        if (!res.getHeader('content-type')) res.setHeader('content-type', 'application/json; charset=utf-8');
        res.end(JSON.stringify(body));
        return res;
      };
      res.send = (body: unknown) => (typeof body === 'object' ? res.json(body) : res.end(body));
      if (!route) { res.status(404).json({ error: 'No such route' }); return; }

      const match = url.pathname.match(route.regex)!;
      const params = Object.fromEntries(route.params.map((p, i) => [p, decodeURIComponent(match[i + 1])]));
      req.query = { ...parseQuery(url.searchParams), ...params };
      req.cookies = Object.fromEntries(
        String(req.headers.cookie || '').split(';').map((c) => c.trim().split('=')).filter(([k]) => k),
      );
      const raw = ['GET', 'HEAD'].includes(req.method) ? '' : await readBody(req);
      const contentType = String(req.headers['content-type'] || '');
      if (raw && contentType.includes('json')) req.body = JSON.parse(raw);
      else if (raw && contentType.includes('application/x-www-form-urlencoded')) req.body = Object.fromEntries(new URLSearchParams(raw));
      else req.body = raw || {};

      if (!handlers.has(route.file)) {
        handlers.set(route.file, (await import(pathToFileURL(join(API_ROOT, route.file)).href)).default);
      }
      await handlers.get(route.file)(req, res);
    } catch (err) {
      if (!res.headersSent) {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: 'Harness error', details: String((err as Error)?.message) }));
      }
    }
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}`;
  process.env.MCP_LOOPBACK_URL = baseUrl;
  return {
    baseUrl,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

/**
 * A global `fetch` for integration tests: requests to the harness (the SDK
 * client) pass through; anything else (the routes' fire-and-forget backend
 * calls such as /api/feedback) is recorded and answered with `{}`.
 */
export function makeFetchStub(realFetch: typeof fetch, baseUrl: () => string) {
  const backendCalls: Array<{ url: string; body: any }> = [];
  const stub = async (input: any, init?: any) => {
    const url = typeof input === 'string' ? input : input?.url ?? String(input);
    if (url.startsWith(baseUrl())) return realFetch(input, init);
    let body: any = init?.body;
    try { body = body ? JSON.parse(body) : undefined; } catch { /* keep raw */ }
    backendCalls.push({ url, body });
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { stub, backendCalls };
}

/** Connect an SDK MCP client to the harness with an integration key. */
export async function connectMcp(baseUrl: string, token: string) {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
  const client = new Client({ name: 'bliss-test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/api/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  }));
  return client;
}

/** Call a tool; protocol errors (e.g. input validation) come back as `isError` too. */
export async function callTool(client: any, name: string, args: Record<string, unknown> = {}) {
  try {
    const result: any = await client.callTool({ name, arguments: args });
    const text: string = result.content?.[0]?.text ?? '';
    return { isError: Boolean(result.isError), text, data: result.isError ? null : result.structuredContent };
  } catch (err) {
    return { isError: true, text: (err as Error).message, data: null };
  }
}

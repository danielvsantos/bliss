#!/usr/bin/env node
/**
 * Manage the invite-only sign-up allowlist (#99) over HTTP.
 *
 * Talks to /api/admin/invites with the operator key, so it works against a
 * remote deployment (e.g. Vercel) without database credentials. A direct SQL
 * insert would NOT work: SignupInvite.email is encrypted.
 *
 * Usage:
 *   ADMIN_API_KEY=… node scripts/manage-invites.mjs add <email> [--note "…"]
 *   ADMIN_API_KEY=… node scripts/manage-invites.mjs list [--unused|--used]
 *   ADMIN_API_KEY=… node scripts/manage-invites.mjs revoke <email>
 *
 * API base URL: --url <url>, else BLISS_API_URL, else NEXTAUTH_URL, else
 * http://localhost:3000.
 *
 * Exits 1 when ADMIN_API_KEY is missing (before any network call), on a usage
 * error, or on any non-2xx response.
 */

const USAGE = `Usage:
  manage-invites.mjs add <email> [--note "text"]
  manage-invites.mjs list [--unused|--used]
  manage-invites.mjs revoke <email>

Options:
  --url <url>   API base URL (default: BLISS_API_URL, NEXTAUTH_URL, http://localhost:3000)

Environment:
  ADMIN_API_KEY   required; the same value the API server is configured with`;

export class UsageError extends Error {}

/**
 * @param {string[]} argv arguments after the script name
 * @returns {{ command: string, email?: string, note?: string, status?: 'unused'|'used', url?: string }}
 */
export function parseArgs(argv) {
  const positional = [];
  const opts = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--note' || arg === '--url') {
      const value = argv[i + 1];
      if (value === undefined) throw new UsageError(`${arg} needs a value`);
      opts[arg.slice(2)] = value;
      i += 1;
    } else if (arg === '--unused' || arg === '--used') {
      if (opts.status) throw new UsageError('Use only one of --unused / --used');
      opts.status = arg.slice(2);
    } else if (arg.startsWith('--')) {
      throw new UsageError(`Unknown option: ${arg}`);
    } else {
      positional.push(arg);
    }
  }

  const [command, email, ...rest] = positional;
  if (!command) throw new UsageError('Missing command');
  if (rest.length > 0) throw new UsageError(`Unexpected argument: ${rest[0]}`);

  switch (command) {
    case 'add':
      if (!email) throw new UsageError('add needs an email');
      if (opts.status) throw new UsageError('--unused/--used only apply to list');
      return { command, email, note: opts.note, url: opts.url };
    case 'list':
      if (email) throw new UsageError('list takes no email');
      if (opts.note !== undefined) throw new UsageError('--note only applies to add');
      return { command, status: opts.status, url: opts.url };
    case 'revoke':
      if (!email) throw new UsageError('revoke needs an email');
      if (opts.status || opts.note !== undefined) throw new UsageError('revoke takes only an email');
      return { command, email, url: opts.url };
    default:
      throw new UsageError(`Unknown command: ${command}`);
  }
}

export function resolveBaseUrl(args, env) {
  const base = args.url || env.BLISS_API_URL || env.NEXTAUTH_URL || 'http://localhost:3000';
  return base.replace(/\/+$/, '');
}

/** @returns {{ method: string, url: string, headers: Record<string,string>, body?: string }} */
export function buildRequest(args, { baseUrl, adminKey }) {
  const endpoint = `${baseUrl}/api/admin/invites`;
  const headers = { 'x-admin-key': adminKey, accept: 'application/json' };
  switch (args.command) {
    case 'add': {
      const payload = { email: args.email };
      if (args.note !== undefined) payload.note = args.note;
      return {
        method: 'POST',
        url: endpoint,
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      };
    }
    case 'list':
      return {
        method: 'GET',
        url: args.status ? `${endpoint}?status=${args.status}` : endpoint,
        headers,
      };
    case 'revoke':
      // Email in the body, not the query string: URLs end up in access logs.
      return {
        method: 'DELETE',
        url: endpoint,
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ email: args.email }),
      };
    default:
      throw new UsageError(`Unknown command: ${args.command}`);
  }
}

function fmtDate(value) {
  return value ? new Date(value).toISOString().slice(0, 16).replace('T', ' ') : '-';
}

export function formatInvites(invites) {
  if (!invites.length) return 'No invites.';
  const rows = invites.map((i) => [
    i.email,
    i.usedAt ? 'used' : 'unused',
    fmtDate(i.createdAt),
    fmtDate(i.usedAt),
    i.usedByTenantId ?? '-',
    i.note ?? '',
  ]);
  const header = ['EMAIL', 'STATUS', 'CREATED', 'USED', 'TENANT', 'NOTE'];
  const widths = header.map((h, c) => Math.max(h.length, ...rows.map((r) => String(r[c]).length)));
  const line = (r) => r.map((v, c) => String(v).padEnd(widths[c])).join('  ').trimEnd();
  return [line(header), ...rows.map(line), '', `${invites.length} invite(s)`].join('\n');
}

async function readJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

/**
 * @param {string[]} argv
 * @param {{ env?: Record<string,string|undefined>, fetchImpl?: typeof fetch,
 *           out?: (s: string) => void, err?: (s: string) => void }} [deps]
 * @returns {Promise<number>} process exit code
 */
export async function run(argv, { env = process.env, fetchImpl = globalThis.fetch, out = console.log, err = console.error } = {}) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    if (error instanceof UsageError) {
      err(`Error: ${error.message}\n\n${USAGE}`);
      return 1;
    }
    throw error;
  }

  const adminKey = env.ADMIN_API_KEY;
  if (!adminKey) {
    err('Error: ADMIN_API_KEY is not set. Export the same value the API server uses.');
    return 1;
  }

  const baseUrl = resolveBaseUrl(args, env);
  const { method, url, headers, body } = buildRequest(args, { baseUrl, adminKey });

  let response;
  try {
    response = await fetchImpl(url, { method, headers, body });
  } catch (error) {
    err(`Error: could not reach ${baseUrl} (${error?.message ?? error})`);
    return 1;
  }

  if (response.status === 401) {
    err('Error: 401 Unauthorized — ADMIN_API_KEY rejected, or not configured on the server.');
    return 1;
  }

  const data = response.status === 204 ? null : await readJson(response);
  if (!response.ok) {
    const detail = [data?.error, data?.code && `(${data.code})`].filter(Boolean).join(' ');
    err(`Error: ${response.status}${detail ? ` ${detail}` : ''}`);
    return 1;
  }

  switch (args.command) {
    case 'add':
      out(`Invited ${data?.invite?.email ?? args.email}.`);
      break;
    case 'list':
      out(formatInvites(data?.invites ?? []));
      break;
    case 'revoke':
      out(`Revoked the invite for ${args.email.trim().toLowerCase()}.`);
      break;
    default:
      break;
  }
  return 0;
}

if (process.argv[1] && process.argv[1].endsWith('manage-invites.mjs')) {
  run(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      console.error(`Error: ${error?.message ?? error}`);
      process.exit(1);
    },
  );
}

# Connecting AI Agents & Other Systems

Bliss can give an AI agent (Claude, Claude Code, or another assistant), a
script, or another system its own credential for the REST API: an
**integration token**. Unlike handing over your password or a browser session,
a token:

- belongs to your tenant and works only on your tenant's data,
- is limited to **Read-only** or **Read & write**, and can never act as an admin,
- can be revoked on its own, immediately, without signing anyone out,
- is attributable: every request it makes is logged with the integration's ID.

You need to be a tenant **admin** to create integrations. No environment
variables or redeploys are involved; it works the same on Docker Compose and on
a split Vercel (API) + Railway (backend) deployment.

---

## Create an integration

1. Sign in as a tenant admin and go to **Settings → Integrations** (key icon).
   If you don't see the tab, your account isn't an admin.
2. Click **New integration** and give it a name you'll recognise later, such as
   "Claude agent" or "n8n nightly sync".
3. Pick an **access level** (see below). You can't change it later: to change
   it, create a new integration, so the change is visible.
4. Pick how long the first key lasts: 30 days, 90 days, 1 year, or no expiry.
   A key without an expiry works until you revoke it.
5. Click **Create integration**. The token is shown **once**. Copy it into a
   password manager or your agent's secret store before you click **Done**.
   Bliss stores only a hash of it, so nobody can show it to you again. If you
   lose it, add a new key and revoke the old one.

Tokens look like `bliss_AbCdEfGh_…`. The first 8 characters after `bliss_` are
a public prefix, which is what the Integrations tab shows for each key.

---

## Access levels

A token acts **on behalf of the admin who created it**, with its role capped by
the access level.

| | Read-only | Read & write |
|---|---|---|
| Read transactions, portfolio, analytics, insights, tags, subscriptions, passive income | ✅ | ✅ |
| Create / edit / delete transactions and tags | ❌ | ✅ |
| Work the Plaid review queue (promote, skip, re-queue, retry) | ❌ | ✅ |
| Smart imports (upload, review, commit) | ❌ | ✅ |
| Income terms, debt terms, manual asset values | ❌ | ✅ |
| Trigger insights or a subscriptions scan | ❌ | ✅ |
| Read accounts, categories and tenant settings | ✅ | ✅ |
| Create banks and manual accounts (`POST /api/banks`, `POST /api/accounts`) | ❌ | ✅ |
| Edit / delete accounts, or create / edit / delete categories | ❌ | ❌ |
| Change tenant settings, manage users or roles | ❌ | ❌ |
| Connect, disconnect, re-sync or rotate Plaid bank connections | ❌ | ❌ |
| Maintenance rebuilds, fundamentals refresh (admin actions) | ❌ | ❌ |
| Sign in, read the session, change a password | ❌ | ❌ |
| Create or revoke integrations and tokens | ❌ | ❌ |

What the API returns when a token hits a limit:

| Status | `code` | Meaning |
|---|---|---|
| `401` | `TOKEN_INVALID` | Unknown or malformed token, or the admin who created it was deleted |
| `401` | `TOKEN_EXPIRED` | The key's expiry date has passed |
| `401` | `TOKEN_REVOKED` | The key, or its whole integration, was revoked |
| `403` | `READ_ONLY_INTEGRATION` | A read-only token tried to change something |
| `403` | `NOT_AVAILABLE_TO_INTEGRATIONS` | The endpoint never accepts tokens |
| `403` | — | Admin-only endpoint (tokens are never admin) |

If the admin who created an integration is later demoted to **viewer**, their
Read & write integrations drop to read-only. If that admin's user is deleted,
their integrations are deleted too, and the tokens stop working on the next
request.

---

## Use the token

Send it as a Bearer token in the `Authorization` header. `API_URL` is your API
service's URL (the same value as `NEXT_PUBLIC_API_URL`), not the web app's.

### curl

```bash
export BLISS_API_URL=https://api.example.com
export BLISS_TOKEN=bliss_AbCdEfGh_...

curl -H "Authorization: Bearer $BLISS_TOKEN" \
  "$BLISS_API_URL/api/transactions?limit=20"

curl -H "Authorization: Bearer $BLISS_TOKEN" \
  "$BLISS_API_URL/api/portfolio/holdings"
```

### Claude Code, Claude Desktop or another MCP client

**Use the MCP server.** Bliss exposes 40 agent-ready tools at
`$BLISS_API_URL/api/mcp`, authenticated with this same token — the agent
doesn't need to learn the REST API. See
[Use Bliss with Claude (MCP)](/docs/guides/using-bliss-with-claude-mcp):

```bash
claude mcp add --transport http bliss "$BLISS_API_URL/api/mcp" \
  --header "Authorization: Bearer $BLISS_TOKEN"
```

**Claude Cowork and claude.ai custom connectors** can't send a header. Add
the connector with just the URL `$BLISS_API_URL/api/mcp` and leave the OAuth
fields empty: Claude opens Bliss, you sign in as an admin and click **Allow**,
and Bliss creates the integration for you (it appears here as
**Connected via OAuth**). See
[Connect with a custom connector (OAuth)](/docs/guides/using-bliss-with-claude-mcp#connect-with-a-custom-connector-oauth).

### An agent calling the REST API directly

Keep the token out of prompts and chat history. Put it in an environment
variable and tell the agent to use it:

```bash
export BLISS_API_URL=https://api.example.com
export BLISS_TOKEN=bliss_AbCdEfGh_...
claude
```

Then ask, for example: *"Using `curl` with `Authorization: Bearer $BLISS_TOKEN`
against `$BLISS_API_URL`, list my Plaid review queue
(`GET /api/plaid/transactions?promotionStatus=CLASSIFIED`) and promote the
items whose category you're confident about."* That needs a **Read & write**
integration. The API reference (**API Reference** in these docs) describes
every endpoint.

For an agent that should only look, use a **Read-only** integration: any write
it attempts is refused with `403 READ_ONLY_INTEGRATION`, whatever it's told to
do.

### Node.js script

```js
const API = process.env.BLISS_API_URL;
const headers = { Authorization: `Bearer ${process.env.BLISS_TOKEN}` };

const res = await fetch(`${API}/api/transactions?year=2026&month=9`, { headers });
if (!res.ok) {
  const { error, code } = await res.json();
  throw new Error(`${res.status} ${code ?? ''} ${error}`);
}
const { transactions, total } = await res.json();
console.log(`${total} transactions this month`);
```

---

## Rotate a key without downtime

An integration can have several active keys.

1. In **Settings → Integrations**, open the integration and click **Add key**.
2. Put the new token into the system that uses it.
3. Once the system is using the new key (the **Last used** time of the new key
   updates), click **Revoke** on the old key.

Revoking one key never affects the integration's other keys.

## Revoke access

- **Revoke** on a key stops that key on its next request.
- The trash icon on an integration revokes the integration and all of its keys.

Neither affects human sessions or other integrations. Revoked integrations stay
in the list, marked **Revoked**, for reference.

---

## Security notes

- **A token sees your decrypted financial data**, exactly like your own
  session does. Treat it like a bank password: keep it in a secret store, never
  commit it, never paste it into a shared chat.
- Bliss stores only a SHA-256 hash of each token. The plaintext is shown once
  and never logged. Sentry events have tokens redacted.
- Every token request writes one log line on the API service:
  `{"event":"integration_request","tenantId":…,"integrationId":…,"apiKeyId":…,"method":…,"route":…,"status":…}`.
  Use it to tell agent activity from human activity: in the database, a token's
  writes are attributed to the admin who created the integration.
- Token requests go through the same per-IP rate limits as browser requests.
- Prefer an expiry, and Read-only unless the agent really needs to write.
- Tokens only work against the API service. The backend service stays internal
  behind `INTERNAL_API_KEY`.

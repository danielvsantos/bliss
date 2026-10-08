# Use Bliss with Claude (MCP)

Bliss includes an **MCP server**, so Claude (Cowork, claude.ai, Claude Desktop,
Claude Code) and other
[Model Context Protocol](https://modelcontextprotocol.io) clients can work with
your finances in plain language. You don't need to teach the agent the REST API:
it gets **41 tools** — set up your banks and accounts, search and re-categorise
transactions, work the bank-sync review queue, review an imported statement,
answer spending and portfolio questions, clean up subscriptions — and a short
briefing on how Bliss works.

It takes about five minutes. There are two ways to connect:

- **Claude Cowork / claude.ai / Claude Desktop connectors** — add a custom
  connector with just the URL and sign in to Bliss when asked (OAuth). No key to
  copy. See [Connect with a custom connector](#connect-with-a-custom-connector-oauth).
- **Claude Code and other clients that send headers** — create an integration
  key in Bliss and pass it as an `Authorization` header (steps 1–2 below).

Then ask (step 3).

The server lives on your own Bliss API at `https://<your-api>/api/mcp`. Nothing
new to deploy, no environment variables to set.

---

## Connect with a custom connector (OAuth)

Claude Cowork, claude.ai and Claude Desktop add remote MCP servers as
**custom connectors**. They can't send a static API key, so Bliss signs them in
with OAuth instead:

1. In Claude, open **Connectors → Add custom connector** (the exact menu name
   varies by app).
2. Enter a name (e.g. *Bliss*) and the URL `https://API_URL/api/mcp`. Leave the
   OAuth client ID and secret **empty** — Claude registers itself.
3. Click **Connect**. A Bliss page opens: sign in if needed. You need to be a
   workspace **admin**.
4. On **Connect Claude to Bliss**, check where you'll be sent back to
   (`claude.ai`), pick **Read-only** or **Read & write**, and how long the
   connection lasts (30 days, **90 days** by default, 1 year, or never). Click
   **Allow**.
5. Claude shows the Bliss tools. Read-only connections get the 22 read tools;
   Read & write all 40.

The connection appears in **Settings → Integrations** as *Connected via OAuth ·
Claude*. Claude renews its access every hour in the background; revoke the
integration there to disconnect it immediately (removing the connector in Claude
also revokes it, if Claude tells Bliss). When the connection expires, click
**Connect** again in Claude.

> The API must be reachable over **https** from the internet for claude.ai /
> Cowork (their servers call it). A laptop-only Docker instance works with
> Claude Code and Claude Desktop, but not with web connectors.

**Gemini** custom connectors use the same flow: enter `https://API_URL/api/mcp`
and leave the client ID and secret empty. The connection appears as
*Connected via OAuth · Gemini*, and the consent page shows
Google's relay (`oauth-redirect.googleusercontent.com`, or
`oauth-redirect-sandbox.googleusercontent.com`) as where you'll be sent back to.

Operators can restrict which apps may connect with `OAUTH_ALLOWED_REDIRECT_HOSTS`
(default `claude.ai,claude.com,oauth-redirect.googleusercontent.com,oauth-redirect-sandbox.googleusercontent.com,localhost,127.0.0.1`) — see
[Configuration](/docs/configuration).

---

## 1. Create an integration key

Follow [Connecting AI Agents & Other Systems](/docs/guides/connecting-ai-agents#create-an-integration):
**Settings → Integrations → New integration** (tenant admins only).

- **Read-only** — the agent sees the **22 read tools** only. It can answer
  questions but cannot change anything, whatever it's told.
- **Read & write** — all **41 tools**, including creating banks and manual
  accounts, re-categorising, approving review items, committing imports and
  editing portfolio data.

When the key is shown, the dialog also shows the **MCP server URL** and a
ready-made **Claude Code command** with the key filled in. Copy it before you
click **Done**: the key is never shown again.

---

## 2. Connect your client

`API_URL` below is your **API service** URL (the same value as
`NEXT_PUBLIC_API_URL`), not the web app's.

### Claude Code

```bash
claude mcp add --transport http bliss https://API_URL/api/mcp \
  --header "Authorization: Bearer bliss_AbCdEfGh_..."
```

Run `claude mcp list` to check it's connected, or `/mcp` inside Claude Code.
Add `--scope user` to use Bliss from every project.

### Claude Desktop

Claude Desktop reaches remote servers that need a header through the
[`mcp-remote`](https://www.npmjs.com/package/mcp-remote) bridge (needs Node.js).
Edit `claude_desktop_config.json` (**Settings → Developer → Edit Config**):

```json
{
  "mcpServers": {
    "bliss": {
      "command": "npx",
      "args": [
        "-y", "mcp-remote",
        "https://API_URL/api/mcp",
        "--header", "Authorization:${BLISS_AUTH}"
      ],
      "env": { "BLISS_AUTH": "Bearer bliss_AbCdEfGh_..." }
    }
  }
}
```

Restart Claude Desktop. (The key goes in `env` because some platforms mangle
spaces inside `args`.)

### Other MCP clients

Any client that supports the **Streamable HTTP** transport works: point it at
`https://API_URL/api/mcp` and send the header
`Authorization: Bearer bliss_…`. The server is stateless (no session IDs), so it
works behind any load balancer and across API replicas.

### Where Bliss runs

| Setup | MCP URL |
|---|---|
| Docker Compose on your machine | `http://localhost:3000/api/mcp` |
| Railway | `https://<your-api-service>.up.railway.app/api/mcp` (the API service's **public** domain) |
| Any other host | `https://<your API domain>/api/mcp` |

The key lives **only in your MCP client's configuration**. Never put it in
Bliss's own environment variables (Railway service variables, `.env`): Bliss
doesn't need it, and it would be readable by anyone with access to the service.

---

## 3. Ask

Some prompts to start with. No endpoint names, IDs or formats needed — the
agent finds them with the tools.

**Setting up** (Read & write)
- *"I bank with Revolut (EUR and GBP accounts) and Schwab (USD) — set them up."*
- *"Add my ING savings account in EUR; the IBAN ends in 4821."*

The agent creates the banks and **manual** accounts (bank-synced accounts are
connected in the app). Account numbers are stored encrypted and never shown
back — only the last 4 characters — so a short label is fine too. New accounts
are owned by the admin who connected Bliss; add other owners in the app. An
account's currency and country must already be enabled in **Settings**; the
agent tells you when one isn't. Asking twice never creates a duplicate.

**Spending** (any key)
- *"What did I spend on groceries last month vs the month before?"*
- *"Break down my Lifestyle spending by group for this year, month by month."*
- *"How much did my Japan trip cost?"* (a tag)

**Transactions** (Read & write)
- *"Find my transactions filed under Uncategorized in September and re-categorise them."*
- *"Tag everything from 3–17 May in Portugal as 'Portugal 2026'."*

**Bank-sync review queue** (Read & write)
- *"Approve everything in my review queue above 90% confidence."*
- *"Go through the rest of the queue and suggest a category for each; wait for my OK."*

**Imported statements** (Read & write) — upload the file in the Bliss app first
(**Import**), then:
- *"Review my pending import, fix anything that looks miscategorised, and commit it."*

**Portfolio & passive income** (any key; updates need Read & write)
- *"What's my portfolio worth, and how did it change over the last 12 months?"*
- *"Which holdings need attention?"*
- *"Set the value of my flat to €420,000 as of today."*
- *"How much dividend income should I expect next year?"*

**Subscriptions**
- *"List my active subscriptions and what they cost per year."*
- *"Netflix shows up twice — merge them."* (Read & write)

**Insights**
- *"Summarise this quarter's insights."*

Writes behave exactly like the app: re-categorising teaches Bliss's classifier,
and analytics and portfolio values refresh in the background. Instead of
guessing how long that takes, Claude calls **`get_processing_status`** after a
write and waits until nothing in flight affects what it changed (each in-flight
entry lists the data it `affects`) before re-asking for totals. The same status
is what you see in the header chip of the app — see
[Why are my numbers updating?](/docs/guides/processing-status).

---

## What MCP can't do

On purpose, some things stay in the Bliss app:

- **Uploading files.** Upload statements in the app; the agent can then review
  and commit the staged import.
- **Bank connections.** Linking, re-authenticating, syncing or disconnecting
  Plaid, and connection status, are managed in the app. The agent works the
  *review queue* of synced transactions.
- **Editing accounts and banks.** The agent can *create* banks and manual
  accounts, but renaming, re-owning or deleting them happens in the app.
- **Categories, users, tenant settings (currencies, countries), integrations and
  maintenance.** Integration keys can't change these at all (see
  [access levels](/docs/guides/connecting-ai-agents#access-levels)).
- **Searching transaction descriptions.** Descriptions are encrypted at rest,
  so the agent filters by date, account, category or tag, and looks merchants
  up in bank-sync history.

The [MCP Tool Reference](/docs/guides/mcp-tool-reference) lists every tool, its
parameters and the REST endpoints it calls.

---

## Privacy and safety

- **The agent sees your decrypted financial data** — whatever the key can read.
  With a hosted model, that data goes to the model provider as part of the
  conversation. Use a Read-only key for question-answering, and a Read & write
  key only when you want the agent to make changes.
- Every tool call runs through the same checks as the REST API: the key's
  access level, the integration denylist, your tenant's data only, and the
  per-IP rate limits.
- Each call is logged on the API service (IDs only, never data):
  `{"event":"mcp_tool_call","tool":…,"integrationId":…,"ok":…}`, and every REST
  request it makes carries `"mcpTool"` in its `integration_request` line.
- Revoke the key in **Settings → Integrations** to cut the agent off
  immediately.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `401` when connecting | Missing, mistyped, expired or revoked key — or a browser session / user token instead of an integration key | Check the `Authorization: Bearer bliss_…` header; create a new key if needed |
| Only 22 tools, writes missing | The key is **Read-only** | Create a **Read & write** integration |
| "This Bliss connection is read-only" | A read-only key or connection called a write tool by name | Same as above |
| "Not available to integrations" | The action is app-only (see above) | Do it in the Bliss app |
| "Not found: …" | The ID belongs to nothing in your tenant | Let the agent list first (accounts, categories, holdings…) |
| "Rate limited by Bliss. Retry after N seconds" | Too many requests from your IP | Wait; ask for fewer, larger pages |
| `405` | The client used GET/DELETE (SSE sessions) | Use the Streamable HTTP transport; Bliss answers POST only |
| Connection refused / timeout | Wrong URL (web app instead of API), or the API is down | Use the API service URL; check `https://API_URL/api/countries` answers |
| Connector: "can't connect to Bliss" page | The app's redirect address isn't allowed on this server, or the connector was registered against another Bliss URL | Remove the connector and add it again; operators check `OAUTH_ALLOWED_REDIRECT_HOSTS` |
| Connector: "Only a workspace admin can connect apps" | You signed in as a member or viewer | Ask an admin to connect it |
| Connector: "This connection request has expired" | More than 10 minutes passed on the consent page | Click **Connect** again in Claude |
| Connector stops working after a while | The connection expired or was revoked in Settings → Integrations | Click **Connect** again in Claude |

**Behind a proxy that rewrites paths, or on Vercel:** tools call Bliss's own
REST API through `http://127.0.0.1:$PORT`. If that address doesn't reach the
API from inside its own container, set `MCP_LOOPBACK_URL` on the API service to
its public URL (see [Configuration](/docs/configuration)).

To check a deployment from the command line:

```bash
BLISS_URL=https://API_URL BLISS_API_KEY=bliss_... pnpm --filter @bliss/api mcp:smoke
```

or open the [MCP Inspector](https://github.com/modelcontextprotocol/inspector)
(`npx @modelcontextprotocol/inspector`), choose **Streamable HTTP**, enter the
URL and add the `Authorization` header.

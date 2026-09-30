# Use Bliss with Claude (MCP)

Bliss includes an **MCP server**, so Claude Code, Claude Desktop and other
[Model Context Protocol](https://modelcontextprotocol.io) clients can work with
your finances in plain language. You don't need to teach the agent the REST API:
it gets **39 tools** — search and re-categorise transactions, work the bank-sync
review queue, review an imported statement, answer spending and portfolio
questions, clean up subscriptions — and a short briefing on how Bliss works.

It takes about five minutes:

1. Create an **integration key** in Bliss.
2. Add the Bliss MCP server to your client with that key.
3. Ask.

The server lives on your own Bliss API at `https://<your-api>/api/mcp`. Nothing
new to deploy, no environment variables to set.

---

## 1. Create an integration key

Follow [Connecting AI Agents & Other Systems](/docs/guides/connecting-ai-agents#create-an-integration):
**Settings → Integrations → New integration** (tenant admins only).

- **Read-only** — the agent sees the **22 read tools** only. It can answer
  questions but cannot change anything, whatever it's told.
- **Read & write** — all **39 tools**, including re-categorising, approving
  review items, committing imports and editing portfolio data.

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
and analytics and portfolio values refresh in the background (allow a minute
before re-asking for totals).

---

## What MCP can't do

On purpose, some things stay in the Bliss app:

- **Uploading files.** Upload statements in the app; the agent can then review
  and commit the staged import.
- **Bank connections.** Linking, re-authenticating, syncing or disconnecting
  Plaid, and connection status, are managed in the app. The agent works the
  *review queue* of synced transactions.
- **Accounts, categories, users, tenant settings, integrations and maintenance.**
  Integration keys can't change these at all (see
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
| "This key is read-only" | A read-only key called a write tool by name | Same as above |
| "Not available to integrations" | The action is app-only (see above) | Do it in the Bliss app |
| "Not found: …" | The ID belongs to nothing in your tenant | Let the agent list first (accounts, categories, holdings…) |
| "Rate limited by Bliss. Retry after N seconds" | Too many requests from your IP | Wait; ask for fewer, larger pages |
| `405` | The client used GET/DELETE (SSE sessions) | Use the Streamable HTTP transport; Bliss answers POST only |
| Connection refused / timeout | Wrong URL (web app instead of API), or the API is down | Use the API service URL; check `https://API_URL/api/countries` answers |

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

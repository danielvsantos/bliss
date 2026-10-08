# 25. OAuth 2.1 for the MCP Server (API)

## 25.1. Overview

Claude Cowork, claude.ai and Claude Desktop add remote MCP servers as **custom
connectors**, which authenticate with OAuth only: they cannot send a static
`Authorization: Bearer bliss_…` header. Bliss therefore runs a small OAuth 2.1
authorization server inside `apps/api` for its MCP endpoint (#89,
[24-mcp-server.md](./24-mcp-server.md)).

**An OAuth access token is a #84 integration key.** Approving a connection
creates an `Integration` (READ_ONLY or READ_WRITE), and its single `ApiKey` is
handed to the client as the access token. `withAuth`, the role cap, the
integration denylist, tenant scoping, rate limits, attribution logs and every
MCP tool therefore work unchanged. The connection is listed, and can be revoked,
in **Settings → Integrations**.

Header keys keep working for Claude Code and other clients that can send them.

User guide: [`docs/guides/using-bliss-with-claude-mcp.md`](../../guides/using-bliss-with-claude-mcp.md#connect-with-a-custom-connector-oauth).

## 25.2. Standards

| Spec | Implemented as |
|---|---|
| OAuth 2.1 (authorization code + PKCE) | The only grants are `authorization_code` and `refresh_token`. Public clients only (`token_endpoint_auth_method: none`). A client asking for `client_secret_basic` or `client_secret_post` (Gemini does) is registered as `none` instead (RFC 7591 §3.2.1) and gets no secret. |
| RFC 7636 PKCE | Required, **S256 only** |
| RFC 9728 Protected Resource Metadata | Served for `/api/mcp`. Every 401 from `/api/mcp` carries `WWW-Authenticate: Bearer resource_metadata="…"`. |
| RFC 8414 Authorization Server Metadata | Discovery document |
| RFC 7591 Dynamic Client Registration | Open registration, limited by a redirect-host allowlist |
| RFC 8707 Resource Indicators | `resource`, when sent, must equal `<issuer>/api/mcp` (otherwise `invalid_target`) |
| RFC 9207 | `iss` is added to authorization responses |
| RFC 7009 Token Revocation | Revoking either token ends the whole connection |

## 25.3. Endpoints

The well-known paths are served by `next.config.mjs` rewrites (`lib/oauthRewrites.js`), at both the root and the path-insertion location.

| Path | Method | Auth | Purpose |
|---|---|---|---|
| `/.well-known/oauth-protected-resource` and `…/api/mcp` → `/api/oauth/protected-resource` | GET | public, CORS `*` | Returns `{ resource, authorization_servers: [issuer], scopes_supported, bearer_methods_supported: ["header"] }` |
| `/.well-known/oauth-authorization-server` and `…/api/mcp` → `/api/oauth/metadata` | GET | public, CORS `*` | The RFC 8414 document |
| `/api/oauth/register` | POST (JSON) | public | Dynamic client registration. Validates `redirect_uris` (§25.5) and returns `client_id`. Without a `client_name`, the client is named `Gemini` when every redirect URI is Gemini's, else `MCP client`; the name becomes the Integration's name. |
| `/api/oauth/authorize` | GET | public (browser) | Validates the request, stores it, and 302s to `FRONTEND_URL/oauth/consent?request=<id>`. An unknown `client_id` or `redirect_uri` gets an HTML error page and is never redirected. Other errors redirect to `redirect_uri?error=…&state=…&iss=…`. |
| `/api/oauth/requests/[id]` | GET | withAuth (JWT) | Consent data: `{ request: { clientName, redirectHost, maxAccessLevel, expiresAt }, canApprove, expiryOptions }`. The first user to open a request is bound to it. |
| `/api/oauth/requests/[id]/approve` | POST (JSON) | withAuth `requireRole: 'admin'` | Body `{ accessLevel, expiresInDays: 30\|90\|365\|null }`. Creates the Integration and a one-time code, and returns `{ redirectUrl }`. |
| `/api/oauth/requests/[id]/deny` | POST | withAuth (JWT) | Returns `{ redirectUrl }` with `error=access_denied` |
| `/api/oauth/token` | POST (form or JSON) | public client | The two grants (§25.4). `client_id` may come in the body or, for clients used to `client_secret_basic`, an HTTP Basic header (the body wins; any secret is ignored); the same holds for `/revoke`. Responses carry `Cache-Control: no-store`. |
| `/api/oauth/revoke` | POST (form or JSON) | public client | RFC 7009: `token` is either a refresh token or an access token. Unknown tokens get `200`. |

- **Issuer.** `OAUTH_ISSUER_URL`, otherwise the origin of `NEXTAUTH_URL` (the API's public URL).
- **Integration keys.** `/api/oauth` is on `INTEGRATION_DENYLIST` (all methods), so a key can never mint another token. Every route is classified `D/D` in the route matrix, and none is counted as an MCP-reachable operation.
- **Rate limits.** `oauth` allows 60 requests per 5 minutes per IP; `oauthRegister` allows 10 per hour per IP.

## 25.4. Tokens and lifecycle

| Artifact | Format | Storage | Lifetime |
|---|---|---|---|
| Authorization request | 32 random bytes, base64url | `OAuthAuthorizationRequest.id` | 10 min, single use |
| Authorization code | 32 random bytes, base64url | SHA-256 in `codeHash` | 60 s, single use |
| Access token | `bliss_<prefix>_<secret>` integration key | The connection's single `ApiKey` row ("OAuth access token"), **re-keyed in place** on every refresh | 1 h, capped by the connection expiry |
| Refresh token | `bliss_rt_<48 base62>` | SHA-256 in `OAuthRefreshToken.tokenHash` | 30 days, capped by the connection expiry |

- **Code exchange.** The server checks the client, the exact `redirect_uri`, the PKCE verifier, the `resource`, that the code hasn't expired, and that the Integration is neither revoked nor expired. Failed checks don't consume the code. Redeeming a code a second time revokes everything issued from it.
- **Refresh.**
  - Rotation: every use marks the old refresh token used and issues a new pair. The previous access token stops working at once, because its row is re-keyed.
  - Reuse detection: a used refresh token presented again revokes the connection, meaning the Integration, its key and all its refresh tokens.
  - Refresh also fails if the Integration was revoked in Settings or has passed its `connectionExpiresAt`.
- **Scopes.** `mcp:read` maps to `READ_ONLY` and `mcp:write` to `READ_WRITE`.
  - An explicit `mcp:read` request caps the consent at Read-only. `mcp:write`, or no scope at all, allows up to Read & write.
  - The consent screen always defaults to Read-only; the admin can only downgrade.
  - The token response's `scope` reflects what was granted.
- **Housekeeping.** Authorization requests that expired more than a day ago are deleted during `/authorize`. A connection's refresh tokens that were used more than 30 days ago are deleted during refresh.
- **Logs.** One `oauth_event` line per step: `register`, `register_rejected` (with the `error` and `reason`, so a client that can't connect can be diagnosed), `authorize`, `consent_approved`, `consent_denied`, `token_issued`, `token_refreshed`, `refresh_reuse_detected`, `revoked`. These lines contain IDs only. `redactIntegrationTokens` and the Sentry scrubber also cover `bliss_rt_…`, `refresh_token`, `code_verifier` and `client_secret`.

## 25.5. Redirect-URI policy

Registration accepts a redirect URI only if all of these hold:
- it uses `https`, or `http` on a loopback host (`localhost`, `127.0.0.1`, `[::1]`) for native clients
- it has no fragment and no credentials
- its host is in **`OAUTH_ALLOWED_REDIRECT_HOSTS`**

`oauth-redirect.googleusercontent.com` is the host of Gemini's custom MCP connector callback (`/r/user_bound_custom-mcp-…`).

`OAUTH_ALLOWED_REDIRECT_HOSTS` is comma-separated. The default is `claude.ai,claude.com,oauth-redirect.googleusercontent.com,localhost,127.0.0.1`. Loopback hosts are allowed as a group when `localhost` or `127.0.0.1` is listed.

At `/authorize`, the `redirect_uri` must **exactly** match one of the client's registered URIs. The consent screen shows the redirect **host**.

## 25.6. Data model

The migration is hand-written (`20261002120000_add_oauth`) and is applied with `migrate deploy`.

- `OAuthClient { id (= client_id), name, redirectUris[], createdAt, lastUsedAt }`
- `OAuthAuthorizationRequest`: request plus code. The fields are:
  - `clientId`, `redirectUri`, `state`, `codeChallenge`
  - `requestedAccess`, `resource`
  - `userId` and `tenantId` (bound on first view), `integrationId`
  - `codeHash`, `codeExpiresAt`, `usedAt`, `expiresAt`
- `OAuthRefreshToken { tenantId, integrationId, tokenHash, expiresAt, usedAt, revokedAt }`
- `Integration` gains:
  - `oauthClientId` (set null when the client is deleted)
  - `connectionExpiresAt`

`GET /api/integrations` returns `oauth: { clientName, connectionExpiresAt }` for OAuth connections. `POST /api/integrations/:id/keys` answers `409 OAUTH_MANAGED` for them.

## 25.7. Web

- **`/oauth/consent`** (`pages/oauth/consent.tsx`) is a standalone card outside the app shell, wrapped in `withAuth`. It shows:
  - the client name and the redirect host
  - the signed-in email
  - the Read-only or Read & write choice (write is disabled when the client asked for read only)
  - the connection expiry: 30 d, 90 d (default), 1 y or never, with a warning for never
  - **Allow** and **Deny** buttons

  Non-admins see "Only a workspace admin can connect apps", with Deny only. After a decision the page calls `window.location.assign(redirectUrl)`.
- **Return to the page after sign-in.** The web `withAuth` sends signed-out users to `/auth?returnTo=<path>`. Sign-in navigates back, and Google sign-in carries the value through `sessionStorage`. `lib/return-to.ts` only accepts same-origin relative paths, so this can't become an open redirect.
- **Settings → Integrations** shows **Connected via OAuth · <client>** and the connection expiry. It hides **Add key** and the key list for these connections; Revoke is unchanged.
- The strings live under `pages.oauth.consent.*` and `pages.settings.integrations.oauth.*`, in 5 locales.

## 25.8. Tests

| Suite | What it proves |
|---|---|
| `unit/oauth/oauth.test.ts` | Issuer and challenge, allowlist, redirect-URI policy, PKCE, scopes, `resource`, secret formats, redaction, denylist |
| `integration/api/oauth/flow.test.ts` | The full flow against real handlers: 401 challenge and discovery through the rewrites, registration and its rejections, authorize, consent, token, then MCP with 21 or 40 tools. Also covers refresh rotation and old-token 401, reuse revocation, Settings revoke, and RFC 7009 revocation by either token type. Failure paths: wrong verifier, client, redirect or `resource`; code reuse and expiry; non-admin and foreign-user consent; deny; keys denied on the consent API. |
| `web pages/oauth/consent.test.tsx`, `lib/return-to.test.ts`, `components/withAuth.test.tsx`, `pages/auth/index.test.tsx`, `components/settings/integrations-tab.test.tsx` | Consent states and decisions, the returnTo round-trip and open-redirect guards, and the Integrations OAuth row |

The flow was also run against a real `next start` build. That run covered the rewrites, the form-encoded token body, and the edge middleware denying keys on `/api/oauth`. It also covered the consent page in Chromium: signed out → sign in → back on consent → Allow → callback with a code.

## 25.9. Operations

- No required environment variables. Optional variables:
  - `OAUTH_ISSUER_URL`, when `NEXTAUTH_URL` isn't the API's public URL
  - `OAUTH_ALLOWED_REDIRECT_HOSTS`
- claude.ai and Cowork call the API from Anthropic's servers, so the API must be reachable over public **https**. A local-only instance works with Claude Code and Claude Desktop through header keys or loopback redirects.
- `FRONTEND_URL` must be the web app's public URL: `/authorize` redirects there for consent.

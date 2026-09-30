# 23. Integrations & API Tokens (Frontend)

Settings → **Integrations** tab: tenant admins create and revoke integration
tokens for AI agents, scripts and other systems (#84). API behaviour:
[`docs/specs/api/23-integrations-api.md`](../api/23-integrations-api.md).

## 23.1. Placement and access

- `src/pages/settings/index.tsx` renders an `integrations` `TabsTrigger` /
  `TabsContent` (icon `KeyRound`, label `pages.settings.tabs.integrations`) only
  when `user?.role === 'admin'` — the same gate as Maintenance. Members and
  viewers never see it; the endpoints also return 403 for them.
- The tab body is `IntegrationsTab` from
  `src/components/settings/integrations-tab.tsx`.

## 23.2. Data layer

- Types: `src/types/integrations.ts` (`Integration`, `ApiKeySummary`,
  `IntegrationAccessLevel`, `KeyExpiryDays`, request/response shapes).
- API client (`src/lib/api.ts`): `getIntegrations`, `createIntegration`,
  `updateIntegration`, `revokeIntegration`, `createApiKey`, `revokeApiKey`.
- Hooks (`src/hooks/use-integrations.ts`): `useIntegrations()` (query key
  `['integrations']`, 30 s stale time), `useCreateIntegration`,
  `useRenameIntegration`, `useRevokeIntegration`, `useAddApiKey`,
  `useRevokeApiKey`. Every mutation invalidates `['integrations']`.
- **The plaintext token never enters the query cache.** Create mutations
  resolve with `{ token }`, which lives only in the dialog's local state and is
  cleared when the dialog closes.

## 23.3. Layout

One `Card` (settings card pattern):

- **Header**: title, description, **New integration** button.
- **List** (`divide-y`): one row per integration —
  - name, access badge, status badge, optional description;
  - `"{{count}} of {{total}} keys active"` · last used (locale date/time or "Never");
  - actions for active integrations: **Add key**, rename (pencil), revoke (trash);
  - **Keys** toggle expanding the key list: key name, `bliss_<prefix>_…`,
    status badge, expiry, last used, **Revoke** for active keys.
- **Footer** (`bg-muted/40`): acting-on-your-behalf note and security note.
- Loading → two `Skeleton` rows; error → `loading_error` in `text-destructive`;
  empty → `empty` message.

### Badges (design tokens only)

| Badge | Classes |
|---|---|
| Read-only | `bg-muted text-muted-foreground border-border` |
| Read & write | `bg-warning/10 text-warning border-warning/20` |
| Active | `bg-positive/10 text-positive border-positive/20` |
| Revoked | `bg-destructive/10 text-destructive border-destructive/20` |
| Expired | `bg-muted text-muted-foreground border-border` |

## 23.4. Dialogs

- **Create integration** (`Dialog`): name (required, ≤ 80), description (≤ 280),
  access level (`RadioGroup` of two bordered cards with plain-language
  descriptions; note that it can't be changed later), key name (optional),
  expiry (`RadioGroup`: 30 days / 90 days (default) / 1 year / Never — "Never"
  shows a `bg-warning/10` warning). Submit → **reveal step**.
- **Reveal step** (`TokenReveal`): "won't be shown again" warning
  (`bg-warning/10 text-warning`), read-only monospace input with the token
  (select on focus) and a **Copy** button (`navigator.clipboard`), a sample
  `curl -H "Authorization: Bearer …" <API_URL>/api/transactions` where
  `API_URL` is `NEXT_PUBLIC_API_URL` (without `/api`) or `window.location.origin`,
  a **Use with Claude (MCP)** block (#89, `data-testid="mcp-snippet"`) with the
  MCP server URL `<API_URL>/api/mcp` and a `claude mcp add --transport http bliss
  <API_URL>/api/mcp --header "Authorization: Bearer <token>"` command pre-filled
  with the token and its own **Copy command** button (copies it as one line),
  and **Done**, which closes the dialog and drops the token from state.
- **Add key**: key name + expiry → same reveal step.
- **Rename**: name + description (access level is not editable).
- **Revoke key / revoke integration**: `AlertDialog` confirmation with
  consequences spelled out; the action button uses `bg-destructive`.
- Every mutation toasts success (`toast.*`) or `toast.error` (destructive).

## 23.5. i18n

All strings live under `pages.settings.integrations.*` (MCP block: `pages.settings.integrations.mcp.*`) (plus
`pages.settings.tabs.integrations`) in `en`, `es`, `fr`, `pt`, `it`. The
`i18n-parity.test.ts` block for #84 checks every EN leaf exists in all locales
with the same `{{placeholders}}` and is translated.

## 23.6. Tests

| File | Covers |
|---|---|
| `components/settings/integrations-tab.test.tsx` | Empty/error states, list + badges, create flow with one-time reveal (token gone after Done and on reopen), validation, error toast, add key, revoke key/integration with confirm + cancel, rename |
| `hooks/use-integrations.test.tsx` | Query + each mutation's endpoint and invalidation; token not cached |
| `pages/settings/settings-integrations-tab.test.tsx` | Tab visible for admin, hidden for member and viewer |
| `i18n/i18n-parity.test.ts` (#84 block) | Locale parity |

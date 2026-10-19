# 27. Enable Banking — Connect, Mapping and Connection Card (Frontend)

Task #132. API: [`docs/specs/api/27-enable-banking-api.md`](../api/27-enable-banking-api.md). Backend: [`docs/specs/backend/24-enable-banking.md`](../backend/24-enable-banking.md). User guide: [EU Bank Sync with Enable Banking](../../guides/enable-banking.md).

Everything here renders only when `GET /api/enablebanking/status` returns `enabled: true`, i.e. the tenant has saved its own Enable Banking credentials (#148, see §27.8). Without them the Accounts page, onboarding, settings and account detail look exactly as before (acceptance criterion "Hidden without credentials"). Viewers never see the connect entry point.

## 27.1. Data layer

| File | Role |
|---|---|
| `src/types/api.ts` | `BankProvider`; `PlaidItem.provider`, `aspspCountry`, `userId`; Enable Banking request/response/error types; `UserSignal.expiresAt` |
| `src/lib/api.ts` | `getEnableBankingStatus`, `getEnableBankingAspsps`, `connectEnableBanking`, `getEnableBankingConnection`, `mapEnableBankingAccounts`, `syncEnableBankingConnection`, `disconnectEnableBankingConnection`. The aspsps / connect / connection / map / sync calls skip the client's numeric-string coercion so IBAN last-4s (`"0123"`) and balances stay strings. |
| `src/hooks/use-enable-banking.ts` | `useEnableBankingStatus` (`{ enabled, configurable, pausedConnections }`, 5 min stale, no retry; credential changes invalidate it), `useEnableBankingEnabled`, `useEnableBankingAspsps` (only while the dialog is open), `useEnableBankingConnection(id)`; mutations connect / map / sync / disconnect invalidate `['enable-banking','connection',id]`, `['plaid-items']`, `['account-list']`, `['metadata']`; map and sync carry `meta.activity` (bank sync) for the processing chip. `enableBankingError()` reads `{ code, … }`. |
| `src/hooks/use-enable-banking-callback.ts` | Handles the API callback's redirect on `/accounts`: `eb=map&connection=<id>` opens the mapping dialog, `eb=reconnected` toasts and refreshes, `eb_error=invalid_state|denied|exchange_failed|not_enabled` toasts a specific message. The params are then stripped with `replace` (no history entry). |
| `src/lib/enable-banking.ts` | `getConnectionState()` (active / expiring ≤ 14 d / expired / error / disconnected / needsMapping / paused — #148, the item or connection reports `paused` and is not revoked), date and balance formatting, localised country names. |

## 27.2. Connect dialog — `components/enable-banking/connect-dialog.tsx`

"Connect EU bank (Enable Banking)" button next to the Plaid connect button on **Accounts** and under it in **Onboarding**. The dialog lists banks from `GET /aspsps` grouped by (localised) country, with search and logos, and shows **"Transactions will be imported from {startDate}"** plus the consent length before **Continue to bank**. Continue calls connect and does `window.location.assign(url)`. `COUNTRY_NOT_ENABLED` / `UNKNOWN_ASPSP` have their own messages.

## 27.3. Mapping dialog — `components/enable-banking/mapping-dialog.tsx`

Opened from the callback redirect, the pending-connections banner or the connection card. One row per bank account (name, •••• last 4, currency, last balance). The select offers existing Bliss accounts (pre-selected from `suggestedAccountId`; options linked to another provider carry a "synced via Plaid / another connection" hint), **Create new account** (inline name, bank, country, currency from the tenant's lists; an "Add «bank»" option creates the bank) or **Don't sync**. "Create new" is never the default; a row without a suggestion starts at "Don't sync". An account chosen in one row is disabled in the others. Rows with `conflict: true` (R6) are disabled with the joint-account explanation and left out of the request. The start date is shown.

On `409 PROVIDER_SWITCH_REQUIRED` a confirmation step lists the accounts and their current provider ("their history is kept") and re-submits with `confirmProviderSwitch: true`. `ACCOUNT_ALREADY_CONNECTED` and `DUPLICATE_TARGET` show error toasts.

`components/enable-banking/pending-connections.tsx` shows a banner on Accounts for connections still in `PENDING_SELECTION` (they have no linked Bliss account yet, so nothing else would surface them).

## 27.4. Connection card — `components/accounts/bank-connection-card.tsx`

Rendered in `account-detail-panel.tsx` for accounts whose item has `provider === 'ENABLE_BANKING'`:

| State | Badge |
|---|---|
| Active | `positive` |
| Expiring (≤ 14 days to `consentExpiration`) | `warning` |
| Expired (`LOGIN_REQUIRED` or past expiry) / Error | `destructive` |
| Needs mapping (`PENDING_SELECTION`) | `warning` |
| Disconnected (`REVOKED`) | muted |
| Paused (#148: no tenant credentials) | `warning` — "Paused: credentials missing", a link to Settings → Bank sync for admins, "Ask an admin" for others; no action buttons |

It shows the bank and country, expiry date with days left, last sync and the latest balance per mapped account. Actions: **Sync now** (429 → "Daily refresh limit reached" with the localised reset time; `CONNECTION_NOT_ACTIVE` / `NO_MAPPED_ACCOUNTS` messages), **Reconnect** (only for the authorising user — `authorizedByMe`, else `item.userId === user.id`; others see who must reconnect), **Map / Manage accounts**, **Disconnect** (confirm; admin or authorising user).

For Enable Banking accounts the detail panel hides every Plaid-only action: ConnectionHealth (and fetch historical), the Plaid consent / reconnect cards, Resync, Rotate token, Re-link Plaid and Pause Sync. The shared sync-logs table stays. The Plaid branch is unchanged.

## 27.5. Notifications and settings

- `notification-center.tsx` renders `BANK_CONSENT_EXPIRING` (calendar-clock icon, `info` / `warning` severity, link to `/accounts`). The label is the server's (it carries the bank name). Unknown types and severities still fall back safely.
- Settings → AI Classification: the history-days help text adds "Also applies to Enable Banking connections" when the feature is enabled.

## 27.6. i18n

New `enableBanking` namespace in all five locales (en / es / fr / pt / it); `i18n-parity.test.ts` checks every key exists in each.

## 27.7. Tests

#148: `lib/pem.test.ts` (every shared test key), `components/settings/enable-banking-key-input.test.tsx`, `bank-sync-tab.test.tsx`, `hooks/use-enable-banking-credentials.test.tsx`, the paused cases in `bank-connection-card.test.tsx`, the setup link in `pages/accounts.test.tsx`, the tab in `pages/settings/settings-integrations-tab.test.tsx` and the signal in `notification-center.test.tsx`.

`components/enable-banking/connect-dialog.test.tsx`, `mapping-dialog.test.tsx`, `components/accounts/bank-connection-card.test.tsx`, `hooks/use-enable-banking.test.tsx`, plus Enable Banking cases in `pages/accounts.test.tsx` (callback params), `account-detail-panel.test.tsx` (provider branch hides Plaid actions) and `notification-center.test.tsx`. The MSW default handler answers `status` with `enabled: false`.

## 27.8. Bank sync settings (#148)

Per-tenant credentials. API: [credentials routes](../api/27-enable-banking-api.md#credentials-148).

- **Tab.** `pages/settings/index.tsx` registers `bank-sync` (Landmark icon) in the admin-only section, next to Maintenance, Processing and Integrations (deliberately not inside Integrations, which is about agent keys). `/settings?tab=bank-sync` falls back to General for members and viewers through the existing `isAllowedTab`.
- **`components/settings/bank-sync-tab.tsx`.** Card "Enable Banking (EU banks)": intro with the 5-account limit and a link to the guide, a paused banner (`usage.pausedConnections` while not configured). Not configured → the form: read-only **callback URL** with Copy, **Application id** (UUID check), the key input, **Save and verify**. Configured → status badge (Verified `positive`, Not verified `warning`, Invalid `destructive`, badge pattern), application id, key fingerprint + bits, last verified, active connections, linked accounts "N of 5", a warning when `callbackRegistered === false`, and **Re-verify**, **Replace credentials** (form pre-filled with the app id, key empty), **Remove**. A `409 CONFIRMATION_REQUIRED` on save (app change) or remove opens an `AlertDialog` with the affected count, then resends with `confirmAppChange` / `confirm=true`. Server codes map to messages (`INVALID_CREDENTIALS`, `SANDBOX_APP`, `INVALID_APP_ID`; `KEY_*` show under the key input). **Change history**: the API's last 10 entries (action, app id, fingerprint, who, when).
- **`components/settings/enable-banking-key-input.tsx`.** Primary: a drop zone with **Choose file** (`accept=".pem,.key,.txt"`, `FileReader.readAsText`, files over 16 KB refused unread, the input reset after each read). Secondary: **Paste instead** — an 8-row monospace `Textarea` with spell-check, autocorrect, autocomplete and autocapitalize off. A live line shows "Valid RSA private key · N-bit" or the specific error from `lib/pem.ts`.
- **`lib/pem.ts`.** Dependency-free mirror of the server's `parsePrivateKey` format checks (normalisation, headers, 16 KB cap, a minimal DER walk for the RSA modulus of PKCS#1 and PKCS#8), tested against `packages/shared/test-fixtures/enablebanking-keys/`. The server stays the authority.
- **The key leaves the page.** It lives only in the form's component state; on success the state is cleared, the save mutation is never cached (`gcTime: 0`) and is `reset()`. Nothing touches browser storage. The web app has no Sentry, so there are no breadcrumbs to scrub.
- **`hooks/use-enable-banking-credentials.ts`.** Query `['enable-banking','credentials']`; save / remove / verify set the returned view and invalidate `['enable-banking']` (status included), `['plaid-items']` and `['notification-summary']`, so "Connect EU bank" appears on Accounts without a reload.
- **Accounts.** Admins of a tenant without credentials (`enabled: false, configurable: true`) see **Set up EU bank sync** (link to `/settings?tab=bank-sync`) instead of the connect button; members and viewers see no entry point.
- **Notifications.** `ENABLE_BANKING_CREDENTIALS_INVALID` (key icon, translated label, link to Bank sync; admins only — the API never sends it to others).

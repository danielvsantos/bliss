# 27. Enable Banking — Connect, Mapping and Connection Card (Frontend)

Task #132. API: [`docs/specs/api/27-enable-banking-api.md`](../api/27-enable-banking-api.md). Backend: [`docs/specs/backend/24-enable-banking.md`](../backend/24-enable-banking.md). User guide: [EU Bank Sync with Enable Banking](../../guides/enable-banking.md).

Everything here renders only when `GET /api/enablebanking/status` returns `enabled: true`. Without the server secrets the Accounts page, onboarding, settings and account detail look exactly as before (acceptance criterion "Hidden without credentials"). Viewers never see the connect entry point.

## 27.1. Data layer

| File | Role |
|---|---|
| `src/types/api.ts` | `BankProvider`; `PlaidItem.provider`, `aspspCountry`, `userId`; Enable Banking request/response/error types; `UserSignal.expiresAt` |
| `src/lib/api.ts` | `getEnableBankingStatus`, `getEnableBankingAspsps`, `connectEnableBanking`, `getEnableBankingConnection`, `mapEnableBankingAccounts`, `syncEnableBankingConnection`, `disconnectEnableBankingConnection`. The aspsps / connect / connection / map / sync calls skip the client's numeric-string coercion so IBAN last-4s (`"0123"`) and balances stay strings. |
| `src/hooks/use-enable-banking.ts` | `useEnableBankingStatus` (30 min stale, no retry), `useEnableBankingEnabled`, `useEnableBankingAspsps` (only while the dialog is open), `useEnableBankingConnection(id)`; mutations connect / map / sync / disconnect invalidate `['enable-banking','connection',id]`, `['plaid-items']`, `['account-list']`, `['metadata']`; map and sync carry `meta.activity` (bank sync) for the processing chip. `enableBankingError()` reads `{ code, … }`. |
| `src/hooks/use-enable-banking-callback.ts` | Handles the API callback's redirect on `/accounts`: `eb=map&connection=<id>` opens the mapping dialog, `eb=reconnected` toasts and refreshes, `eb_error=invalid_state|denied|exchange_failed|not_enabled` toasts a specific message. The params are then stripped with `replace` (no history entry). |
| `src/lib/enable-banking.ts` | `getConnectionState()` (active / expiring ≤ 14 d / expired / error / disconnected / needsMapping), date and balance formatting, localised country names. |

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

It shows the bank and country, expiry date with days left, last sync and the latest balance per mapped account. Actions: **Sync now** (429 → "Daily refresh limit reached" with the localised reset time; `CONNECTION_NOT_ACTIVE` / `NO_MAPPED_ACCOUNTS` messages), **Reconnect** (only for the authorising user — `authorizedByMe`, else `item.userId === user.id`; others see who must reconnect), **Map / Manage accounts**, **Disconnect** (confirm; admin or authorising user).

For Enable Banking accounts the detail panel hides every Plaid-only action: ConnectionHealth (and fetch historical), the Plaid consent / reconnect cards, Resync, Rotate token, Re-link Plaid and Pause Sync. The shared sync-logs table stays. The Plaid branch is unchanged.

## 27.5. Notifications and settings

- `notification-center.tsx` renders `BANK_CONSENT_EXPIRING` (calendar-clock icon, `info` / `warning` severity, link to `/accounts`). The label is the server's (it carries the bank name). Unknown types and severities still fall back safely.
- Settings → AI Classification: the history-days help text adds "Also applies to Enable Banking connections" when the feature is enabled.

## 27.6. i18n

New `enableBanking` namespace in all five locales (en / es / fr / pt / it); `i18n-parity.test.ts` checks every key exists in each.

## 27.7. Tests

`components/enable-banking/connect-dialog.test.tsx`, `mapping-dialog.test.tsx`, `components/accounts/bank-connection-card.test.tsx`, `hooks/use-enable-banking.test.tsx`, plus Enable Banking cases in `pages/accounts.test.tsx` (callback params), `account-detail-panel.test.tsx` (provider branch hides Plaid actions) and `notification-center.test.tsx`. The MSW default handler answers `status` with `enabled: false`.

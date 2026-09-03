# Tracking Subscriptions

The **Subscriptions** page (`/subscriptions`) surfaces every recurring charge Bliss can find across your accounts — one row per merchant, with cadence, amount, next-expected-charge date, and a monthly + annualized recurring-spend total. Detection is deterministic (no LLM) and runs over your committed transactions, so CSV imports are covered exactly like Plaid-synced ones.

## How detection works

A merchant appears on the Subscriptions page through one of two paths:

### Tier A — category signal

Any transaction in a category marked **Recurring charge** counts. **A single occurrence is enough.** Bliss ships this flag on the obvious ones — the *Subscriptions* group (Software, Content & Media, Loyalty Programs), the insurance categories, Internet, and Data Plan — and you can toggle it on any category from the [Categories](/docs/guides/choosing-categories) page (open a category → **Recurring charge**).

### Tier B — interval heuristic

For spending categories that *aren't* marked recurring, Bliss looks for a pattern: **3 or more charges from the same merchant, at a stable amount, on a regular weekly or monthly interval**, within the last 6 months. This catches gym memberships, storage lockers, and the like without you having to flag the category. Quarterly and annual cadences are only detected via Tier A.

### Merchant grouping

Charges are grouped by a normalized merchant key, so `NETFLIX.COM`, `SQ *NETFLIX`, `NETFLIX 08/15 POS DEBIT`, and `Netflix Inc` all collapse into one subscription. `Netflix` and `Netflix Games` stay separate.

Only **debits** (money out) are considered — a recurring credit is income, not a subscription.

## When it runs

- **Nightly**, for every tenant, over a 6-month window.
- **"Scan now"** on the Subscriptions page re-runs it on demand (30-minute cooldown).
- **"Full history scan"** in **Settings → Maintenance** widens the category-signal lookback to 48 months, so annual subscriptions and long-dormant ones surface. Run this once after your first import.

## Reviewing the list

Each row shows the merchant, its category, native amount (plus an approximate conversion to your display currency), cadence, last-charged date, next expected charge, and an **Active** / **Lapsed** status. A charge goes **Lapsed** when nothing new has landed within 1.5× its cadence; lapsed rows are hidden by default (use the **Active / Lapsed / All** filter) and don't count toward the totals.

Expand a row to see the underlying transactions. Click the cadence label to correct it — your choice sticks and future scans won't overwrite it.

### Confirm / dismiss

- **Confirm** pins a subscription: it stays on the list on every future scan even if it later stops matching the heuristic.
- **Not a subscription** removes it for good — that merchant is never re-surfaced. It moves to the **All** view with a **Restore** action if you change your mind.

These decisions are remembered per merchant, so re-imports and re-scans respect them.

## Summary

The header shows your total **monthly-normalized** recurring spend and its **annualized** figure, in your tenant's display currency. Weekly charges are scaled ×52/12, quarterly ÷3, annual ÷12. Rows with no available exchange rate are shown in their native currency and excluded from the totals (with a note).

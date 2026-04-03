# Bank Sync with Plaid

Bliss integrates with Plaid for automatic bank transaction sync. Transactions are fetched incrementally, deduplicated, and classified by the AI pipeline.

## Setup

1. Sign up at [plaid.com/dashboard](https://plaid.com/dashboard) for API credentials.
2. Add to your `.env`:

```env
PLAID_CLIENT_ID=your_client_id
PLAID_SECRET=your_secret
PLAID_ENV=sandbox          # sandbox, development, or production
```

3. Restart services.

For testing, use `sandbox` with credentials `user_good` / `pass_good`.

## Connecting an account

1. Navigate to **Accounts** and click **Connect Bank Account**.
2. Complete the Plaid Link flow to authorize your bank.
3. Bliss starts an initial sync immediately.

![Accounts page with Plaid connection](/images/accountspagewithplaid.png)

## How sync works

Bliss uses a two-worker architecture:

- **plaidSyncWorker** — Fetches new transactions via cursor-based pagination (IO-bound)
- **plaidProcessorWorker** — Classifies and persists each transaction (CPU-bound)

Syncs run automatically and incrementally — only new transactions since the last cursor are fetched. Hash-based deduplication catches any manual-entry duplicates.

## Connection health

The account detail view shows:
- **Connection status** and last sync time
- **Sync logs** with error details
- **Token rotation** — re-authenticate if Plaid tokens expire
- **Re-sync** — trigger a manual sync at any time

## Plaid + AI classification

Plaid provides its own category hints, which Bliss passes to the AI pipeline as additional context. The 4-tier classification waterfall runs on every Plaid transaction, and results above the `autoPromoteThreshold` are saved directly without manual review.

## Next steps

- [AI classification](/docs/guides/ai-classification) — understand how the pipeline classifies transactions
- [Importing transactions](/docs/guides/importing-transactions) — supplement Plaid with CSV imports

/**
 * Server `instructions` sent on MCP initialize (#89): the Bliss concepts an
 * agent needs before it picks tools.
 */
export const MCP_INSTRUCTIONS = `Bliss is a personal finance app: bank and card transactions, investment portfolios, subscriptions and AI insights for one household (a "tenant"). You act as the Bliss admin who approved this connection (an integration key or an OAuth connector).

Conventions
- Dates are YYYY-MM-DD. Analytics periods are "YYYY-MM", "YYYY-Qn" or "YYYY".
- Amounts are { value, currency }. Transaction amounts are signed: positive = money in (credit), negative = money out (debit), in the transaction's own currency.
- Summaries (get_spending_summary, portfolio, subscriptions) are converted into the user's display currency. Call get_reference_data first to learn it, the enabled currencies and the years that have data.
- Categories have a type (e.g. Income, Essentials, Lifestyle, Investments, Transfers) and a group (e.g. Food). get_spending_summary works per group; for one category use search_transactions with categoryId.
- IDs come from listing tools (and create_bank / create_account): list_accounts, list_categories, list_tags, search_transactions, get_portfolio_holdings, list_subscriptions, get_plaid_review_queue, list_imports.
- Lists are paged: pass nextCursor back as cursor while hasMore is true.

Setting up
- create_bank (idempotent) returns the bankId for create_account. Banks and manual accounts can be created here; renaming or deleting them, and bank connections (Plaid), are done in the app.
- An account's currency and country must already be enabled for the workspace (get_reference_data → tenant). If one is missing, ask the user to enable it in Settings.

Two review queues
- Bank sync (Plaid): get_plaid_review_queue → review_plaid_transactions. Approving creates the transaction.
- Imported statements: the user uploads the file in the Bliss app; then list_imports → review_import_rows → finalize_import (commit). You cannot upload files, and bank connections are managed in the app.

Writes behave exactly like the app: re-categorising teaches the classifier, and analytics and portfolio values refresh in the background. After a write, poll get_processing_status until nothing in flight affects what you changed (each entry's affects lists the data it will change), then read the summaries. A Read-only connection only sees read tools.`;

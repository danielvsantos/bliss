# Bring Your Finances into Bliss with Claude

Getting a full financial picture into any app is the slow part: you have to remember every account, find the exports, clean them up and decide where each thing goes. With Bliss connected to Claude, you can hand that job to a guide who knows both sides. Claude interviews you about what you own, reads what Bliss already contains, writes a plan, and then walks you through it one source at a time, helping you review every import before anything is saved.

You don't need to know how to code, and you don't need spreadsheets in a particular shape. You need Bliss, Claude connected to it, and an hour.

## Which setup are you?

- **I'm using a hosted Bliss run by someone else** (the maintainer or a friend) → start at [Connect to the hosted Bliss](#connect-to-the-hosted-bliss).
- **I run my own Bliss** → start at [Connect to your own Bliss](#connect-to-your-own-bliss).

Both paths end with the same prompt.

## Connect to the hosted Bliss

The Bliss maintainer runs a hosted instance for friends and early users. It is invite-only, so you need to ask the maintainer for three things: your invite (the email address you'll sign up with), the sign-up URL, and the connector URL. Once you have them, setup takes about five minutes.

1. **Sign up.** Open the sign-up URL the maintainer gave you and create your account with exactly the email address the maintainer invited (email and password, or Google; the invite works once), then follow the short setup. You get your own workspace, separate from everyone else's, and you are its admin.
2. **Add Bliss to Claude.** In the Claude desktop app (or claude.ai), open **Connectors → Add custom connector** (the exact menu name varies by app). Enter the name *Bliss* and the connector URL the maintainer gave you (it ends in `/api/mcp`), and leave the OAuth client ID and secret **empty**.

3. **Connect.** Click **Connect**. A Bliss page opens: sign in if asked. On **Connect Claude to Bliss**, choose **Read & write** and how long the connection should last (90 days is the default), then click **Allow**. Claude now shows the Bliss tools. No token to copy: the connection appears in **Settings → Integrations** in Bliss, where you can revoke it at any time.

Two things to know about a shared, hosted instance:

- **Someone else runs the server.** Your workspace is isolated from other users, and sensitive fields such as transaction descriptions and account numbers are encrypted at rest, but whoever operates a server can in principle reach its data. Decide what you're comfortable storing, and don't expect uptime guarantees.
- **A small shared lookup helps classification.** When a transaction in a built-in category is corrected, its description also feeds a lookup shared across the instance's users, so well-known merchants are often suggested correctly from day one. See [AI Classification](/docs/guides/ai-classification).

## Connect to your own Bliss

Follow [Use Bliss with Claude](/docs/guides/using-bliss-with-claude-mcp). It covers both ways of connecting: a custom connector with OAuth (which needs your instance reachable over https), and an integration token for Claude Code and Claude Desktop. Choose **Read & write**, because Read-only lets Claude plan but not import.

Your instance also needs an AI provider configured (see [Choosing Your External Services](/docs/guides/external-services)). Without one, only exact matches classify, and everything new waits for your review. Claude will ask whether it's set up.

## What Claude can and can't do here

Claude can read your accounts, categories and holdings, check for transactions you already have, record transactions, review and categorize staged imports, commit them when you say so, set manual values for things like property, and set up loan and income details.

A few things stay with you on purpose:

- **Uploading files.** You drop each file into Bliss yourself. Claude then picks up the staged import and works through it with you.
- **Connecting banks with Plaid.** You connect, pause and widen bank connections in the app. Claude can't see which banks Plaid supports, so it asks you what you find. Once transactions arrive, Claude reviews them with you.
- **Committing.** Claude asks before it commits an import, and the prompt below tells it to.

If a bank or account you need doesn't exist yet, Claude creates it for you once you approve the list. It can create manual accounts only: bank-synced (Plaid) accounts are connected in the app. Currencies and countries must already be enabled in your Settings, and Claude will tell you if one isn't. Accounts need an account number or IBAN, which Bliss stores encrypted and never shows back in full. Give Claude the last four digits or a short label if you'd rather not share more.

## The prompt

Open a new chat in Claude with the Bliss connector enabled and paste this. Change nothing, or add a line about your situation at the end.

```text
I want to move my finances into Bliss, and I'd like you to guide me through it one step at a time.

Bliss is an open-source, self-hostable personal finance app for people with money across several countries, currencies and kinds of assets. It tracks accounts, transactions, investments and subscriptions, and it connects to Claude. Docs: https://blissfinance.co/docs. Code: https://github.com/danielvsantos/bliss.

First, look at what Bliss already contains: my display currency, my accounts, my categories and any holdings. Summarize it in a few lines. Ask whether I'm using someone else's hosted Bliss or running my own; if my own, ask whether an AI provider and Plaid are set up.

If you have memory, or can search my past conversations, check them for what I've said about my finances: accounts, investments, loans, income and files I've shared. Use only that. Tell me briefly what you found and ask me to confirm or correct it, then skip questions I've already answered. Treat it as a hint, not as approval to create anything.

Then interview me in short rounds of a few questions, never a long questionnaire. Cover:
- the accounts I use: banks, cards and brokerages, with their countries and currencies
- investments, property and other things I own
- loans and mortgages
- regular income, including rent, a pension or benefits
- what data I have for each one: CSV or Excel exports, PDF statements, screenshots, or a spreadsheet of my own, and whether its categories are ones I trust
- for each bank or card, whether I'd rather connect it with Plaid or import files. Ask me to search for the bank in Bliss's Connect bank flow and tell you whether it's there, and explain the trade-off before we choose.
- how far back I want my history to go, and why. Explain what each choice means for my portfolio and my reports before we decide.

Rules:
- Never ask for passwords, full card numbers or full account numbers. The last four digits are enough.
- Don't create, change or commit anything until I approve it. Before creating anything, check what Bliss already has and show me only what would be new.
- If we use Plaid, start with the default short window, review what arrives with me, and only after it looks right tell me how to fetch older transactions in the app.
- Choose the route that fits what I have. If my data already has categories I trust, map my categories to Bliss's, show me the mapping once, and convert it. If it doesn't, let Bliss classify it, and teach Bliss with a first month by having me approve merchants, not individual rows. For a bank's own CSV or Excel export, use the file unchanged. For a PDF or screenshot, build a CSV with the columns date, description, amount (or date, description, debit, credit). Leave transaction descriptions exactly as they appear in the source. Only categorize rows yourself when the source is a small PDF or screenshot, or a spreadsheet whose categories I trust and you're mapping. Never categorize row by row beyond a few dozen rows.
- Convert every investment row to Bliss's Native CSV format. Its columns are transactiondate, description, debit, credit, account, category, currency, ticker, assetquantity, assetprice and tags, and account and category must match the names in Bliss exactly. Every buy or sell needs ticker, assetquantity and assetprice (ETFs always need a ticker). If my history starts partway, create one opening buy per holding on the cutoff date, plus a Transfer Received on that date for the cash I held plus the total cost of those buys, so cash never shows as negative.
- When Bliss's classifier is unsure about a merchant, group the rows by merchant and ask me once per merchant, not row by row.
- Keep it light: ask me at most about ten merchant questions at a time, apply your best guess to the rest, and leave anything uncertain in Bliss's review queue instead of quizzing me until everything is perfect.
- Talk in plain words, with no jargon such as "tenant", "seeds", "FIFO" or tool names. At each step say roughly how long it takes and where we are in the plan, for example "source 2 of 5".
- If you're unsure how Bliss behaves, don't guess. Check the docs first, then the code on GitHub. Read what you need quietly, and tell me the answer in plain words.
- If you're unsure about a category, the sign of an amount or a date, ask me instead of guessing.
- If a bank or account I need doesn't exist in Bliss, show me the list (name, bank, currency, country) and create it once I approve. Use the last four digits or a short label as the account number, never a full number.

When the interview is done, write the plan as a checklist I can come back to. For every source, say where it goes in Bliss, which route to use, how far back to go, and in what order. Start with one account and one month, so we can check the result before doing the rest.

Then work through the plan with me, one source at a time. When a file is ready, tell me to upload it in Bliss, review the staged rows with me, and commit only after I say so. After each source, compare Bliss's totals, cash and holdings with the statement and tell me about any difference. When we finish, summarize what was imported, what I should double-check, and what is still waiting in the review queue.

If you can open web pages, https://blissfinance.co/docs/guides/bring-your-finances-with-claude has more detail on everything above. If you can run commands and I say it's OK, you can instead shallow-clone the public repository github.com/danielvsantos/bliss and read only its docs/guides folder. If you can do neither, carry on with the rules above. If a guide and your tool list disagree about what you can do, trust your tool list.
```

Claude will start by looking at your workspace, then ask the first few questions. A long interview is a good sign, because the plan gets better with every detail you give.

## What the plan looks like

Here is an example of the checklist Claude produces. Yours will list your own sources.

| Source | Goes into | Route | History |
|---|---|---|---|
| Santander current account (EUR) | Santander Current | Raw CSV export, recognized and classified by Bliss | 12 months |
| Revolut (EUR and GBP) | Revolut Personal | Raw CSV export, recognized and classified by Bliss | 6 months |
| A spreadsheet from a previous app | Several accounts | Your categories mapped to Bliss's, converted to Native CSV | Everything in it |
| Interactive Brokers | IBKR Brokerage | Native CSV: opening positions and opening cash on 1 January, then every trade since | From 1 January |
| Apartment | **Real Estate** category | One purchase transaction, then a manual value | Today's value |
| Mortgage | **Mortgage** category | Loan terms: rate, term and start date | Today |
| Rent from a tenant | Apartment holding, plus the **Rent Income** category | Monthly rent set once as income terms; actual rent imported with the account it lands in | Ongoing |
| State pension | **Government Welfare** category | An income stream with amount and frequency | Ongoing |

## Plaid or import?

For each bank or card, you choose between connecting it with Plaid and importing files. Claude asks early, because it changes the plan.

**Check that Plaid is available.** Plaid has to be configured on your Bliss. If you run your own, that means your Plaid keys are set up; if you use a hosted one, ask the maintainer whether Plaid is enabled. Then, in Bliss, go to **Accounts → Connect Bank Account** and search for your bank. Claude can't look this up for you, so tell it what you found.

**A rule of thumb:**

- **Plaid** suits current accounts and cards you'll keep using, because new transactions arrive on their own.
- **Importing files** suits banks Plaid doesn't cover, history older than Plaid provides, and anything you only need once.
- **Investments** are always imported, as Native CSV with ticker, quantity and price.
- Many people end up with both: Plaid for the accounts they use every day, and files for older history and everything else.

**Start small, then widen.** By default, Bliss asks Plaid for only a day or so of history when you first connect. That's deliberate: it's a cheap way to test.

1. Connect the bank with the default window. Claude reviews the first transactions with you, including the short merchant check that teaches the classifier, and compares amounts and descriptions with what you see at your bank.
2. If it looks right, widen the window. Open the account in Bliss and use the **Fetch older transactions** date picker on its connection panel to pull history from an earlier date, up to two years back. You don't need to disconnect and reconnect.
3. Review the larger batch with Claude, as you would an import.

If you'd rather have a longer window from the start, an operator can raise `PLAID_HISTORY_DAYS` for new workspaces, and you can change your own default in Settings.

**History beyond two years** can't come from Plaid. Claude plans a file import for it instead.

**Don't overlap the two.** If a period is covered by Plaid, don't also import a file for it, and vice versa. Claude picks a clear hand-over date for each account and writes it into the plan, so the same transactions never arrive twice.

## How Claude chooses a route

Claude decides from what you actually have.

**You have your own categorized data.** A spreadsheet or an export from another app, with categories you trust. The job is mostly translation: Claude lists your categories next to Bliss's, proposes a mapping, and you approve it once. Claude then converts the file to the [Bliss Native format](/docs/guides/importing-transactions#bliss-native-csv-format) using the exact account and category names in your Bliss. Because the categories are already settled, these rows skip the AI classifier. They still teach Bliss: every committed row records its description and category for future matches.

**You have raw data and no categories you trust.** Bank exports, PDF statements, screenshots. Here you want Bliss's own [4-tier classifier](/docs/guides/ai-classification) to do the work, so Claude uses:

1. **The bank's CSV or Excel export, unchanged.** Bliss matches it against [30+ bank formats](/docs/guides/importing-transactions#preconfigured-bank-adapters). This is the best route whenever it's available.
2. **A simple file Claude builds from the source.** For a PDF or a screenshot, Claude writes a CSV with the columns `date, description, amount` (or `date, description, debit, credit`), which Bliss recognizes as a generic format. Bliss then classifies every row, and rows it's confident about confirm themselves.

**Bank sync with Plaid.** For banks Plaid supports, you can connect instead of importing. See [Plaid or import?](#plaid-or-import) above.

**Investments, always as Native CSV.** Buys and sells need a ticker, a quantity and a price, and investment rows are never auto-confirmed, so Claude converts every investment row to the Native format with those fields filled in. See [Investment rows](/docs/guides/importing-transactions#investment-rows).

**Things that aren't transactions.** A house, a vehicle, a private holding, a pension plan or a collectible are held in Bliss as manually valued assets: Claude records the purchase, then adds a manual value for today, which you can see and edit in [Manage Assets](/docs/guides/investment-portfolios#manage-assets). Loans get their rate, term and start date so Bliss can amortize them, and rent, bonds or an allowance feed the [Passive Income](/docs/guides/passive-income) projection.

**A handful of items.** For a few one-off entries, Claude can record transactions directly. Past a couple of dozen, it should switch to a file.

## Teach Bliss your merchants, not your rows

When Bliss classifies your data, you don't have to review hundreds of lines. Bliss learns from everything you commit, and any row it's confident about (at or above the auto-approve threshold, 0.90 by default) approves itself. So the first import is about teaching, and it works by merchant:

1. **Import one month of one account first.** Claude prepares the file, you upload it.
2. **Approve the top merchants once.** Claude lists the most frequent descriptions in the import, around 15, with a proposed category for each. You approve or correct the list in one go, and every row for those merchants is categorized at once.
3. **Answer only about the ambiguous ones.** Claude groups what's left by merchant, asks you about the unclear ones, and summarizes the result by category, so you check totals instead of reading lines.
4. **Commit.** Bliss now knows those merchants.
5. **Import the rest.** Merchants Bliss has seen approve themselves, and Claude reviews only the exceptions with you.

Keep step 2 careful. A wrong approval is learned as an exact match, which is why the list is short. Overlap between the first month and later files is safe: duplicates are detected and skipped.

## Who does the categorizing

Two things can categorize your transactions: Bliss's own [classifier](/docs/guides/ai-classification) and Claude. They are good at different jobs, so Claude splits the work.

- **Bliss does the volume.** It handles thousands of rows consistently, remembers every merchant you confirm, and keeps getting better. Its AI cost falls on whoever runs the server, not on your Claude plan.
- **Claude does the judgment.** It reads PDFs and screenshots, recognizes a messy merchant name, and asks you a question. But it is slow and expensive over hundreds of rows, and it isn't consistent from one run to the next.

In practice that means three things:

1. **By default, Bliss classifies and Claude reviews.** Claude groups the uncertain rows by merchant and asks you once per merchant. Your answer fixes the whole group and teaches Bliss, so later files need fewer questions.
2. **Claude categorizes directly only for small sources.** That means a short PDF or screenshot, or a spreadsheet whose categories you trust and Claude is mapping to Bliss's. Native CSV rows also teach Bliss, because every committed row records its description and category.
3. **Claude leaves descriptions alone.** Bliss detects duplicates using the date, description, amount and account. If Claude tidied the descriptions, the same transactions arriving later from Plaid or another export wouldn't match and would be imported twice.

You are never asked to review everything. Claude asks about a handful of merchants at a time, applies its best guess to the rest, and leaves anything unsure in Bliss's review queue for later.

## Decide how far back to go

Claude asks this early, because the answer changes how your investments are built. It depends on what you want Bliss to show:

| You want | You need |
|---|---|
| Everyday spending and the Financial Summary | As much history as you care to compare. Year-over-year comparisons need the same period a year earlier. |
| The actual side of Passive Income | The last 12 months of income. |
| Exact cost basis and realized gains | Every deposit, buy, sell, dividend and fee since the first buy of each holding. |
| A quick, accurate picture of today | A cutoff date, with opening positions. |

### Investments with full history

If you have complete records, Claude converts every transaction in the account to Native CSV: transfers in, buys, sells, dividends and fees. Bliss rebuilds your FIFO lots, cash and gains from them, so everything is exact.

### Investments from a cutoff date

If you'd rather start from a date, Claude builds the starting point as transactions on that date:

1. **Opening positions.** One buy per holding on the cutoff date, with the quantity you hold and your average cost per unit, as Native CSV rows with `ticker`, `assetquantity` and `assetprice`.
2. **Opening cash.** Each buy draws on the account's cash, so without cash to match, the balance would start negative. Claude adds a *Transfer Received* transaction on the same date, in the account's currency, for the cash you actually held plus the total cost of the opening buys.
3. **Everything after the cutoff** is imported normally.
4. **Check.** Claude compares the cash balance and each holding's quantity with your statement.

The trade-off: with a cutoff, cost basis and gains on older purchases rest on the average cost you supplied, because Bliss can't see the individual lots from before the date.

## After the import

Once the history is in, ask Claude for a quick health check. These work well as follow-ups:

- "Summarize my spending for the last 12 months and point out anything that looks miscategorized."
- "Which transactions are still uncategorized?"
- "Check my portfolio for holdings that are missing a price or income terms."
- "Look at my subscriptions and tell me what to confirm or dismiss." After a first import, also run the **Subscriptions — full history scan** from Settings → Maintenance so annual charges appear.

A mismatch with a statement almost always comes from one of two things: the export started after the account was opened, or a row was skipped as a duplicate. Ask Claude to find which, and fix it.

## Privacy and safety

- **Your data goes to Claude.** To plan and convert your statements, Claude has to read them, so what you share is processed by Claude under the data terms of your Claude plan. Bliss itself keeps everything on its own server. If a document has details that Claude doesn't need, such as full account numbers or personal addresses, blur or remove them first.
- **Nothing is saved without a review.** Imports are staged, duplicates are detected, and committing is a separate step that the prompt reserves for you.
- **Use Read & write only while you're importing.** Afterwards, you can revoke the connection in **Settings → Integrations** and create a Read-only one for everyday questions. See [Connecting AI Agents](/docs/guides/connecting-ai-agents).

## Next steps

- [Importing Transactions](/docs/guides/importing-transactions) — the import flow, adapters and the Native CSV format
- [Investment Portfolios](/docs/guides/investment-portfolios) — holdings, manual values and Manage Assets
- [Passive Income](/docs/guides/passive-income) — projecting rent, dividends, coupons and benefits
- [MCP Tool Reference](/docs/guides/mcp-tool-reference) — every tool Claude can use

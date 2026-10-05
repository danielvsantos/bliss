# Why Are My Numbers Updating?

When you add, edit or delete a transaction, approve bank transactions, finish an import, or when the nightly jobs run, Bliss recalculates your portfolio and analytics **in the background**. Depending on how much history you have, this takes a few seconds to several minutes. While it runs, report pages can briefly show the numbers from before your change.

Bliss shows you when that is happening, so you never have to wonder whether your edit "didn't work".

---

## The status chip in the header

Next to the notification bell you'll see a small chip whenever background work is in progress. It is hidden when everything is up to date.

| Chip | Meaning |
|---|---|
| **Queued** | Your change was received and the recalculation is about to start. It appears the moment you save. |
| **Updating** (pulsing dot) | Bliss is recalculating right now. |
| **Taking longer than usual** | Nothing has moved for a while (30 minutes, or 60 for a full rebuild or market-data refresh). Usually it's just a busy queue: the nightly jobs for all workspaces run one after another. This is only a label; Bliss never cancels or restarts work because of it. |
| **Update failed** | The recalculation failed even after its automatic retries. Your data is safe; the numbers may be out of date until the next successful update. |

Click the chip to see what is updating:

- the kind of work, for example *Updating portfolio*, *Updating analytics*, *Syncing bank*, *Importing transactions*, *Refreshing market data* or *Scanning subscriptions*;
- the current step and a progress percentage when one is available (for example *Valuing assets · 40 %*);
- who started it: your own change has no label, while work started by **Nightly** jobs, an **AI agent** (an MCP connection or integration key), a **Bank sync**, an **Import** or an admin **Rebuild** is labelled;
- "Last updated X ago" at the bottom.

Ten quick edits in a row show as **one** "Updating portfolio" line, not ten.

If the chip says the background worker is offline, queued work can't start until the backend worker is running again. This is typical for self-hosters who run the worker as a separate service (`START_MODE=worker`).

## The banner on report pages

The Dashboard, Expenses, Financial Summary, Tag Analytics, Portfolio, Equity Analysis, Passive Income, Subscriptions, Accounts and Insights pages show a short banner while work that affects **that page** is in progress:

> Numbers on this page are being recalculated (Valuing assets, 40 %). They'll refresh automatically.

You don't need to reload. When the work finishes, the page refreshes its numbers and the banner disappears. When nothing is running, the page shows a quiet "Updated X ago" instead.

## What should I do if an update failed?

1. Wait for the next change or the nightly run. Most failures are transient and the next run fixes them.
2. Admins can open **Settings → Administration → Processing** (or click the *background update failed* notification) to see what failed and its error code.
3. If the numbers stay wrong, run the matching rebuild from **Settings → Maintenance** (see [Maintenance](/docs/guides/maintenance)).

## Settings → Processing (admins)

Admins get a **Processing** tab under Administration with three sections:

- **Live**: everything queued or running now, with step, progress, who started it and how long it has been running.
- **Last 24 hours**: everything that finished, with outcome, duration and, for failures, an error code.
- **Recent rebuilds**: the history of rebuilds started from the Maintenance tab (kept 30 days).

## For AI agents

Agents connected over MCP can call **`get_processing_status`** after a write and wait until nothing in flight affects the data they changed, before reading totals again. See [Use Bliss with Claude (MCP)](/docs/guides/using-bliss-with-claude-mcp).

## Privacy and cost

The status only records what kind of work ran, its step, progress, timings and a short error code. It never stores transaction descriptions, amounts or error messages. It lives in Redis next to the job queues for 24 hours, so showing it adds no load to your database.

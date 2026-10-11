# EU Bank Sync with Enable Banking

Plaid serves EU and UK customers only on Custom plans. For European banks, Bliss can sync accounts through [Enable Banking](https://enablebanking.com), a PSD2 account-information provider. Synced transactions land in the same **Transaction Review** queue as Plaid transactions, and go through the same AI classification, duplicate detection and approval.

Revolut (Spain) is the bank tested so far. The integration does not depend on a particular bank, but other banks have not been verified yet.

## What you need

- An Enable Banking account and an application in its [Control Panel](https://enablebanking.com/cp/).
- The application's **id** and its **RSA private key**.
- Your Bliss API reachable over https: the bank redirects your browser back to it.

## 1. Create the Enable Banking application

1. In the Control Panel, create an application in the **production** environment. Enable Banking generates a key pair: download the private key (`.pem`) and keep it safe. Enable Banking never sees it again.
2. Set the application's **redirect URL** to your API's callback:

   ```
   <NEXTAUTH_URL>/api/enablebanking/callback
   ```

   For example `https://api.bliss.example.com/api/enablebanking/callback`. It must match exactly: https, the same host as `NEXTAUTH_URL`, and no trailing slash. Do not use the API root; it redirects to the sign-in page and loses the authorisation code. If your callback has to live elsewhere, set `ENABLE_BANKING_REDIRECT_URL` to the same value.
3. **Restricted mode.** A new production application starts in *restricted* mode, which is free for the application owner's own accounts. In that mode, every bank account must first be **linked in the Control Panel** (Applications → your app → *Link accounts*) by its holder. Accounts that are not linked there are not returned to Bliss. Leaving restricted mode needs a commercial agreement with Enable Banking and is out of scope here.

## 2. Configure Bliss

Add these to `.env` on **both** the API and the backend worker:

```env
ENABLE_BANKING_APP_ID=50de91f2-…           # your application id
ENABLE_BANKING_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n…\n-----END PRIVATE KEY-----\n"
# or: ENABLE_BANKING_PRIVATE_KEY_PATH=/run/secrets/enablebanking.pem
```

Restart both services. **Accounts** now shows **Connect EU bank (Enable Banking)** next to the Plaid button. When the variables are missing, nothing changes and the option stays hidden.

Optional settings:

| Variable | Default | Meaning |
|---|---|---|
| `ENABLE_BANKING_SYNC_TIMES` | `06:15,13:15,20:15` | Automatic sync times (Madrid time). |
| `ENABLE_BANKING_DAILY_BUDGET` | `4` | How many times a day Bliss may read each account. PSD2 usually allows 4 unattended reads per day. The default schedule uses 3, so one manual **Sync now** remains. |

Never commit the private key. Bliss never logs it, never sends it to the browser, and strips it from error reports.

## 3. Connect a bank

1. **Accounts → Connect EU bank (Enable Banking)**, then choose your bank. Only banks in your workspace's countries are listed.
2. Bliss shows the date the first import starts from: today minus your **history days** setting (Settings → AI Classification). Check it before you continue.
3. You are sent to the bank. Approve access and select the accounts to share.
4. Back in Bliss, the mapping dialog lists each shared account:
   - Bliss pre-selects the **existing** account whose number ends in the same four digits (and has the same currency).
   - Choose **Create new account** only if you really want a new one. Bliss never creates an account unless you ask it to.
   - Choose **Don't sync** to leave a bank account out.
5. Confirm. The first sync starts right away, and new transactions appear in **Transaction Review**.

Access lasts as long as the bank allows: 180 days for Revolut Spain. Bliss requests the maximum minus one day.

## Syncing and limits

- Bliss syncs automatically at the configured times. Each sync re-reads the last 7 days, so transactions that the bank books late are still picked up. Transactions Bliss already has are skipped.
- Only **booked** transactions are imported. Pending card payments appear once the bank books them.
- **Sync now** on the connection card counts against the same daily budget. When the budget is spent, Bliss tells you when it resets (midnight, Madrid time).
- If the bank answers "too many requests", Bliss waits for the next scheduled time. You don't need to do anything.
- Every sync writes a sync log entry: fetched, added, skipped, pending, duplicates and errors. The connection card also shows the latest balance the bank reported, so you can reconcile it against your banking app.

## Consent renewal

- The connection card shows the access expiry date.
- The person who authorised the connection gets a notification 14 days and 3 days before it expires, and again once it has expired.
- **Reconnect** on the card (available only to that person) runs the same bank approval again. The new access attaches to the **same** connection and the same Bliss accounts: there is no mapping step, no new accounts and no duplicate history. Syncing resumes from 7 days before the last successful sync.
- **Disconnect** ends the access at Enable Banking and stops syncing. Your accounts and imported transactions stay in Bliss, and a later reconnect picks up where it left off.

## Joint accounts

Authorise a joint account under **one** holder only. For example, with a joint account between two partners, one partner shares it; the other partner, in their own bank approval, shares only their personal account. If the same bank account ever arrives through a second consent, Bliss refuses to map it again and explains why. One bank account can only feed one Bliss account, so the same purchase can never be imported twice.

Each person connects their own consent, on their own device and signed in to their own Bliss user. Expiry reminders go to the person who authorised the connection.

## Moving accounts from Plaid to Enable Banking

When a Bliss account is still linked to Plaid and you map an Enable Banking account to it, Bliss asks you to confirm the switch:

- The **same** Bliss account is kept. Its id, transactions, analytics and portfolio history do not change.
- Plaid stops syncing it. Once a Plaid connection has no linked accounts left, it is paused.
- From then on, only Enable Banking feeds the account.

Before you switch:

1. **Review or skip** any Plaid transactions for these accounts that are still waiting in Transaction Review.
2. **Set history days so the first import starts the day after your last good Plaid transaction.** History days counts back from the day you connect. For example, if Plaid's last complete day was 2026-10-10:
   - connecting on 2026-10-11 → history days **1** (imports from 2026-10-10);
   - connecting on 2026-10-15 → history days **5** (imports from 2026-10-10).

   A value that is too small leaves a gap. A larger window is safe only if Plaid stopped delivering and Bliss has no other transactions in those days.
3. If you imported a bank statement for any of those days in the meantime, delete those rows first, or reject the overlaps in Transaction Review.

On the boundary day, transactions Bliss already has from Plaid are recognised and marked as duplicates (the sync log reports how many). Transactions Plaid missed come in as new review items. Enable Banking descriptions are the bank's raw text (for example "Sq *giro Bar" rather than Plaid's cleaned "Giro Bar"), and the classifier handles them like imported transactions.

## Checking the result (shadow period)

For the first two weeks, compare Bliss with your bank:

1. Export each account's statement (CSV) from your banking app for the period.
2. Compare it with the account's transactions in Bliss, plus anything still waiting in Transaction Review.
3. Expect no missing and no duplicate booked transactions, and the latest balance on the connection card to match the bank.
4. In the sync logs, almost every run should be successful. A few rate-limited runs are normal.

## Troubleshooting

| You see | What it means |
|---|---|
| "The link to your bank expired or was already used" | The approval took longer than 15 minutes, or the page was reloaded. Start again from **Connect EU bank**. |
| "You cancelled at the bank" | The bank reported that access was not granted. |
| "Already synced through another connection" | That bank account is already mapped through someone else's consent. See [Joint accounts](#joint-accounts). |
| The bank list is empty | Add the bank's country to your workspace (Settings), and check that the app id and key are set on the API. |
| Needs to be re-connected | Access expired or was revoked at the bank. Use **Reconnect**. |

## Related

- [Bank Sync with Plaid](/docs/guides/plaid-bank-sync)
- [AI classification](/docs/guides/ai-classification)
- [Importing transactions](/docs/guides/importing-transactions) — statement imports for banks without sync

# EU Bank Sync with Enable Banking

Plaid serves EU and UK customers only on Custom plans. For European banks, Bliss can sync accounts through [Enable Banking](https://enablebanking.com), a PSD2 account-information provider. Synced transactions land in the same **Transaction Review** queue as Plaid transactions, and go through the same AI classification, duplicate detection and approval.

Revolut (Spain) is the bank tested so far. The integration does not depend on a particular bank, but other banks have not been verified yet.

## How it works: one Enable Banking app per workspace

Each Bliss workspace connects through **its own** Enable Banking application. A free application runs in *restricted mode*: it can link up to **5 bank accounts**, and only accounts its owner linked in the Enable Banking Control Panel. With one application per workspace, every household on a shared Bliss server gets its own 5 accounts, and nobody's bank data goes through somebody else's application.

A workspace **admin** sets the application up in **Settings → Bank sync**. No server restart and no operator help are needed. Members never see the credentials; they connect and map their own accounts once the admin has set it up.

## What you need

- An Enable Banking account (free) and access to its [Control Panel](https://enablebanking.com/cp/).
- To be an **admin** of your Bliss workspace.
- The Bliss server reachable over https, because the bank redirects your browser back to it.

## 1. Create your Enable Banking application

1. In the Control Panel, create an application in the **production** environment (sandbox applications are not supported). Enable Banking generates a key pair: **download the private key** (`.pem` file) and keep it safe. Enable Banking never shows it again.
2. Copy the **callback URL** from **Settings → Bank sync** in Bliss and add it as the application's **redirect URL**. It looks like this:

   ```
   https://api.bliss.example.com/api/enablebanking/callback
   ```

   It must match exactly: https, no trailing slash. The URL is the same for every workspace on the server.
3. **Link your accounts.** In restricted mode, every bank account must first be **linked in the Control Panel** (Applications → your app → *Link accounts*) by its holder. Accounts that are not linked there are not returned to Bliss. The limit is 5 linked accounts per application. Leaving restricted mode needs a commercial agreement with Enable Banking and is out of scope here.

## 2. Enter the credentials in Bliss

You can do this in the first-run wizard or later in Settings. Both use the same form and the same checks.

### Setting up during onboarding

1. In step 2 (*Connect your accounts*), choose **Set up EU bank sync** on the **Enable Banking — EU banks** card.
2. The dialog lists what you need, shows the **callback URL** to register on your application, and asks for the **Application id** and the **private key**, exactly as in steps 2–4 below.
3. Click **Save and verify**. When Enable Banking confirms the credentials, the bank picker opens straight away: pick your bank and click **Continue to bank** (see [3. Connect a bank](#3-connect-a-bank)). Leaving for the bank completes onboarding; after consent you land on **Accounts** to map the accounts.
4. If verification could not run (Enable Banking unreachable), the credentials are saved as **Not verified** and the dialog closes. The card then reads **Connect EU bank**, and you can start the connection when you're ready, or choose Plaid or a spreadsheet instead.

Closing the dialog at any point changes nothing else. Saving credentials alone does not finish onboarding.

### Setting up in Settings → Bank sync

1. Open **Settings → Bank sync** (admins only).
2. Enter the **Application id** (a UUID such as `6f0c1a2b-3c4d-4e5f-8a9b-0c1d2e3f4a5b`).
3. **Upload the `.pem` file** (drop it on the box or use *Choose file*). If you only have the key as text, choose **Paste instead** and paste it whole, including the `-----BEGIN … PRIVATE KEY-----` and `-----END … PRIVATE KEY-----` lines. Windows line endings and a key written on one line with `\n` escapes (as in a `.env` file) are accepted too.
4. Bliss checks the key straight away and shows *Valid RSA private key · 2048-bit* (or 4096-bit), or what is wrong with it: a public key or certificate instead of the private key, a password-protected key, a non-RSA key, or a paste missing its last line.
5. Click **Save and verify**. Bliss asks Enable Banking whether the application id and key belong together:
   - **Verified**: you're done. **Accounts** now shows **Connect EU bank (Enable Banking)** for everyone in the workspace.
   - **Rejected**: nothing is saved. Check that the key belongs to this application.
   - **Enable Banking unreachable**: the credentials are saved as **Not verified**. Use **Re-verify** later.

After saving, the key leaves the page. Bliss stores it encrypted, never shows it again and never logs it. The tab shows a **key fingerprint** (`SHA256:…`) so you can tell which key is installed. The tab also shows how many accounts are linked out of 5, and a history of the last 10 changes (who set, replaced, rotated or removed the credentials, and when).

### Changing or removing the credentials

- **New key, same application** (key rotation): choose **Replace credentials**, keep the application id and upload the new file. Connections keep syncing.
- **Different application**: Bliss tells you how many connections will stop and asks you to confirm. Those connections then need a **Reconnect** by the person who authorised them. The reconnect lands on the same connection and the same Bliss accounts, with no mapping step and no duplicate history.
- **Remove**: after a confirmation, every connection is **paused**. Accounts, mappings and imported transactions are kept. Saving the same application again later resumes them.

If Enable Banking starts rejecting the credentials during a sync (for example because the application was deleted), the tab shows **Invalid** and every admin gets a "Enable Banking credentials need attention" notification. Scheduled syncs wait until you **Re-verify** or replace the credentials.

### Server settings (operators)

The schedule and the daily budget are set for the whole server, on **both** the API and the backend worker:

| Variable | Default | Meaning |
|---|---|---|
| `ENABLE_BANKING_SYNC_TIMES` | `06:15,13:15,20:15` | Automatic sync times (Madrid time). |
| `ENABLE_BANKING_DAILY_BUDGET` | `4` | How many times a day Bliss may read each account. PSD2 usually allows 4 unattended reads per day. The default schedule uses 3, so one manual **Sync now** remains. |
| `ENABLE_BANKING_REDIRECT_URL` | `<NEXTAUTH_URL origin>/api/enablebanking/callback` | Only if the callback has to live elsewhere. |

### Upgrading from the server-wide setup

Before this release, Enable Banking used one application for the whole server, set through `ENABLE_BANKING_APP_ID` and `ENABLE_BANKING_PRIVATE_KEY` (or `ENABLE_BANKING_PRIVATE_KEY_PATH`). Those variables are **no longer read**. If they are still set, both services log a warning at startup.

1. Deploy. Existing connections show **Paused: credentials missing**. Nothing is deleted or changed.
2. **Straight after deploying**, an admin of the workspace that owns those connections opens **Settings → Bank sync** and saves the **same** application id and key. Upload the original `.pem`, or paste the value from your `.env` (the `\n`-escaped single line is accepted).
3. The connections resume at the next scheduled time, or with **Sync now**, without a reconnect. The first sync re-reads from 7 days before the last successful one, so the paused days are imported with no duplicates.
4. Remove the old variables from both services and restart them; the warning disappears.

A pause longer than 7 days leaves a gap that the sync will not fill, so do step 2 right after deploying.

## 3. Connect a bank

1. **Accounts → Connect EU bank (Enable Banking)**, then choose your bank. Only banks in your workspace's countries are listed.
2. Bliss shows the date the first import starts from: today minus your **history days** setting (Settings → AI Classification). Check it before you continue.
3. You are sent to the bank. Approve access and select the accounts to share.
4. Back in Bliss, the mapping dialog lists each shared account:
   - Bliss pre-selects the **existing** account whose number ends in the same four digits (and has the same currency). A bank account with no match starts as **Don't sync**.
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
| "The connection link expired or was already used" | The approval took longer than 15 minutes, or the page was reloaded. Start again from **Connect EU bank**. |
| "Access was not granted at your bank" | You cancelled, or the bank refused access. Nothing was connected. |
| "Your bank didn't confirm the connection" | The bank's confirmation failed. Try again in a few minutes. |
| "Already synced through another person's connection" | That bank account is already mapped through someone else's consent. See [Joint accounts](#joint-accounts). |
| A "Map accounts" banner on Accounts | A connection was approved but none of its accounts are mapped yet. Open it and choose where each account syncs. |
| The bank list is empty | Add the bank's country to your workspace (Settings). Only accounts linked in the Enable Banking Control Panel are returned. |
| **Set up EU bank sync** instead of the connect button | Your workspace has no Enable Banking credentials yet. An admin adds them in **Settings → Bank sync**. |
| **Paused: credentials missing** on a connection | The workspace's credentials were removed (or never saved after the upgrade). An admin saves them again; nothing needs reconnecting if it is the same application. |
| **Invalid** on the Bank sync tab | Enable Banking rejected the credentials. Check the application still exists in the Control Panel, then **Re-verify** or replace them. |
| "Enable Banking isn't set up for your workspace" after the bank | The credentials were removed while you were at the bank. Ask an admin to add them, then connect again. |
| Needs to be re-connected | Access expired or was revoked at the bank. Use **Reconnect**. |

## Related

- [Bank Sync with Plaid](/docs/guides/plaid-bank-sync)
- [AI classification](/docs/guides/ai-classification)
- [Importing transactions](/docs/guides/importing-transactions) — statement imports for banks without sync

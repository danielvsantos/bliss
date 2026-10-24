# eToro Copy Trading

If you copy other investors on eToro (CopyTrader), Bliss can follow each copy for you:
- **Value.** The copy's value is updated every night from eToro, so you no longer type it in by hand.
- **Composition.** The copy is split by sector, country and asset class on the **Equity Analysis** page, the same way an ETF is looked through.

Bliss reads your copies with a **Read key** from your own eToro account. It never places trades and never creates, changes or suggests transactions: the deposits you record yourself stay your cost basis.

## What you need

- An eToro account with at least one copy.
- To be an **admin** of your Bliss workspace.
- The Bliss account where you record your eToro copies (for example an account named "eToro").

## 1. Create a Read key in eToro

1. In eToro, open **Settings → Trading → API Key Management** and create a new key.
2. Choose **Read** access only. Bliss refuses any key that can trade, and shows which scope it found.
3. Set an **expiry date**. When the key expires, Bliss shows "Needs a new key" and you replace it in one step without losing data.
4. Leave the **IP whitelist empty** if your Bliss instance is hosted, since its outgoing address can change. On a self-hosted server with a fixed address you may restrict the key to that address.
5. Copy both values eToro shows: the **API key** and the **user key**.

**Never paste or share the key anywhere else.** Bliss stores it encrypted, shows only its last 4 characters, and never sends it back to your browser. Each workspace uses its own key. Bliss never uses a shared or operator key, and data fetched with your key is used for your workspace only.

## 2. Connect eToro in Bliss

1. Open **Settings → Bank sync** and scroll to **eToro copy trading**.
2. Click **Connect eToro**, paste the API key and the user key, and choose the **Bliss account** where you record your copies.
3. Bliss checks the key with eToro. If it's accepted, you see your eToro username and the list of your copies (copied investor and current value).

The first sync starts right away. After that, Bliss syncs every night at 03:30 UTC, before the nightly revaluation. **Sync now** refreshes a connection on demand, at most once every 15 minutes.

You can connect several eToro accounts, each mapped to one Bliss account. You can't connect the same eToro account twice.

## 3. Record each copy as a Copy Trading holding

Bliss puts a copy's value on a **Copy Trading** holding. It matches the copy to a holding when:
- the holding is in the **Copy Trading** category (group "Funds");
- the holding is in the Bliss account you chose for the connection;
- the holding's **ticker is the copied investor's eToro username** (for example `topinvestor`). Capital letters and a leading `@` don't matter.

There are two ways to set this up.
- **New copy:** add a transaction in the **Copy Trading** category in that account, with the investor's username in the **eToro username** field and the amount you put into the copy. There is no price or quantity to fill in: each deposit is your cost, and eToro supplies the value.
- **Copy you already track as a Fund:** connect eToro first. Then in **Manage Assets**, open the holding's menu and choose **Switch to Copy Trading**, and pick the investor from the list of your copies (Bliss preselects the one whose username appears in the holding's name). The holding keeps all its transactions, income terms and history. If you haven't connected eToro, you can type the username instead.

Keep recording your own deposits into (and withdrawals from) a copy as you do today. Bliss uses them as the cost basis, and eToro's value as the market value. A withdrawal reduces the cost basis in proportion to the amount taken out.

Each copy in **Settings → Bank sync** shows whether it is **linked** to a holding.

## What you see

- **Portfolio** holdings show a badge on each Copy Trading holding:
  - **Linked to eToro**: values are coming in.
  - **eToro key needs replacing**: the key expired or was revoked. Click **Replace key** in Settings. The holding keeps its last value meanwhile.
  - **Copy closed on eToro**: you stopped the copy. The holding keeps its last eToro value.
  - **Not linked to eToro**: no copy matches the holding yet. It behaves as a manual fund.
- **History.** Values start on the day you connect. History before that stays as Bliss already had it.
- **Equity Analysis** with **Look through** on:
  - **Holdings and Top 10:** each linked copy is replaced by the stocks, ETFs, crypto and cash it holds, valued at its share of the copy. A stock you also hold directly stays one row, with "incl. … via @investor" showing the copy's part; one held only through copies is marked "via @investor". Above the table, each copy shows its value and how many positions it was split into.
  - **Sector and country views:** the copy's holdings go to their own sectors and countries. An ETF inside a copy is split further by its own sectors and countries.
  - **Asset-class view:** the copy is split into stocks, ETFs, crypto, cash and so on.
  - With **Look through** off, the copy is one "Diversified" row.
- **P/E and dividend yield** of a copy are averages over the holdings Bliss has data for, labelled "based on N% of value". A stock Bliss has no company data for yet is listed with sector "Unknown". Holdings Bliss can't identify at all (for example some Gulf listings) are one "Unidentified" row, and the copy shows the unidentified share.
- **Passive Income** projects no cash income for copies: eToro pays dividends inside the copy, where they raise its value.
- AI agents connected through MCP see the same split in `get_equity_analysis`.

Bliss refreshes company data for stocks you hold only inside copies once a week, so the split fills in over the first days or weeks after you connect.

## Removing a connection

**Remove** stops the updates and deletes the key from Bliss. Your Copy Trading holdings and their history stay. Connecting the same eToro account again picks up where it left off. You can also delete the key in eToro (Settings → Trading → API Key Management).

## Limits

- Only your **copies** are followed. Direct eToro positions, cash, dividends, fees and deposits are not imported: record them as today, or import an eToro statement.
- eToro allows 60 requests per minute per key. A sync uses about four, and Bliss paces itself.

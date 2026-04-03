# Investment Portfolios

Bliss tracks investment holdings with FIFO lot calculation, multi-currency PnL, and real-time pricing.

## How it works

When you import or create buy/sell transactions with a `ticker` symbol, the portfolio pipeline processes them automatically:

1. **Portfolio initialization** — Creates or updates portfolio items for each ticker
2. **FIFO lot calculation** — Each buy creates a lot; sells consume the oldest lots first
3. **FX rate capture** — Each lot records the buy-date exchange rate for accurate cross-currency PnL
4. **Valuation** — Current prices fetched via a 4-stage waterfall: memory cache, live API, 7-day DB lookback, manual value fallback

The pipeline runs automatically whenever transactions change, triggered by the event-driven architecture.

## Setting up investment accounts

Investment accounts work like any other account but hold transactions with ticker data. You can:

- Create them via the UI (**Accounts** > **Add Manual Account**)
- Include them in your [tenant seed script](/docs/guides/tenant-seed-setup)
- Import transactions with ticker data via [Bliss Native CSV](/docs/guides/importing-transactions#bliss-native-csv-format)

## Importing investment transactions

The key columns for investment transactions in the Bliss Native CSV format:

```csv
transactiondate,description,debit,credit,account,category,ticker,assetquantity,assetprice,currency
2024-01-15,Buy AAPL,5000,,Schwab,Stocks,AAPL,25,200,USD
2024-03-20,Sell AAPL,,3200,Schwab,Stocks,AAPL,10,320,USD
2024-06-01,Buy VWCE,2000,,Revolut Investment (EUR),ETFs,VWCE.DEX,15,133.33,EUR
```

When a `ticker` is present, Bliss automatically looks up the security metadata from Twelve Data (name, exchange, type).

## Portfolio dashboard

The portfolio page shows total value, asset allocation, and holdings grouped by type.

![Portfolio holdings page](/images/portfolio.png)

**Supported asset types:** Stocks, ETFs, Crypto, Bonds, Real Estate, Private Equity, Pension Plans, and more.

## Enabling live prices

For real-time stock pricing, add a Twelve Data API key:

```env
TWELVE_DATA_API_KEY=your_api_key
STOCK_PROVIDER=twelvedata
```

Without an API key, the portfolio still works — it uses the last known price from your transactions or manual value updates.

## Manual value assets

For assets without live pricing (real estate, private equity), use manual value updates in the portfolio page. These are captured as point-in-time valuations.

## Next steps

- [Bank sync with Plaid](/docs/guides/plaid-bank-sync) — automatic investment account sync
- [AI classification](/docs/guides/ai-classification) — how transactions are categorized

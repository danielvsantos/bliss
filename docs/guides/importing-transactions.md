# Importing Transactions

Bliss supports CSV and XLSX imports with automatic format detection, AI classification, and deduplication.

## The Smart Import flow

1. **Upload** — Drag a CSV/XLSX file into the import page and select a destination account.
2. **Processing** — The backend detects the file format, deduplicates against existing transactions (date-range-scoped SHA-256 hash), and classifies each row with the [4-tier AI pipeline](/docs/guides/ai-classification).
3. **Review** — Inspect classifications, correct any mistakes, and approve rows.
4. **Commit** — Confirmed rows become transactions. Corrections feed back into the AI model.

![Smart Import upload step](/images/smartimport.png)

## File format detection

Bliss matches your file's column headers against known adapter signatures. If a match is found, it auto-maps columns. If not, you create a custom adapter.

### Creating a custom adapter

Click **Import Adapters** on the import page to open the adapter manager. Define:

- **Match Headers** — comma-separated column names that identify this format (e.g., `Date, Description, Amount`)
- **Date / Description / Amount columns** — map to your file's headers
- **Amount strategy** — `SINGLE_SIGNED` (one column, negative = debit) or `DEBIT_CREDIT_COLUMNS` (separate columns)
- **Date format** — e.g., `DD/MM/YYYY`, `YYYY-MM-DD`, `MM-DD-YYYY`
- **Default currency** — applied when the file doesn't include a currency column

![Adapter creation dialog](/images/smartimportadapter.png)

Adapters are saved per-tenant and reused automatically on future imports.

## Bliss Native CSV format

For maximum control, prepare your data in the Bliss Native format. This bypasses adapter detection and supports all fields including investments and tags.

**Required columns:**

| Column | Description |
|--------|-------------|
| `transactiondate` | Date in `YYYY-MM-DD` format |
| `description` | Transaction description |
| `debit` or `credit` | Amount (at least one required) |
| `account` | Account name (must match an existing account) |
| `category` | Category name (must match an existing category) |

**Optional columns:**

| Column | Description |
|--------|-------------|
| `currency` | ISO code (e.g., `USD`, `EUR`). Defaults to account currency |
| `details` | Additional notes |
| `ticker` | Stock/ETF symbol — triggers investment metadata lookup |
| `assetquantity` | Number of shares/units |
| `assetprice` | Price per unit |
| `tags` | Comma-separated tags (e.g., `vacation,2024`) |

**Example:**

```csv
transactiondate,description,debit,credit,account,category,currency,ticker,assetquantity,assetprice,tags
2024-06-15,AAPL Purchase,5000,,Schwab,Stocks,USD,AAPL,25,200,
2024-06-15,Salary,,8500,Revolut Daniel,Salary,EUR,,,,"income,june"
2024-06-16,Grocery Store,45.80,,Nubank,Groceries,BRL,,,,
```

With Native CSV, rows skip AI classification entirely — accounts and categories are resolved by name.

## Review and commit

After processing, review the staged rows. The AI assigns a category and confidence score to each row. You can:

- **Accept** individual rows or in bulk
- **Override** the category with a correction (this trains the AI for future imports)
- **Skip** duplicates or irrelevant rows

![Transaction review with AI drawer](/images/transactionreviewdrawer.png)

Rows with confidence above your `autoPromoteThreshold` (default 0.90) are auto-confirmed.

## Next steps

- [Investment portfolios](/docs/guides/investment-portfolios) — how investment transactions are processed after import
- [AI classification](/docs/guides/ai-classification) — understand the 4-tier pipeline

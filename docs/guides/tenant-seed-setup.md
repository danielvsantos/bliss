# Initial Account Setup

When you first set up Bliss, you need to create the accounts, banks, and currencies that reflect your financial reality. You can do this one by one through the UI, ask Claude to do it for you over MCP, or use the bulk seed script to set everything up at once.

## Let Claude create your banks and accounts

With a **Read & write** MCP connection ([Use Bliss with Claude](/docs/guides/using-bliss-with-claude-mcp)), Claude can create banks and **manual** accounts for you — no need to add them in the app first. Tell it what you hold, for example *"I bank with Revolut (EUR and GBP accounts) and Schwab (USD) — set them up"*, and it uses the `create_bank` and `create_account` tools. A few things to know:

- **Currencies and countries** must be enabled for your workspace first (**Settings**, or the seed script below). Claude tells you when one is missing.
- **Account numbers** are stored encrypted and never shown back — only the last 4 characters. A short label works too.
- **Owners** default to the admin who connected Claude; add other owners in the app.
- **Asking twice is safe**: an existing bank is reused, and a second account with the same bank, currency and name is refused with the existing account's ID.
- Renaming or deleting accounts, and bank-synced (Plaid) connections, stay in the app.

## Global reference data (seeded automatically)

The global seed (`prisma/seed.js`) runs automatically during Docker setup or `prisma db seed`. It populates shared reference data that all tenants can use:

- **16 countries** — US, UK, Germany, France, Spain, Portugal, Brazil, Canada, Australia, Japan, Switzerland, Mexico, Italy, Netherlands, Singapore, India
- **11 currencies** — USD, EUR, GBP, BRL, CAD, AUD, JPY, CHF, MXN, SGD, INR
- **30 banks** — Major banks across US (Chase, Bank of America, Citi, Capital One, Amex, Discover, US Bank, Schwab, Fidelity), UK (HSBC, Barclays, Lloyds, Monzo, Santander UK), Spain (BBVA, CaixaBank, Santander), France (Boursorama, Credit Agricole), EU (N26, Revolut, Wise, Deutsche Bank), Brazil (Nubank, Itau), Canada (RBC, TD Canada), Australia (ANZ, Commonwealth Bank), and brokerages (Interactive Brokers)
- **32 import adapters** — Preconfigured CSV column mappings for the banks above (plus generic fallbacks and a Bliss Native format). These enable automatic format detection when importing transactions via CSV. See [Importing transactions](/docs/guides/importing-transactions) for the full list.

**If your country, currency, or bank isn't listed**, add it to `prisma/seed.js` and re-run `pnpm exec prisma db seed`. The seed is idempotent — existing records are updated in place, and new entries are created without affecting existing data.

## What the tenant seed script does

`apps/api/scripts/seed-tenant-setup.mjs` is an idempotent Node.js script that creates:

- **Countries** your accounts operate in
- **Currencies** you use
- **Banks** you hold accounts with
- **Accounts** linked to their bank, country, and currency
- **Custom categories** beyond the default set

Existing records are skipped — safe to run multiple times.

## Customize the seed data

Edit the `SEED_DATA` object in the script. Here's a trimmed example:

```javascript
const SEED_DATA = {
  countries: [
    { id: 'USA', iso2: 'US', name: 'United States', emoji: '🇺🇸', isDefault: true },
    { id: 'ESP', iso2: 'ES', name: 'Spain', emoji: '🇪🇸' },
    { id: 'BRA', iso2: 'BR', name: 'Brazil', emoji: '🇧🇷' },
  ],

  currencies: [
    { id: 'USD', name: 'US Dollar', symbol: '$', isDefault: true },
    { id: 'EUR', name: 'Euro', symbol: '€' },
    { id: 'BRL', name: 'Brazilian Real', symbol: 'R$' },
  ],

  banks: [
    { name: 'Chase' },
    { name: 'Charles Schwab' },
    { name: 'Revolut' },
  ],

  accounts: [
    { name: 'Chase Checking', accountNumber: '****4821', bank: 'Chase', country: 'USA', currency: 'USD' },
    { name: 'Schwab Brokerage', accountNumber: '****7053', bank: 'Charles Schwab', country: 'USA', currency: 'USD' },
    { name: 'Revolut Personal', accountNumber: 'ES12XXXX0001XXXX1234XX', bank: 'Revolut', country: 'ESP', currency: 'EUR' },
  ],

  categories: [
    { name: 'Coworking', group: 'Productivity', type: 'Growth', icon: '💼', processingHint: 'coworking space membership or day pass' },
  ],
};
```

**Tips:**
- `isDefault: true` on a country/currency sets it as the tenant's default.
- Account numbers are encrypted at rest automatically.
- Category `type` must be one of: `Income`, `Essentials`, `Lifestyle`, `Growth`, `Investments`, `Debt`, `Transfers`.

## Run the seed

```bash
# Preview what would be created (no changes)
node apps/api/scripts/seed-tenant-setup.mjs --dry-run <tenantId>

# Execute
node apps/api/scripts/seed-tenant-setup.mjs <tenantId>
```

Find your `tenantId` in the database (`Tenant` table) or from the API response after signup.

## Setting up accounts in the app

You don't need the seed script to get started. Everything below works from the UI.

- **During onboarding**, the account step lets you pick the banks you use (up to 5) and declare up to 3 accounts per bank, each with its own currency. Bliss creates them as ordinary accounts with a placeholder number such as `chase-acc-1`. They work everywhere straight away, and the account's detail panel shows a hint to **add the real account number** whenever you're ready. If you skip the step, nothing is created.
- **Adding a bank later**: in the **Add Account** form, open the **Bank** dropdown and choose **Add bank** at the bottom. A small dialog creates the bank without leaving the form, which also unblocks account creation if you started with no banks. You can also manage banks from **Settings → Banks**.
- **Deleting an account**: open the account on the **Accounts** page and use **Delete** in the Danger Zone card. Bliss blocks it while the account still has transactions (it tells you how many), or while it is linked to a live Plaid connection, in which case disconnect the bank first. Investment holdings tied to a deleted account are kept, just no longer linked to it.

## Managing categories

Beyond the seed script, you can manage categories through the UI at any time.

![Categories page](/images/categories.png)

The default set includes ~70 categories across Income, Essentials, Lifestyle, Growth, and more. Custom categories created via the seed script or UI appear alongside the defaults.

## Next steps

- [Import transactions](/docs/guides/importing-transactions) — bring in your history via CSV
- [Investment portfolios](/docs/guides/investment-portfolios) — set up investment tracking

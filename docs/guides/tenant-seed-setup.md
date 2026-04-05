# Initial Account Setup

When you first set up Bliss, you need to create the accounts, banks, and currencies that reflect your financial reality. You can do this one by one through the UI, or use the bulk seed script to set everything up at once.

## What the seed script does

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
    { id: 'BRA', iso2: 'BR', name: 'Brazil', emoji: '🇧🇷', isDefault: true },
    { id: 'ESP', iso2: 'ES', name: 'Spain', emoji: '🇪🇸' },
    { id: 'USA', iso2: 'US', name: 'United States', emoji: '🇺🇸' },
  ],

  currencies: [
    { id: 'BRL', name: 'Brazilian Real', symbol: 'R$', isDefault: true },
    { id: 'EUR', name: 'Euro', symbol: '€' },
    { id: 'USD', name: 'US Dollar', symbol: '$' },
  ],

  banks: [
    { name: 'Revolut' },
    { name: 'Charles Schwab' },
    { name: 'Nubank' },
  ],

  accounts: [
    { name: 'Revolut Daniel', accountNumber: 'ES40...', bank: 'Revolut', country: 'ESP', currency: 'EUR' },
    { name: 'Schwab', accountNumber: '****XXXX', bank: 'Charles Schwab', country: 'USA', currency: 'USD' },
    { name: 'Nubank Daniel', accountNumber: '****XXXX', bank: 'Nubank', country: 'BRA', currency: 'BRL' },
  ],

  categories: [
    { name: 'Drugstore', group: 'Entertainment', type: 'Lifestyle', icon: '✨' },
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

## Managing categories

Beyond the seed script, you can manage categories through the UI at any time.

![Categories page](/images/categories.png)

The default set includes ~70 categories across Income, Essentials, Lifestyle, Growth, and more. Custom categories created via the seed script or UI appear alongside the defaults.

## Next steps

- [Import transactions](/docs/guides/importing-transactions) — bring in your history via CSV
- [Investment portfolios](/docs/guides/investment-portfolios) — set up investment tracking

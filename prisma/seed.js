/**
 * Prisma seed script — populates global reference data required for the app.
 *
 * Run manually:   pnpm exec prisma db seed
 * Runs in Docker:  automatically after `prisma migrate deploy`
 *
 * Idempotent — safe to run multiple times (uses upsert).
 */

const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

// ── Reference data ──────────────────────────────────────────────────────────

const COUNTRIES = [
  { id: 'USA', iso2: 'US', name: 'United States', emoji: '🇺🇸' },
  { id: 'GBR', iso2: 'GB', name: 'United Kingdom', emoji: '🇬🇧' },
  { id: 'DEU', iso2: 'DE', name: 'Germany', emoji: '🇩🇪' },
  { id: 'FRA', iso2: 'FR', name: 'France', emoji: '🇫🇷' },
  { id: 'ESP', iso2: 'ES', name: 'Spain', emoji: '🇪🇸' },
  { id: 'PRT', iso2: 'PT', name: 'Portugal', emoji: '🇵🇹' },
  { id: 'BRA', iso2: 'BR', name: 'Brazil', emoji: '🇧🇷' },
  { id: 'CAN', iso2: 'CA', name: 'Canada', emoji: '🇨🇦' },
  { id: 'AUS', iso2: 'AU', name: 'Australia', emoji: '🇦🇺' },
  { id: 'JPN', iso2: 'JP', name: 'Japan', emoji: '🇯🇵' },
  { id: 'CHE', iso2: 'CH', name: 'Switzerland', emoji: '🇨🇭' },
  { id: 'MEX', iso2: 'MX', name: 'Mexico', emoji: '🇲🇽' },
  { id: 'ITA', iso2: 'IT', name: 'Italy', emoji: '🇮🇹' },
  { id: 'NLD', iso2: 'NL', name: 'Netherlands', emoji: '🇳🇱' },
  { id: 'SGP', iso2: 'SG', name: 'Singapore', emoji: '🇸🇬' },
  { id: 'IND', iso2: 'IN', name: 'India', emoji: '🇮🇳' },
];

const CURRENCIES = [
  { id: 'USD', name: 'US Dollar', symbol: '$' },
  { id: 'EUR', name: 'Euro', symbol: '€' },
  { id: 'GBP', name: 'British Pound', symbol: '£' },
  { id: 'BRL', name: 'Brazilian Real', symbol: 'R$' },
  { id: 'CAD', name: 'Canadian Dollar', symbol: 'C$' },
  { id: 'AUD', name: 'Australian Dollar', symbol: 'A$' },
  { id: 'JPY', name: 'Japanese Yen', symbol: '¥' },
  { id: 'CHF', name: 'Swiss Franc', symbol: 'CHF' },
  { id: 'MXN', name: 'Mexican Peso', symbol: 'MX$' },
  { id: 'SGD', name: 'Singapore Dollar', symbol: 'S$' },
  { id: 'INR', name: 'Indian Rupee', symbol: '₹' },
];

const BANKS = [
  // US
  'Chase',
  'Bank of America',
  'Citi',
  'Capital One',
  'American Express',
  'Discover',
  'US Bank',
  'Charles Schwab',
  'Fidelity',
  // UK
  'HSBC',
  'Barclays',
  'Lloyds',
  'Monzo',
  'Santander UK',
  // EU — Spain
  'BBVA',
  'CaixaBank',
  'Santander',
  // EU — France
  'Boursorama',
  'Crédit Agricole',
  // EU — Other
  'N26',
  'Revolut',
  'Wise',
  'Deutsche Bank',
  // Brazil
  'Nubank',
  'Itaú',
  // Canada
  'RBC',
  'TD Canada',
  // Australia
  'ANZ',
  'Commonwealth Bank',
  // Brokerages
  'Interactive Brokers',
];

// ── Global import adapters ──────────────────────────────────────────────────
// Each adapter matches a bank's CSV export format by column headers.
// Adding a new bank? Just add an entry here and re-run `prisma db seed`.
//
// Fields:
//   name            — Display name (must be unique among global adapters)
//   matchSignature  — { headers: [...], isNative?: true }
//   columnMapping   — Maps CSV columns to Bliss fields (date, description, amount/debit/credit, etc.)
//   dateFormat      — Date parsing hint (MM/DD/YYYY, DD/MM/YYYY, YYYY-MM-DD, etc.)
//   amountStrategy  — SINGLE_SIGNED | SINGLE_SIGNED_INVERTED | DEBIT_CREDIT_COLUMNS | AMOUNT_WITH_TYPE
//   currencyDefault — Fallback ISO currency code (null = multi-currency, read from CSV)

const ADAPTERS = [
  // ── System adapters ─────────────────────────────────────────────────────
  {
    name: 'Bliss Native CSV',
    matchSignature: { headers: ['transactiondate', 'description', 'debit', 'credit'], isNative: true },
    columnMapping: { date: 'transactiondate', description: 'description', debit: 'debit', credit: 'credit', account: 'account', category: 'category', currency: 'currency', details: 'details', ticker: 'ticker', assetQuantity: 'assetquantity', assetPrice: 'assetprice', tags: 'tags' },
    dateFormat: null,
    amountStrategy: 'DEBIT_CREDIT_COLUMNS',
    currencyDefault: 'USD',
  },

  // ── Generic fallbacks (lowest specificity — fewest headers) ─────────────
  {
    name: 'Generic Signed Amount',
    matchSignature: { headers: ['date', 'description', 'amount'] },
    columnMapping: { date: 'date', description: 'description', amount: 'amount' },
    dateFormat: null,
    amountStrategy: 'SINGLE_SIGNED',
    currencyDefault: null,
  },
  {
    name: 'Generic 2-Column (Debit/Credit)',
    matchSignature: { headers: ['date', 'description', 'debit', 'credit'] },
    columnMapping: { date: 'date', description: 'description', debit: 'debit', credit: 'credit' },
    dateFormat: null,
    amountStrategy: 'DEBIT_CREDIT_COLUMNS',
    currencyDefault: null,
  },

  // ── US Banks ────────────────────────────────────────────────────────────
  {
    name: 'Chase CSV',
    matchSignature: { headers: ['Details', 'Posting Date', 'Description', 'Amount', 'Type', 'Balance', 'Check or Slip #'] },
    columnMapping: { date: 'Posting Date', description: 'Description', amount: 'Amount' },
    dateFormat: 'MM/DD/YYYY',
    amountStrategy: 'SINGLE_SIGNED',
    currencyDefault: 'USD',
  },
  {
    name: 'Bank of America CSV',
    matchSignature: { headers: ['Date', 'Description', 'Amount', 'Running Bal.'] },
    columnMapping: { date: 'Date', description: 'Description', amount: 'Amount' },
    dateFormat: 'MM/DD/YYYY',
    amountStrategy: 'SINGLE_SIGNED',
    currencyDefault: 'USD',
  },
  {
    name: 'Citi CSV',
    matchSignature: { headers: ['Status', 'Date', 'Description', 'Debit', 'Credit'] },
    columnMapping: { date: 'Date', description: 'Description', debit: 'Debit', credit: 'Credit' },
    dateFormat: 'MM/DD/YYYY',
    amountStrategy: 'DEBIT_CREDIT_COLUMNS',
    currencyDefault: 'USD',
  },
  {
    name: 'Capital One CSV',
    matchSignature: { headers: ['Transaction Date', 'Posted Date', 'Card No.', 'Description', 'Category', 'Debit', 'Credit'] },
    columnMapping: { date: 'Transaction Date', description: 'Description', debit: 'Debit', credit: 'Credit' },
    dateFormat: 'MM/DD/YYYY',
    amountStrategy: 'DEBIT_CREDIT_COLUMNS',
    currencyDefault: 'USD',
  },
  {
    name: 'American Express CSV',
    matchSignature: { headers: ['Date', 'Description', 'Amount'] },
    columnMapping: { date: 'Date', description: 'Description', amount: 'Amount' },
    dateFormat: 'MM/DD/YYYY',
    amountStrategy: 'SINGLE_SIGNED_INVERTED',
    currencyDefault: 'USD',
  },
  {
    name: 'Discover CSV',
    matchSignature: { headers: ['Trans. Date', 'Post Date', 'Description', 'Amount', 'Category'] },
    columnMapping: { date: 'Trans. Date', description: 'Description', amount: 'Amount' },
    dateFormat: 'MM/DD/YYYY',
    amountStrategy: 'SINGLE_SIGNED',
    currencyDefault: 'USD',
  },
  {
    name: 'US Bank CSV',
    matchSignature: { headers: ['Date', 'Transaction', 'Name', 'Memo', 'Amount'] },
    columnMapping: { date: 'Date', description: ['Transaction', 'Name'], amount: 'Amount', details: 'Memo' },
    dateFormat: 'MM/DD/YYYY',
    amountStrategy: 'SINGLE_SIGNED',
    currencyDefault: 'USD',
  },

  // ── UK Banks ────────────────────────────────────────────────────────────
  {
    name: 'HSBC UK CSV',
    matchSignature: { headers: ['Date', 'Description', 'Money In', 'Money Out', 'Balance'] },
    columnMapping: { date: 'Date', description: 'Description', credit: 'Money In', debit: 'Money Out' },
    dateFormat: 'DD/MM/YYYY',
    amountStrategy: 'DEBIT_CREDIT_COLUMNS',
    currencyDefault: 'GBP',
  },
  {
    name: 'Barclays UK CSV',
    matchSignature: { headers: ['Number', 'Date', 'Account', 'Amount', 'Subcategory', 'Memo'] },
    columnMapping: { date: 'Date', description: 'Memo', amount: 'Amount' },
    dateFormat: 'DD/MM/YYYY',
    amountStrategy: 'SINGLE_SIGNED',
    currencyDefault: 'GBP',
  },
  {
    name: 'Lloyds UK CSV',
    matchSignature: { headers: ['Transaction Date', 'Transaction Type', 'Sort Code', 'Account Number', 'Transaction Description', 'Debit Amount', 'Credit Amount', 'Balance'] },
    columnMapping: { date: 'Transaction Date', description: 'Transaction Description', debit: 'Debit Amount', credit: 'Credit Amount' },
    dateFormat: 'DD/MM/YYYY',
    amountStrategy: 'DEBIT_CREDIT_COLUMNS',
    currencyDefault: 'GBP',
  },
  {
    name: 'Monzo CSV',
    matchSignature: { headers: ['Date', 'Time', 'Type', 'Name', 'Emoji', 'Category', 'Amount', 'Currency', 'Local amount', 'Local currency', 'Notes and #tags'] },
    columnMapping: { date: 'Date', description: 'Name', amount: 'Amount', currency: 'Currency', category: 'Category' },
    dateFormat: 'DD/MM/YYYY',
    amountStrategy: 'SINGLE_SIGNED',
    currencyDefault: 'GBP',
  },
  {
    name: 'Santander UK CSV',
    matchSignature: { headers: ['Date', 'Description', 'Amount', 'Balance'] },
    columnMapping: { date: 'Date', description: 'Description', amount: 'Amount' },
    dateFormat: 'DD/MM/YYYY',
    amountStrategy: 'SINGLE_SIGNED',
    currencyDefault: 'GBP',
  },

  // ── EU Banks — Spain ────────────────────────────────────────────────────
  {
    name: 'BBVA Spain CSV',
    matchSignature: { headers: ['Fecha', 'Concepto', 'Movimiento', 'Importe', 'Divisa', 'Disponible'] },
    columnMapping: { date: 'Fecha', description: 'Concepto', amount: 'Importe', currency: 'Divisa' },
    dateFormat: 'DD/MM/YYYY',
    amountStrategy: 'SINGLE_SIGNED',
    currencyDefault: 'EUR',
  },
  {
    name: 'CaixaBank CSV',
    matchSignature: { headers: ['Fecha', 'Fecha valor', 'Concepto', 'Movimiento', 'Importe'] },
    columnMapping: { date: 'Fecha', description: 'Concepto', amount: 'Importe' },
    dateFormat: 'DD/MM/YYYY',
    amountStrategy: 'SINGLE_SIGNED',
    currencyDefault: 'EUR',
  },
  {
    name: 'Santander Spain CSV',
    matchSignature: { headers: ['Fecha', 'Concepto', 'Importe', 'Saldo'] },
    columnMapping: { date: 'Fecha', description: 'Concepto', amount: 'Importe' },
    dateFormat: 'DD/MM/YYYY',
    amountStrategy: 'SINGLE_SIGNED',
    currencyDefault: 'EUR',
  },

  // ── EU Banks — France ───────────────────────────────────────────────────
  {
    name: 'Boursorama CSV',
    matchSignature: { headers: ['dateOp', 'dateVal', 'label', 'category', 'categoryParent', 'supplierFound', 'amount', 'accountNum', 'accountLabel', 'accountBalance'] },
    columnMapping: { date: 'dateOp', description: 'label', amount: 'amount', category: 'category' },
    dateFormat: 'DD/MM/YYYY',
    amountStrategy: 'SINGLE_SIGNED',
    currencyDefault: 'EUR',
  },
  {
    name: 'Credit Agricole CSV',
    matchSignature: { headers: ['Date', 'Libelle', 'Debit euros', 'Credit euros'] },
    columnMapping: { date: 'Date', description: 'Libelle', debit: 'Debit euros', credit: 'Credit euros' },
    dateFormat: 'DD/MM/YYYY',
    amountStrategy: 'DEBIT_CREDIT_COLUMNS',
    currencyDefault: 'EUR',
  },

  // ── EU Banks — Other ───────────────────────────────────────────────────
  {
    name: 'N26 CSV',
    matchSignature: { headers: ['Date', 'Payee', 'Account number', 'Transaction type', 'Payment reference', 'Amount (EUR)'] },
    columnMapping: { date: 'Date', description: 'Payee', amount: 'Amount (EUR)', details: 'Payment reference' },
    dateFormat: 'YYYY-MM-DD',
    amountStrategy: 'SINGLE_SIGNED',
    currencyDefault: 'EUR',
  },
  {
    name: 'N26 CSV (2025+)',
    matchSignature: { headers: ['Booking Date', 'Value Date', 'Partner Name', 'Partner Iban', 'Type', 'Payment Reference', 'Account Name', 'Amount (EUR)', 'Original Amount', 'Original Currency', 'Exchange Rate'] },
    columnMapping: { date: 'Booking Date', description: 'Partner Name', amount: 'Amount (EUR)', details: 'Payment Reference', currency: 'Original Currency' },
    dateFormat: 'YYYY-MM-DD',
    amountStrategy: 'SINGLE_SIGNED',
    currencyDefault: 'EUR',
  },
  {
    name: 'Revolut CSV',
    matchSignature: { headers: ['Type', 'Product', 'Started Date', 'Completed Date', 'Description', 'Amount', 'Fee', 'Currency', 'State', 'Balance'] },
    columnMapping: { date: 'Completed Date', description: 'Description', amount: 'Amount', currency: 'Currency', fee: 'Fee', type: 'Type', state: 'State' },
    dateFormat: 'YYYY-MM-DD HH:mm:ss',
    amountStrategy: 'SINGLE_SIGNED',
    currencyDefault: null,
  },
  {
    name: 'Wise CSV',
    matchSignature: { headers: ['TransferWise ID', 'Date', 'Amount', 'Currency', 'Description', 'Payment Reference', 'Running Balance'] },
    columnMapping: { date: 'Date', description: 'Description', amount: 'Amount', currency: 'Currency', details: 'Payment Reference' },
    dateFormat: 'YYYY-MM-DD',
    amountStrategy: 'SINGLE_SIGNED',
    currencyDefault: null,
  },

  // ── Brazil ──────────────────────────────────────────────────────────────
  {
    name: 'Nubank CSV',
    matchSignature: { headers: ['date', 'title', 'amount'] },
    columnMapping: { date: 'date', description: 'title', amount: 'amount' },
    dateFormat: 'YYYY-MM-DD',
    amountStrategy: 'SINGLE_SIGNED',
    currencyDefault: 'BRL',
  },
  {
    name: 'Itau CSV',
    matchSignature: { headers: ['data', 'lancamento', 'ag./origem', 'valor (R$)'] },
    columnMapping: { date: 'data', description: 'lancamento', amount: 'valor (R$)' },
    dateFormat: 'DD/MM/YYYY',
    amountStrategy: 'SINGLE_SIGNED',
    currencyDefault: 'BRL',
  },

  // ── Canada ──────────────────────────────────────────────────────────────
  {
    name: 'RBC Canada CSV',
    matchSignature: { headers: ['Account Type', 'Account Number', 'Transaction Date', 'Cheque Number', 'Description 1', 'Description 2', 'CAD$', 'USD$'] },
    columnMapping: { date: 'Transaction Date', description: ['Description 1', 'Description 2'], amount: 'CAD$' },
    dateFormat: 'MM/DD/YYYY',
    amountStrategy: 'SINGLE_SIGNED',
    currencyDefault: 'CAD',
  },
  {
    name: 'TD Canada CSV',
    matchSignature: { headers: ['Date', 'Description', 'Withdrawals', 'Deposits', 'Balance'] },
    columnMapping: { date: 'Date', description: 'Description', debit: 'Withdrawals', credit: 'Deposits' },
    dateFormat: 'MM/DD/YYYY',
    amountStrategy: 'DEBIT_CREDIT_COLUMNS',
    currencyDefault: 'CAD',
  },

  // ── Australia ───────────────────────────────────────────────────────────
  {
    name: 'ANZ Australia CSV',
    matchSignature: { headers: ['Date', 'Amount', 'Description'] },
    columnMapping: { date: 'Date', description: 'Description', amount: 'Amount' },
    dateFormat: 'DD/MM/YYYY',
    amountStrategy: 'SINGLE_SIGNED',
    currencyDefault: 'AUD',
  },
  {
    name: 'Commonwealth Bank Australia CSV',
    matchSignature: { headers: ['Date', 'Amount', 'Description', 'Balance'] },
    columnMapping: { date: 'Date', description: 'Description', amount: 'Amount' },
    dateFormat: 'DD/MM/YYYY',
    amountStrategy: 'SINGLE_SIGNED',
    currencyDefault: 'AUD',
  },

  // ── Brokerages ──────────────────────────────────────────────────────────
  {
    name: 'eToro Closed Positions',
    matchSignature: { sheet: 'Closed Positions', headers: ['Position ID', 'Action', 'Close Rate', 'Open Rate', 'Units', 'Profit'] },
    columnMapping: { date: 'Close Date', description: ['Type', 'Action'], amount: 'Profit', ticker: ['ISIN', 'Notes'], openDate: 'Open Date' },
    dateFormat: 'DD/MM/YYYY HH:mm:ss',
    amountStrategy: 'SINGLE_SIGNED',
    currencyDefault: 'USD',
  },
  {
    name: 'Interactive Brokers Trades CSV',
    matchSignature: { headers: ['Currency', 'Symbol', 'Date/Time', 'Quantity', 'T. Price', 'Proceeds', 'Comm/Fee', 'Realized P/L'] },
    columnMapping: { date: 'Date/Time', description: 'Symbol', amount: 'Realized P/L', ticker: 'Symbol', assetQuantity: 'Quantity', assetPrice: 'T. Price', currency: 'Currency' },
    dateFormat: 'YYYY-MM-DD',
    amountStrategy: 'SINGLE_SIGNED',
    currencyDefault: 'USD',
  },
];

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log('Seeding reference data...\n');

  // Countries
  for (const c of COUNTRIES) {
    await prisma.country.upsert({
      where: { id: c.id },
      update: { name: c.name, iso2: c.iso2, emoji: c.emoji },
      create: c,
    });
  }
  console.log(`  Countries: ${COUNTRIES.length} upserted`);

  // Currencies
  for (const c of CURRENCIES) {
    await prisma.currency.upsert({
      where: { id: c.id },
      update: { name: c.name, symbol: c.symbol },
      create: c,
    });
  }
  console.log(`  Currencies: ${CURRENCIES.length} upserted`);

  // Banks
  for (const name of BANKS) {
    await prisma.bank.upsert({
      where: { name },
      update: {},
      create: { name },
    });
  }
  console.log(`  Banks: ${BANKS.length} upserted`);

  // Import Adapters (global — tenantId: null)
  let adapterCreated = 0;
  let adapterUpdated = 0;
  for (const adapter of ADAPTERS) {
    const existing = await prisma.importAdapter.findFirst({
      where: { name: adapter.name, tenantId: null },
    });

    const data = {
      matchSignature: adapter.matchSignature,
      columnMapping: adapter.columnMapping,
      dateFormat: adapter.dateFormat || null,
      amountStrategy: adapter.amountStrategy,
      currencyDefault: adapter.currencyDefault || null,
      skipRows: 0,
      isActive: true,
    };

    if (existing) {
      await prisma.importAdapter.update({
        where: { id: existing.id },
        data,
      });
      adapterUpdated++;
    } else {
      await prisma.importAdapter.create({
        data: { ...data, name: adapter.name, tenantId: null },
      });
      adapterCreated++;
    }
  }
  console.log(`  Adapters: ${adapterCreated} created, ${adapterUpdated} updated (${ADAPTERS.length} total)`);

  console.log('\nSeed complete.\n');
}

main()
  .catch((err) => {
    console.error('Seed failed:', err.message);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());

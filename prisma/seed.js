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

  console.log('\nSeed complete.\n');
}

main()
  .catch((err) => {
    console.error('Seed failed:', err.message);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());

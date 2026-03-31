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
  { id: 'BRA', iso2: 'BR', name: 'Brazil', emoji: '🇧🇷' },
  { id: 'ESP', iso2: 'ES', name: 'Spain', emoji: '🇪🇸' },
  { id: 'DEU', iso2: 'DE', name: 'Germany', emoji: '🇩🇪' },
  { id: 'USA', iso2: 'US', name: 'United States', emoji: '🇺🇸' },
  { id: 'GBR', iso2: 'GB', name: 'United Kingdom', emoji: '🇬🇧' },
  { id: 'FRA', iso2: 'FR', name: 'France', emoji: '🇫🇷' },
  { id: 'PRT', iso2: 'PT', name: 'Portugal', emoji: '🇵🇹' },
  { id: 'CAN', iso2: 'CA', name: 'Canada', emoji: '🇨🇦' },
  { id: 'AUS', iso2: 'AU', name: 'Australia', emoji: '🇦🇺' },
  { id: 'JPN', iso2: 'JP', name: 'Japan', emoji: '🇯🇵' },
];

const CURRENCIES = [
  { id: 'BRL', name: 'Brazilian Real', symbol: 'R$' },
  { id: 'EUR', name: 'Euro', symbol: '€' },
  { id: 'USD', name: 'US Dollar', symbol: '$' },
  { id: 'GBP', name: 'British Pound', symbol: '£' },
  { id: 'CAD', name: 'Canadian Dollar', symbol: 'C$' },
  { id: 'AUD', name: 'Australian Dollar', symbol: 'A$' },
  { id: 'JPY', name: 'Japanese Yen', symbol: '¥' },
  { id: 'CHF', name: 'Swiss Franc', symbol: 'CHF' },
];

const BANKS = [
  'Itaú',
  'Bradesco',
  'Clear',
  'Flow',
  'Nubank',
  'XP',
  'Charles Schwab',
  'eToro',
  'N26',
  'CaixaBank',
  'Revolut',
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

/**
 * Seed script: ensure a tenant has a specific set of countries, currencies,
 * banks, accounts, and categories.
 *
 * Usage:
 *   node scripts/seed-tenant-setup.mjs <tenantId>
 *   node scripts/seed-tenant-setup.mjs --dry-run <tenantId>   # preview only
 *
 * Idempotent — safe to run multiple times. Existing records are skipped,
 * missing ones are created.
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// ── Seed data (edit this) ────────────────────────────────────────────────────

const SEED_DATA = {
  countries: [
    { id: 'BRA', iso2: 'BR', name: 'Brazil', emoji: '🇧🇷', isDefault: true },
    { id: 'ESP', iso2: 'ES', name: 'Spain', emoji: '🇪🇸' },
    { id: 'DEU', iso2: 'DE', name: 'Germany', emoji: '🇩🇪' },
    { id: 'USA', iso2: 'US', name: 'United States', emoji: '🇺🇸' },
  ],

  currencies: [
    { id: 'BRL', name: 'Brazilian Real', symbol: 'R$', isDefault: true },
    { id: 'EUR', name: 'Euro', symbol: '€' },
    { id: 'USD', name: 'US Dollar', symbol: '$' },
  ],

  banks: [
    { name: 'Revolut (ES)' },
    { name: 'eToro' },
    { name: 'XP' }, 
    { name: 'Charles Schwab' },
    { name: 'Itaú' },
    { name: 'Nubank' },
    { name: 'Bradesco' },
    { name: 'Clear' },
    { name: 'Flow' },
    { name: 'CaixaBank' },
    { name: 'N26' },
  ],

  // Each account references a bank (by name), country (by id), and currency (by id).
  // Accounts are matched by name + tenantId to avoid duplicates.
  accounts: [
    { name: 'Itaú Daniel', accountNumber: '42404-3', bank: 'Itaú', country: 'BRA', currency: 'BRL' },
    { name: 'Bradesco', accountNumber: '0701613-1', bank: 'Bradesco', country: 'BRA', currency: 'BRL' },
    { name: 'Clear', accountNumber: 'N/A', bank: 'Clear', country: 'BRA', currency: 'BRL' },
    { name: 'Flow', accountNumber: '0758.14250-9', bank: 'Flow', country: 'BRA', currency: 'BRL' },
    { name: 'Itaú Patricia', accountNumber: 'N/A', bank: 'Itaú', country: 'BRA', currency: 'BRL' },
    { name: 'Nubank Daniel', accountNumber: '4522330-1', bank: 'Nubank', country: 'BRA', currency: 'BRL' },
    { name: 'Nubank Patricia', accountNumber: '4857623-3', bank: 'Nubank', country: 'BRA', currency: 'BRL' },
    { name: 'XP', accountNumber: '3212877', bank: 'XP', country: 'BRA', currency: 'BRL' },
    { name: 'LaCaixa', accountNumber: 'ES5821000747220200630340', bank: 'CaixaBank', country: 'ESP', currency: 'EUR' },
    { name: 'Schwab', accountNumber: '1917-0806', bank: 'Charles Schwab', country: 'USA', currency: 'USD' },
    { name: 'eToro', accountNumber: '', bank: 'eToro', country: 'DEU', currency: 'USD' },
    { name: 'eToro EUR', accountNumber: 'DE65202208000056406343', bank: 'eToro', country: 'DEU', currency: 'EUR' },
    { name: 'N26', accountNumber: 'ES7615632626363267821097', bank: 'N26', country: 'ESP', currency: 'EUR' },
    { name: 'Revolut Joint', accountNumber: 'ES4615830001109164004704', bank: 'Revolut (ES)', country: 'ESP', currency: 'EUR' },
    { name: 'Revolut Daniel', accountNumber: 'ES4015830001109051142693', bank: 'Revolut (ES)', country: 'ESP', currency: 'EUR' },
    { name: 'Revolut Patricia', accountNumber: 'ES9615830001129034338859', bank: 'Revolut (ES)', country: 'ESP', currency: 'EUR' },
    { name: 'Revolut Investment (USD)', accountNumber: '', bank: 'Revolut (ES)', country: 'ESP', currency: 'USD' },
    { name: 'Revolut Investment (EUR)', accountNumber: '', bank: 'Revolut (ES)', country: 'ESP', currency: 'EUR' },
    { name: 'eToro Patricia', accountNumber: '', bank: 'eToro', country: 'DEU', currency: 'USD' },
    { name: 'eToro Patricia EUR', accountNumber: '', bank: 'eToro', country: 'DEU', currency: 'EUR' },
  ],

  // Tenant-specific categories (custom, beyond the default set).
  // Matched by name + tenantId to avoid duplicates.
  // Fields: name (required), group (required), type (required), icon (optional), processingHint (optional)
  // Common types: 'Income' | 'Essentials' | 'Lifestyle' | 'Growth' | 'Investments' | 'Debt' | 'Transfers'
  categories: [
    { name: 'Drugstore', group: 'Entertainment', type: 'Lifestyle', icon: '✨' },
  ],
};

// ── Arg parsing ──────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const tenantId = args.find(a => !a.startsWith('--'));

if (!tenantId) {
  console.error('Usage:');
  console.error('  node scripts/seed-tenant-setup.mjs <tenantId>');
  console.error('  node scripts/seed-tenant-setup.mjs --dry-run <tenantId>');
  process.exit(1);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function log(action, label) {
  const icon = action === 'created' ? '✅' : '⏭️ ';
  console.log(`  ${icon} ${label} — ${action}`);
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  // 1. Verify tenant exists
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
  if (!tenant) {
    console.error(`❌ Tenant not found: ${tenantId}`);
    process.exit(1);
  }

  console.log(`\n🏗️  Seeding setup for tenant "${tenant.name}" (${tenantId})`);
  if (dryRun) console.log('   (dry run — no changes will be made)\n');
  else console.log();

  // 2. Countries
  console.log('── Countries ─────────────────────────────────────────────');
  for (const c of SEED_DATA.countries) {
    const existing = await prisma.country.findUnique({ where: { id: c.id } });
    if (!existing && !dryRun) {
      await prisma.country.create({
        data: { id: c.id, iso2: c.iso2, name: c.name, emoji: c.emoji },
      });
    }
    log(existing ? 'already exists' : dryRun ? 'would create' : 'created', `Country ${c.id} (${c.name})`);

    // TenantCountry link
    const link = await prisma.tenantCountry.findUnique({
      where: { tenantId_countryId: { tenantId, countryId: c.id } },
    });
    if (!link && !dryRun) {
      await prisma.tenantCountry.create({
        data: { tenantId, countryId: c.id, isDefault: c.isDefault ?? false },
      });
    }
    log(link ? 'already linked' : dryRun ? 'would link' : 'linked', `  └─ TenantCountry${c.isDefault ? ' (default)' : ''}`);
  }

  // 3. Currencies
  console.log('\n── Currencies ────────────────────────────────────────────');
  for (const c of SEED_DATA.currencies) {
    const existing = await prisma.currency.findUnique({ where: { id: c.id } });
    if (!existing && !dryRun) {
      await prisma.currency.create({
        data: { id: c.id, name: c.name, symbol: c.symbol },
      });
    }
    log(existing ? 'already exists' : dryRun ? 'would create' : 'created', `Currency ${c.id} (${c.name})`);

    // TenantCurrency link
    const link = await prisma.tenantCurrency.findUnique({
      where: { tenantId_currencyId: { tenantId, currencyId: c.id } },
    });
    if (!link && !dryRun) {
      await prisma.tenantCurrency.create({
        data: { tenantId, currencyId: c.id, isDefault: c.isDefault ?? false },
      });
    }
    log(link ? 'already linked' : dryRun ? 'would link' : 'linked', `  └─ TenantCurrency${c.isDefault ? ' (default)' : ''}`);
  }

  // 4. Banks
  console.log('\n── Banks ─────────────────────────────────────────────────');
  const bankIdByName = {};
  for (const b of SEED_DATA.banks) {
    let bank = await prisma.bank.findUnique({ where: { name: b.name } });
    if (!bank && !dryRun) {
      bank = await prisma.bank.create({ data: { name: b.name } });
    }
    log(bank ? 'already exists' : dryRun ? 'would create' : 'created', `Bank "${b.name}"`);

    if (bank) {
      bankIdByName[b.name] = bank.id;

      // TenantBank link
      const link = await prisma.tenantBank.findUnique({
        where: { tenantId_bankId: { tenantId, bankId: bank.id } },
      });
      if (!link && !dryRun) {
        await prisma.tenantBank.create({ data: { tenantId, bankId: bank.id } });
      }
      log(link ? 'already linked' : dryRun ? 'would link' : 'linked', `  └─ TenantBank`);
    }
  }

  // 5. Accounts
  console.log('\n── Accounts ──────────────────────────────────────────────');
  if (dryRun && Object.keys(bankIdByName).length === 0) {
    console.log('  (banks not yet created — account creation will happen on real run)');
  }
  for (const a of SEED_DATA.accounts) {
    const bankId = bankIdByName[a.bank];

    // Match existing account by name within this tenant
    const existing = await prisma.account.findFirst({
      where: { tenantId, name: a.name },
    });

    if (existing) {
      log('already exists', `Account "${a.name}"`);
      continue;
    }

    if (dryRun) {
      log('would create', `Account "${a.name}" → ${a.bank} / ${a.country} / ${a.currency}`);
      continue;
    }

    if (!bankId) {
      console.log(`  ⚠️  Skipping account "${a.name}" — bank "${a.bank}" not found`);
      continue;
    }

    await prisma.account.create({
      data: {
        name: a.name,
        accountNumber: a.accountNumber,
        bankId,
        countryId: a.country,
        currencyCode: a.currency,
        tenantId,
      },
    });
    log('created', `Account "${a.name}" → ${a.bank} / ${a.country} / ${a.currency}`);
  }

  // 6. Categories (tenant-specific)
  console.log('\n── Categories ────────────────────────────────────────────');
  for (const c of SEED_DATA.categories) {
    const existing = await prisma.category.findFirst({
      where: { tenantId, name: c.name },
    });

    if (existing) {
      log('already exists', `Category "${c.name}" (${c.type} / ${c.group})`);
      continue;
    }

    if (dryRun) {
      log('would create', `Category "${c.name}" (${c.type} / ${c.group})`);
      continue;
    }

    await prisma.category.create({
      data: {
        name: c.name,
        group: c.group,
        type: c.type,
        icon: c.icon || null,
        processingHint: c.processingHint || null,
        tenantId,
      },
    });
    log('created', `Category "${c.name}" (${c.type} / ${c.group})`);
  }

  console.log(`\n✅ Seed complete for tenant "${tenant.name}".\n`);
}

main()
  .catch(err => {
    console.error('\n❌ Seed failed:', err.message);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());

/**
 * Integration test helper — global reference data (Country / Currency / Bank).
 *
 * CI's `bliss_test` is created with `prisma migrate deploy` only — no
 * `prisma db seed` runs — so these non-tenant-scoped tables start empty. Any
 * integration test that creates an `Account` (and therefore a `Transaction`)
 * must ensure the FK targets exist first.
 *
 * Idempotent and safe to call from multiple suites: Country/Currency are
 * upserted by their string PK, Bank by its unique name. Nothing here is
 * tenant-scoped, so it is never torn down.
 */

import prisma from '../../prisma/prisma.js';

export interface ReferenceData {
  countryId: string;
  currencyCode: string;
  bankId: number;
}

export async function ensureReferenceData({
  countryId = 'USA',
  currencyCode = 'USD',
  bankName = 'Integration Test Bank',
}: { countryId?: string; currencyCode?: string; bankName?: string } = {}): Promise<ReferenceData> {
  const country = await prisma.country.upsert({
    where: { id: countryId },
    update: {},
    create: { id: countryId, name: countryId },
  });
  const currency = await prisma.currency.upsert({
    where: { id: currencyCode },
    update: {},
    create: { id: currencyCode, name: currencyCode },
  });
  const bank = await prisma.bank.upsert({
    where: { name: bankName },
    update: {},
    create: { name: bankName },
  });
  return { countryId: country.id, currencyCode: currency.id, bankId: bank.id };
}

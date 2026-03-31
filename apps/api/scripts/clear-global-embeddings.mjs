/**
 * clear-global-embeddings.mjs
 *
 * Dev/test utility — truncates the entire GlobalEmbedding table.
 *
 * GlobalEmbedding is shared across all tenants (no tenantId column), so
 * there is no tenant-scoped way to clear it. This script wipes all rows.
 *
 * Usage:
 *   node scripts/clear-global-embeddings.mjs
 *
 * Optional: filter by defaultCategoryCode
 *   node scripts/clear-global-embeddings.mjs GROCERIES
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const code = process.argv[2] ?? null;

if (code) {
  const { count } = await prisma.globalEmbedding.deleteMany({
    where: { defaultCategoryCode: code },
  });
  console.log(`Deleted ${count} GlobalEmbedding row(s) for code '${code}'.`);
} else {
  const { count } = await prisma.globalEmbedding.deleteMany({});
  console.log(`Deleted ${count} GlobalEmbedding row(s) (entire table).`);
}

await prisma.$disconnect();

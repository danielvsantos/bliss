#!/usr/bin/env node
/**
 * Re-generate transaction embeddings for the currently configured
 * EMBEDDING_PROVIDER.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS
 * ─────────────────────────────────────────────────────────────────────────────
 * Each LLM provider produces embeddings in its own vector space. Vectors from
 * one provider are not comparable with vectors from another, even at the same
 * dimensionality. When an operator switches EMBEDDING_PROVIDER, every stored
 * embedding becomes stale and vector similarity search will misbehave until
 * the index is rebuilt.
 *
 * This script walks TransactionEmbedding and re-generates each vector using
 * the new provider. It runs in batches, respects the adapter's retry logic,
 * and is idempotent — safe to re-run after a crash.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * IMPORTANT: The `description` column on both embedding tables stores only a
 * SHA-256 hash, never plaintext. We recover plaintext by joining to the
 * Transaction row via the optional `transactionId` FK — Prisma middleware
 * decrypts Transaction.description automatically.
 *
 * Rows with `transactionId = NULL` (pre-commit staged rows) cannot be
 * re-embedded because we have no plaintext source. These are reported and
 * skipped. They will be rebuilt naturally the next time the user confirms
 * the staged import.
 *
 * GlobalEmbedding has no transactionId and no stored plaintext. It is NOT
 * touched by this script. Global entries are rebuilt incrementally by
 * recordFeedback() as users correct classifications on the new provider.
 * If you need a clean global slate, truncate `GlobalEmbedding` manually —
 * subsequent confirmations will repopulate it.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Usage:
 *   node scripts/regenerate-embeddings.js                  # re-embed every tenant
 *   node scripts/regenerate-embeddings.js --tenant=<id>    # scope to one tenant
 *   node scripts/regenerate-embeddings.js --dry-run        # count rows, no API calls
 *   node scripts/regenerate-embeddings.js --batch=50       # batch size (default 100)
 *
 * Environment:
 *   All the usual Bliss env vars are read from .env. The script uses whichever
 *   adapter is currently configured (LLM_PROVIDER / EMBEDDING_PROVIDER).
 */

const path = require('path');

// Load .env from repo root so DATABASE_URL and provider keys are available
// when this script is invoked from any directory.
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const prisma = require(path.resolve(__dirname, '..', 'apps', 'backend', 'prisma', 'prisma.js'));
const { generateEmbedding } = require(path.resolve(
  __dirname,
  '..',
  'apps',
  'backend',
  'src',
  'services',
  'llm'
));
const {
  EMBEDDING_DIMENSIONS,
} = require(path.resolve(
  __dirname,
  '..',
  'apps',
  'backend',
  'src',
  'config',
  'classificationConfig'
));

// ─── CLI parsing ──────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const opts = { tenant: null, dryRun: false, batch: 100 };
  for (const arg of argv.slice(2)) {
    if (arg === '--dry-run') opts.dryRun = true;
    else if (arg.startsWith('--tenant=')) opts.tenant = arg.slice('--tenant='.length);
    else if (arg.startsWith('--batch=')) opts.batch = parseInt(arg.slice('--batch='.length), 10);
    else if (arg === '--help' || arg === '-h') {
      console.log(`Usage: node scripts/regenerate-embeddings.js [options]

Options:
  --tenant=<id>      Scope to a single tenant (default: all tenants)
  --dry-run          Count rows that would be re-embedded, no API calls
  --batch=<n>        Batch size for DB reads (default: 100)
  -h, --help         Show this help
`);
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${arg}`);
      process.exit(1);
    }
  }
  if (!Number.isFinite(opts.batch) || opts.batch < 1) {
    console.error('--batch must be a positive integer');
    process.exit(1);
  }
  return opts;
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const opts = parseArgs(process.argv);

  console.log('Bliss — regenerate embeddings');
  console.log(`  LLM_PROVIDER       = ${process.env.LLM_PROVIDER || 'gemini'}`);
  console.log(`  EMBEDDING_PROVIDER = ${process.env.EMBEDDING_PROVIDER || process.env.LLM_PROVIDER || 'gemini'}`);
  console.log(`  EMBEDDING_DIMENSIONS = ${EMBEDDING_DIMENSIONS}`);
  console.log(`  tenant scope       = ${opts.tenant || '(all)'}`);
  console.log(`  dry run            = ${opts.dryRun}`);
  console.log(`  batch size         = ${opts.batch}`);
  console.log('');

  const whereBase = opts.tenant ? { tenantId: opts.tenant } : {};

  // Count with plaintext available (transactionId not null) vs not.
  const totalWithTxn = await prisma.transactionEmbedding.count({
    where: { ...whereBase, transactionId: { not: null } },
  });
  const totalWithoutTxn = await prisma.transactionEmbedding.count({
    where: { ...whereBase, transactionId: null },
  });

  console.log(`Re-embeddable rows (transactionId NOT NULL): ${totalWithTxn}`);
  console.log(`Skipped rows        (transactionId IS NULL): ${totalWithoutTxn}`);
  console.log('');

  if (opts.dryRun) {
    console.log('Dry run — no API calls made. Exiting.');
    await prisma.$disconnect();
    return;
  }

  if (totalWithTxn === 0) {
    console.log('Nothing to re-embed. Exiting.');
    await prisma.$disconnect();
    return;
  }

  // ─── Process in batches ────────────────────────────────────────────────────
  const started = Date.now();
  let processed = 0;
  let failed = 0;
  let skipped = 0;
  let cursorId = 0;

  while (processed + failed + skipped < totalWithTxn) {
    // We stream by id > cursor to paginate stably even as rows get updated.
    const batch = await prisma.transactionEmbedding.findMany({
      where: {
        ...whereBase,
        transactionId: { not: null },
        id: { gt: cursorId },
      },
      include: { transaction: { select: { description: true } } },
      orderBy: { id: 'asc' },
      take: opts.batch,
    });

    if (batch.length === 0) break;

    for (const row of batch) {
      cursorId = row.id;
      const plaintext = row.transaction?.description;
      if (!plaintext || typeof plaintext !== 'string' || plaintext.trim() === '') {
        // Join succeeded but description was empty — nothing to embed.
        skipped++;
        continue;
      }

      try {
        const vector = await generateEmbedding(plaintext);
        if (!Array.isArray(vector) || vector.length !== EMBEDDING_DIMENSIONS) {
          throw new Error(
            `Unexpected embedding shape (len=${vector?.length ?? 'n/a'}, expected=${EMBEDDING_DIMENSIONS})`
          );
        }
        // pgvector column is outside Prisma's typed surface — update via raw SQL.
        const vectorLiteral = `[${vector.join(',')}]`;
        await prisma.$executeRawUnsafe(
          'UPDATE "TransactionEmbedding" SET embedding = $1::vector, "updatedAt" = NOW() WHERE id = $2',
          vectorLiteral,
          row.id
        );
        processed++;
      } catch (err) {
        failed++;
        console.error(`  ✗ row id=${row.id}: ${err.message}`);
      }

      // Progress ping every 25 rows.
      const done = processed + failed + skipped;
      if (done % 25 === 0) {
        const elapsedSec = (Date.now() - started) / 1000;
        const rate = done / elapsedSec;
        const etaSec = rate > 0 ? (totalWithTxn - done) / rate : 0;
        console.log(
          `  ${done}/${totalWithTxn}  ` +
            `(${processed} ok, ${failed} failed, ${skipped} skipped)  ` +
            `rate=${rate.toFixed(1)}/s  eta=${Math.round(etaSec)}s`
        );
      }
    }
  }

  const elapsedSec = (Date.now() - started) / 1000;
  console.log('');
  console.log('Done.');
  console.log(`  processed : ${processed}`);
  console.log(`  failed    : ${failed}`);
  console.log(`  skipped   : ${skipped}`);
  console.log(`  elapsed   : ${elapsedSec.toFixed(1)}s`);

  if (totalWithoutTxn > 0) {
    console.log('');
    console.log(
      `Note: ${totalWithoutTxn} row(s) had transactionId=NULL and were not touched. ` +
        'These are pre-commit staged rows that will regenerate when the user confirms the import.'
    );
  }
  console.log('');
  console.log(
    'Note: GlobalEmbedding entries are not re-embedded by this script. ' +
      'They repopulate incrementally via recordFeedback() as users confirm classifications. ' +
      'If you want a clean slate, TRUNCATE "GlobalEmbedding" manually.'
  );

  await prisma.$disconnect();

  if (failed > 0) process.exit(2);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});

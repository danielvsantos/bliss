#!/usr/bin/env node

/**
 * Clear SecurityMaster table — all records or a specific symbol.
 *
 * Usage:
 *   node scripts/clear-security-master.js            # clear ALL records
 *   node scripts/clear-security-master.js AAPL        # clear only AAPL
 *   node scripts/clear-security-master.js AAPL,MSFT   # clear multiple symbols
 */

import prisma from '../prisma/prisma.js';

const arg = process.argv[2];

async function main() {
    if (!arg) {
        const count = await prisma.securityMaster.count();
        console.log(`Deleting ALL ${count} SecurityMaster records...`);
        const result = await prisma.securityMaster.deleteMany();
        console.log(`Done. Deleted ${result.count} records.`);
    } else {
        const symbols = arg.split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
        console.log(`Deleting SecurityMaster records for: ${symbols.join(', ')}`);
        const result = await prisma.securityMaster.deleteMany({
            where: { symbol: { in: symbols } },
        });
        console.log(`Done. Deleted ${result.count} of ${symbols.length} requested.`);
    }

    await prisma.$disconnect();
}

main().catch((err) => {
    console.error('Error:', err.message);
    process.exit(1);
});

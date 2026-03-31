import { StatusCodes } from 'http-status-codes';
import prisma from '../../../prisma/prisma.js';
import { rateLimiters } from '../../../utils/rateLimit.js';
import { cors } from '../../../utils/cors.js';
import * as Sentry from '@sentry/nextjs';
import { withAuth } from '../../../utils/withAuth.js';

/**
 * GET /api/imports/pending
 *
 * Returns all StagedImports with status='READY' for the tenant,
 * each with a count of uncommitted (promotable) rows.
 */
export default withAuth(async function handler(req, res) {
  await new Promise((resolve, reject) => {
    rateLimiters.importsRead(req, res, (result) => {
      if (result instanceof Error) return reject(result);
      resolve(result);
    });
  });

  if (cors(req, res)) return;

  if (req.method !== 'GET') {
    res.setHeader('Allow', ['GET']);
    return res.status(StatusCodes.METHOD_NOT_ALLOWED).end();
  }

  try {
    const user = req.user;

    // Fetch READY imports for this tenant
    const imports = await prisma.stagedImport.findMany({
      where: {
        tenantId: user.tenantId,
        status: 'READY',
      },
      orderBy: { createdAt: 'desc' },
    });

    // For each import, count promotable rows
    const results = await Promise.all(
      imports.map(async (imp) => {
        const pendingRowCount = await prisma.stagedImportRow.count({
          where: {
            stagedImportId: imp.id,
            status: { in: ['CONFIRMED', 'PENDING', 'POTENTIAL_DUPLICATE'] },
          },
        });

        return {
          id: imp.id,
          fileName: imp.fileName,
          adapterName: imp.adapterName,
          accountId: imp.accountId,
          totalRows: imp.totalRows,
          pendingRowCount,
          createdAt: imp.createdAt,
        };
      }),
    );

    // Only include imports that still have pending rows
    const pending = results.filter((r) => r.pendingRowCount > 0);

    // Prevent browser from caching this dynamic data (avoids 304 with stale/empty body)
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    return res.status(StatusCodes.OK).json({ imports: pending });
  } catch (error) {
    Sentry.captureException(error);
    return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
      error: 'Server Error',
      details: error.message,
    });
  }
});

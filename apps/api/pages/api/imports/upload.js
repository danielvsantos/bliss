import { StatusCodes } from 'http-status-codes';
import formidable from 'formidable';
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { createStorageAdapter } from '@bliss/shared/storage';
import prisma from '../../../prisma/prisma.js';
import { rateLimiters } from '../../../utils/rateLimit.js';
import { cors } from '../../../utils/cors.js';
import * as Sentry from '@sentry/nextjs';
import { produceEvent } from '../../../utils/produceEvent.js';
import { withAuth } from '../../../utils/withAuth.js';

export const config = {
  api: {
    bodyParser: false,
  },
};

export default withAuth(async function handler(req, res) {
  await new Promise((resolve, reject) => {
    rateLimiters.importsUpload(req, res, (result) => {
      if (result instanceof Error) return reject(result);
      resolve(result);
    });
  });

  if (cors(req, res)) return;

  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(StatusCodes.METHOD_NOT_ALLOWED).end();
  }

  // Initialize storage adapter lazily (inside handler so it fires at request time,
  // not at module load / bundle analysis time — required for @google-cloud/storage on Vercel)
  let storage;
  try {
    storage = createStorageAdapter();
  } catch (error) {
    Sentry.captureException(error);
    return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ error: 'Storage service is not configured.' });
  }

  try {
    const user = req.user;

    const ALLOWED_MIME_TYPES = [
      'text/csv',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.ms-excel',
    ];
    const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB

    // Parse multipart form
    const form = formidable({ multiples: false, keepExtensions: true, maxFileSize: MAX_FILE_SIZE });

    form.parse(req, async (err, fields, files) => {
      if (err) {
        console.error('Formidable error:', err);
        const errMsg = err.code === 1009 ? 'File exceeds maximum allowed size of 10 MB' : 'File parsing error';
        return res.status(StatusCodes.BAD_REQUEST).json({ error: errMsg });
      }

      const file = files.file?.[0];
      if (!file || !file.filepath) {
        return res.status(StatusCodes.BAD_REQUEST).json({ error: 'No file uploaded' });
      }

      if (!ALLOWED_MIME_TYPES.includes(file.mimetype)) {
        return res.status(StatusCodes.BAD_REQUEST).json({
          error: `Unsupported file type "${file.mimetype}". Only CSV and XLSX files are accepted.`,
        });
      }

      // Extract form fields (formidable v3 wraps values in arrays)
      const accountIdRaw = Array.isArray(fields.accountId) ? fields.accountId[0] : fields.accountId;
      const accountId = accountIdRaw ? parseInt(accountIdRaw, 10) : null;
      const adapterId = parseInt(Array.isArray(fields.adapterId) ? fields.adapterId[0] : fields.adapterId, 10);

      if (!adapterId || isNaN(adapterId)) {
        return res.status(StatusCodes.BAD_REQUEST).json({ error: 'adapterId is required' });
      }

      try {
        // Validate adapterId is accessible (tenant-specific or global)
        // Fetch adapter FIRST so we can check isNative before validating accountId
        const adapter = await prisma.importAdapter.findFirst({
          where: {
            id: adapterId,
            isActive: true,
            OR: [{ tenantId: user.tenantId }, { tenantId: null }],
          },
          select: { id: true, name: true, matchSignature: true },
        });
        if (!adapter) {
          return res.status(StatusCodes.BAD_REQUEST).json({ error: 'Adapter not found or not accessible' });
        }

        const isNativeAdapter = adapter.matchSignature?.isNative === true;

        // accountId is required for all adapters EXCEPT the native adapter
        // (native adapter resolves account per-row from the CSV itself)
        if (!isNativeAdapter && (!accountId || isNaN(accountId))) {
          return res.status(StatusCodes.BAD_REQUEST).json({ error: 'accountId is required' });
        }

        // Validate accountId belongs to tenant (only when provided)
        if (accountId && !isNaN(accountId)) {
          const account = await prisma.account.findFirst({
            where: { id: accountId, tenantId: user.tenantId },
            select: { id: true },
          });
          if (!account) {
            return res.status(StatusCodes.BAD_REQUEST).json({ error: 'Account not found or does not belong to your tenant' });
          }
        }

        // Upload file to storage (local filesystem or GCS)
        const storageKey = `imports/${user.tenantId}/${uuidv4()}-${file.originalFilename}`;
        await storage.uploadFile(file.filepath, storageKey);
        console.log(`File ${file.originalFilename} uploaded to storage: ${storageKey}`);

        // Create StagedImport record (status: PROCESSING)
        // accountId is null for native adapter (each row carries its own account)
        const stagedImport = await prisma.stagedImport.create({
          data: {
            tenantId: user.tenantId,
            userId: user.id,
            accountId: (accountId && !isNaN(accountId)) ? accountId : null,
            status: 'PROCESSING',
            fileName: file.originalFilename || 'unknown.csv',
            adapterName: adapter.name,
          },
        });

        // Produce event to backend service
        const eventPayload = {
          type: 'SMART_IMPORT_REQUESTED',
          tenantId: user.tenantId,
          userId: user.id,
          accountId,
          adapterId,
          fileStorageKey: storageKey,
          stagedImportId: stagedImport.id,
        };

        await produceEvent(eventPayload);

        return res.status(StatusCodes.ACCEPTED).json({
          stagedImportId: stagedImport.id,
          status: 'PROCESSING',
          message: 'File uploaded successfully. Import processing has started.',
        });
      } catch (error) {
        console.error('Error during smart import upload:', error);
        Sentry.captureException(error);
        return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
          error: 'Failed to start the import process.',
          details: error.message,
        });
      } finally {
        // Cleanup local temp file
        try {
          fs.unlinkSync(file.filepath);
        } catch (cleanupErr) {
          // ignore
        }
      }
    });
  } catch (error) {
    Sentry.captureException(error);
    return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
      error: 'Server Error',
      details: error.message,
    });
  }
});

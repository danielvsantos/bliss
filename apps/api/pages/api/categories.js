import prisma from '../../prisma/prisma.js';
import { StatusCodes } from 'http-status-codes';
import * as Sentry from '@sentry/nextjs';
import { cors } from '../../utils/cors.js';
import { rateLimiters } from '../../utils/rateLimit.js';
import { ALLOWED_CATEGORY_TYPES } from '../../lib/constants.js';
import { withAuth } from '../../utils/withAuth.js';
import { produceEvent } from '../../utils/produceEvent.js';

export default withAuth(async function handler(req, res) {

// Apply rate limiting
await new Promise((resolve, reject) => {
  rateLimiters.categories(req, res, (result) => {
    if (result instanceof Error) return reject(result);
    resolve(result);
  });
});

  // Handle CORS
  if (cors(req, res)) return;

  try {
    const user = req.user;
    const tenantId = user.tenantId;

    switch (req.method) {
      case 'GET':
        await handleGet(req, res, tenantId);
        break;
      case 'POST':
        await handlePost(req, res, user, tenantId);
        break;
      case 'PUT':
        await handlePut(req, res, user, tenantId);
        break;
      case 'DELETE':
        await handleDelete(req, res, user, tenantId);
        break;
      default:
        res.setHeader('Allow', ['GET', 'POST', 'PUT', 'DELETE']);
        res.status(StatusCodes.METHOD_NOT_ALLOWED).end();
        break;
    }
  } catch (error) {
    console.error('Categories error:', error);
    Sentry.captureException(error);
    res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
      error: 'Server Error',
      ...(process.env.NODE_ENV === 'development' && { details: error.message }),
    });
  }
});

async function handleGet(req, res, tenantId) {
  const { 
    id, 
    name,
    type, 
    group,
    page = 1, 
    limit = 100,
    sortBy = 'name',
    sortOrder = 'asc'
  } = req.query;


  if (id) {
    const categoryId = parseInt(id, 10);
    if (isNaN(categoryId)) {
      res.status(StatusCodes.BAD_REQUEST).json({ error: 'Invalid category ID format' });
      return;
    }
    const category = await prisma.category.findFirst({
      where: { id: categoryId, tenantId },
      include: { _count: { select: { transactions: true } } },
    });

    if (!category) {
      res.status(StatusCodes.NOT_FOUND).json({ error: 'Category not found in this tenant' });
      return;
    }
    res.status(StatusCodes.OK).json(category);
    return;
  } else {
    // Build filter conditions
    const filters = {
      tenantId,
      ...(name && { name: { contains: name, mode: 'insensitive' } }),
      ...(type && { type }),
      ...(group && { group })
    };


    // Parse pagination parameters
    const numericPage = Math.max(parseInt(page, 10), 1);
    const numericLimit = Math.min(parseInt(limit, 10), 1000);
    const skip = (numericPage - 1) * numericLimit;

    // Validate sort parameters
    const allowedSortFields = ['name', 'type', 'group'];
    const actualSortField = allowedSortFields.includes(sortBy) ? sortBy : 'name';
    const actualSortOrder = sortOrder === 'desc' ? 'desc' : 'asc';

    try {
      // Get filtered categories with pagination
      const [categories, total] = await Promise.all([
        prisma.category.findMany({
          where: filters,
          orderBy: { [actualSortField]: actualSortOrder },
          skip,
          take: numericLimit,
          include: {
            _count: { select: { transactions: true } },
          },
        }),
        prisma.category.count({ where: filters })
      ]);

      console.log(`Found ${categories.length} categories out of ${total} total`);

      const response = {
        categories,
        total,
        page: numericPage,
        limit: numericLimit,
        totalPages: Math.ceil(total / numericLimit),
        filters: {
          name,
          type,
          group
        },
        sort: {
          field: actualSortField,
          order: actualSortOrder
        }
      };


      res.status(StatusCodes.OK).json(response);
      return;
    } catch (error) {
      console.error('Query error:', error);
      res.status(StatusCodes.BAD_REQUEST).json({
        error: 'Query Failed',
        details: error.message
      });
    }
  }
}

async function handlePost(req, res, session, tenantId) {
  const { name, group, type, icon } = req.body;

  if (!name || !group || !type) {
    res.status(StatusCodes.BAD_REQUEST).json({ error: 'Missing required fields: name, group, type' });
    return;
  }

  // Security and validation checks
  if (!ALLOWED_CATEGORY_TYPES.includes(type)) {
    return res.status(StatusCodes.BAD_REQUEST).json({
      error: 'Invalid category type',
      details: `The provided type '${type}' is not one of the allowed types.`,
    });
  }

  // System-managed fields are never accepted from users.
  // processingHint, portfolioItemKeyStrategy, and defaultCategoryCode are set
  // only at tenant seeding (signup) and must not be user-editable.

  try {
    // Create category and audit log in a transaction
    const result = await prisma.$transaction(async (prisma) => {
      const newCategory = await prisma.category.create({
        data: {
          name,
          group,
          type,
          tenantId,
          icon,
        },
      });

      return newCategory;
    });

    res.status(StatusCodes.CREATED).json(result);
    return;
  } catch (error) {
    Sentry.captureException(error);
    if (error.code === 'P2002') { // Unique constraint failed
      res.status(StatusCodes.CONFLICT).json({ error: 'A category with this name already exists for your tenant.' });
    } else {
      res.status(StatusCodes.BAD_REQUEST).json({
        error: 'Failed to create category',
        ...(process.env.NODE_ENV === 'development' && { details: error.message }),
      });
    }
  }
}

async function handlePut(req, res, session, tenantId) {
  const { id } = req.query;
  const { name, group, type, icon } = req.body;
  const categoryId = parseInt(id, 10);

  if (isNaN(categoryId)) {
    res.status(StatusCodes.BAD_REQUEST).json({ error: 'Invalid category ID' });
    return;
  }

  // Validate input
  if (type && !ALLOWED_CATEGORY_TYPES.includes(type)) {
    return res.status(StatusCodes.BAD_REQUEST).json({
      error: 'Invalid category type',
      details: `The provided type '${type}' is not one of the allowed types.`,
    });
  }

  // System-managed fields are never accepted from users.
  if (req.body.processingHint !== undefined || req.body.portfolioItemKeyStrategy !== undefined || req.body.defaultCategoryCode !== undefined) {
    return res.status(StatusCodes.BAD_REQUEST).json({
      error: 'Cannot set system-managed fields',
      details: 'The fields processingHint, portfolioItemKeyStrategy, and defaultCategoryCode are managed by the system and cannot be set by users.',
    });
  }

  const existingCategory = await prisma.category.findUnique({ where: { id: categoryId } });

  if (!existingCategory || existingCategory.tenantId !== tenantId) {
    res.status(StatusCodes.NOT_FOUND).json({ error: 'Category not found in this tenant' });
    return;
  }

  try {
    // Update category and create audit log in a transaction
    const result = await prisma.$transaction(async (prisma) => {
      const updatedCategory = await prisma.category.update({
        where: { id: categoryId },
        data: { name, group, type, icon }
      });

      return updatedCategory;
    });

    res.status(StatusCodes.OK).json(result);
    return;
  } catch (error) {
    Sentry.captureException(error);
    if (error.code === 'P2002') {
      res.status(StatusCodes.CONFLICT).json({ error: 'A category with the updated name already exists.' });
    } else {
      res.status(StatusCodes.BAD_REQUEST).json({
        error: 'Failed to update category',
        ...(process.env.NODE_ENV === 'development' && { details: error.message }),
      });
    }
  }
}

async function handleDelete(req, res, session, tenantId) {
  const { id } = req.query;
  const categoryId = parseInt(id, 10);

  if (isNaN(categoryId)) {
    res.status(StatusCodes.BAD_REQUEST).json({ error: 'Invalid category ID' });
    return;
  }

  try {
    const categoryToDelete = await prisma.category.findFirst({
      where: {
        id: categoryId,
        tenantId,
      },
    });

    if (!categoryToDelete) {
      res.status(StatusCodes.NOT_FOUND).json({ error: 'Category not found' });
      return;
    }

    // Deletion protection for system-critical groups
    if (categoryToDelete.processingHint && categoryToDelete.processingHint !== 'MANUAL') {
      const count = await prisma.category.count({
        where: {
          tenantId,
          group: categoryToDelete.group,
          id: { not: categoryId },
        },
      });

      if (count === 0) {
        return res.status(StatusCodes.BAD_REQUEST).json({
          error: 'Deletion Rejected',
          details: `This category ('${categoryToDelete.name}') belongs to a system-critical group ('${categoryToDelete.group}') and cannot be deleted as it is the last one.`,
        });
      }
    }

    // Check for dependent records
    const transactionCount = await prisma.transaction.count({
      where: { categoryId, tenantId },
    });

    const mergeInto = req.query.mergeInto ? parseInt(req.query.mergeInto, 10) : null;

    if (transactionCount > 0 && !mergeInto) {
      return res.status(StatusCodes.BAD_REQUEST).json({
        error: 'Category has transactions',
        transactionCount,
        requiresMerge: true,
      });
    }

    // If mergeInto is provided, validate target category
    if (mergeInto) {
      if (mergeInto === categoryId) {
        return res.status(StatusCodes.BAD_REQUEST).json({ error: 'Cannot merge a category into itself' });
      }
      const targetCategory = await prisma.category.findFirst({
        where: { id: mergeInto, tenantId },
      });
      if (!targetCategory) {
        return res.status(StatusCodes.BAD_REQUEST).json({ error: 'Target merge category not found' });
      }
    }

    const result = await prisma.$transaction(async (prisma) => {
      // If merging, reassign all dependent records to the target category
      if (mergeInto && transactionCount > 0) {
        await prisma.transaction.updateMany({
          where: { categoryId, tenantId },
          data: { categoryId: mergeInto },
        });
        await prisma.plaidTransaction.updateMany({
          where: { suggestedCategoryId: categoryId, plaidItem: { tenantId } },
          data: { suggestedCategoryId: mergeInto },
        });
        await prisma.transactionEmbedding.updateMany({
          where: { categoryId: categoryId, tenantId },
          data: { categoryId: mergeInto },
        });
        await prisma.portfolioItem.updateMany({
          where: { categoryId, tenantId },
          data: { categoryId: mergeInto },
        });
      }

      const deletedCategory = await prisma.category.delete({
        where: { id: categoryId },
      });

      return deletedCategory;
    });

    // After a merge, all reassigned transactions have a new category (potentially
    // different type/group), so the full pipeline needs to reprocess:
    // portfolio changes → cash holdings → analytics → valuation.
    if (mergeInto && transactionCount > 0) {
      produceEvent({
        type: 'TRANSACTIONS_IMPORTED',
        tenantId,
        source: 'CATEGORY_MERGE',
      }).catch(err => Sentry.captureException(err));
    }

    res.status(StatusCodes.OK).json({
      message: mergeInto
        ? `Category deleted and ${transactionCount} transaction(s) reassigned`
        : 'Category deleted successfully',
      category: result,
    });
  } catch (error) {
    Sentry.captureException(error);
    res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
      error: 'Failed to delete category',
      ...(process.env.NODE_ENV === 'development' && { details: error.message }),
    });
  }
}

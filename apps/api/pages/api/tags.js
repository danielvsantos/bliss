import prisma from '../../prisma/prisma.js'; // Adjust path as necessary
import { StatusCodes } from 'http-status-codes';
import * as Sentry from '@sentry/nextjs';
import { cors } from '../../utils/cors.js';
import { rateLimiters } from '../../utils/rateLimit.js';
import { withAuth } from '../../utils/withAuth.js';

export default withAuth(async function handler(req, res) {

  // Apply rate limiting
await new Promise((resolve, reject) => {
  rateLimiters.tags(req, res, (result) => {
    if (result instanceof Error) return reject(result);
    resolve(result);
  });
});

  // Handle CORS
  if (cors(req, res)) return;

  try {
    switch (req.method) {
      case 'GET':
        await handleGet(req, res);
        break;
      case 'POST':
        await handlePost(req, res);
        break;
      case 'PUT':
        await handlePut(req, res);
        break;
      case 'DELETE':
        await handleDelete(req, res);
        break;
      default:
        res.setHeader('Allow', ['GET', 'POST', 'PUT', 'DELETE']);
        res.status(StatusCodes.METHOD_NOT_ALLOWED).end();
        break;
    }
  } catch (error) {
    Sentry.captureException(error);
    res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
      error: 'Server Error',
      ...(process.env.NODE_ENV === 'development' && { details: error.message }),
    });
  }
});

// GET /api/tags or /api/tags?id={tagId}
async function handleGet(req, res) {
  const { id } = req.query;

  if (id) {
    // Get single tag by ID
    const tagId = parseInt(id, 10);
    if (isNaN(tagId)) {
      res.status(StatusCodes.BAD_REQUEST).json({ error: 'Invalid tag ID format' });
      return;
    }

    try {
      const tag = await prisma.tag.findFirst({
        where: { id: tagId, tenantId: req.user.tenantId }
      });

      if (!tag) {
        res.status(StatusCodes.NOT_FOUND).json({ error: 'Tag not found in this tenant' });
        return;
      }
      res.status(StatusCodes.OK).json(tag);
      return;
    } catch (error) {
       Sentry.captureException(error);
       res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ error: 'Failed to fetch tag' });
       return;
    }

  } else {
    // Get list of tags for the tenant (with optional pagination)
    try {
      const { limit, offset } = req.query;
      const parsedLimit = limit ? Math.min(parseInt(limit, 10) || 100, 1000) : null;
      const parsedOffset = offset ? parseInt(offset, 10) || 0 : 0;

      const where = { tenantId: req.user.tenantId };

      // If limit is provided, return paginated { tags, total } format
      if (parsedLimit != null) {
        const [tags, total] = await Promise.all([
          prisma.tag.findMany({
            where,
            orderBy: { name: 'asc' },
            take: parsedLimit,
            skip: parsedOffset,
          }),
          prisma.tag.count({ where }),
        ]);
        res.status(StatusCodes.OK).json({ tags, total });
        return;
      }

      // No limit param — backward-compatible flat array
      const tags = await prisma.tag.findMany({
        where,
        orderBy: { name: 'asc' },
      });
      res.status(StatusCodes.OK).json(tags);
      return;
    } catch (error) {
       Sentry.captureException(error);
       res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ error: 'Failed to fetch tags' });
       return;
    }
  }
}

// POST /api/tags
async function handlePost(req, res) {
  const { name, color, emoji, budget, startDate, endDate } = req.body;

  if (!name) {
    res.status(StatusCodes.BAD_REQUEST).json({ error: 'Tag name is required' });
    return;
  }

  try {
    // Check if tag name already exists for this tenant
    const existingTag = await prisma.tag.findUnique({
      where: { tenantId_name: { tenantId: req.user.tenantId, name } }
    });

    if (existingTag) {
      res.status(StatusCodes.CONFLICT).json({ error: `Tag with name "${name}" already exists` });
      return;
    }

    // Create tag and audit log
    const result = await prisma.$transaction(async (prisma) => {
      const newTag = await prisma.tag.create({
        data: {
          name,
          color,
          emoji,
          ...(budget !== undefined && { budget: budget === null ? null : parseFloat(budget) }),
          ...(startDate !== undefined && { startDate: startDate ? new Date(startDate) : null }),
          ...(endDate !== undefined && { endDate: endDate ? new Date(endDate) : null }),
          tenantId: req.user.tenantId
        }
      });

      await prisma.auditLog.create({
        data: {
          userId: req.user.email,
          action: "CREATE",
          table: "Tag",
          recordId: newTag.id.toString(),
          tenantId: req.user.tenantId
        },
      });

      return newTag;
    });

    res.status(StatusCodes.CREATED).json(result);
    return;

  } catch (error) {
    Sentry.captureException(error);
    if (error.code === 'P2002') {
      res.status(StatusCodes.CONFLICT).json({ error: 'A tag with this name already exists for your tenant.' });
    } else {
      res.status(StatusCodes.BAD_REQUEST).json({
        error: 'Failed to create tag',
        ...(process.env.NODE_ENV === 'development' && { details: error.message }),
      });
    }
  }
}

// PUT /api/tags?id={tagId}
async function handlePut(req, res) {
  const { id } = req.query;
  const { name, color, emoji, budget, startDate, endDate } = req.body;

  const tagId = parseInt(id, 10);
  if (isNaN(tagId)) {
    res.status(StatusCodes.BAD_REQUEST).json({ error: 'Invalid tag ID' });
    return;
  }

  try {
    // Find the tag to update
    const existingTag = await prisma.tag.findUnique({
      where: { id: tagId, tenantId: req.user.tenantId }
    });

    if (!existingTag) {
      res.status(StatusCodes.NOT_FOUND).json({ error: 'Tag not found in this tenant' });
      return;
    }

    // If name is changing, check for conflicts
    if (name && name !== existingTag.name) {
      const conflictingTag = await prisma.tag.findUnique({
        where: { tenantId_name: { tenantId: req.user.tenantId, name } }
      });
      if (conflictingTag) {
        res.status(StatusCodes.CONFLICT).json({ error: `Tag with name "${name}" already exists` });
        return;
      }
    }

    // Prepare update data (only include fields that are provided)
    const updateData = {};
    if (name !== undefined) updateData.name = name;
    if (color !== undefined) updateData.color = color;
    if (emoji !== undefined) updateData.emoji = emoji;
    if (budget !== undefined) updateData.budget = budget === null ? null : parseFloat(budget);
    if (startDate !== undefined) updateData.startDate = startDate ? new Date(startDate) : null;
    if (endDate !== undefined) updateData.endDate = endDate ? new Date(endDate) : null;

    if (Object.keys(updateData).length === 0) {
       res.status(StatusCodes.BAD_REQUEST).json({ error: 'No fields provided for update' });
       return;
    }

    // Update tag and audit log
    const result = await prisma.$transaction(async (prisma) => {
      const updatedTag = await prisma.tag.update({
        where: { id: tagId },
        data: updateData
      });

      await prisma.auditLog.create({
        data: {
          userId: req.user.email,
          action: "UPDATE",
          table: "Tag",
          recordId: tagId.toString(),
          tenantId: req.user.tenantId
        },
      });

      return updatedTag;
    });

    res.status(StatusCodes.OK).json(result);
    return;

  } catch (error) {
    Sentry.captureException(error);
    if (error.code === 'P2002') {
      res.status(StatusCodes.CONFLICT).json({ error: 'A tag with the updated name already exists.' });
    } else {
      res.status(StatusCodes.BAD_REQUEST).json({
        error: 'Failed to update tag',
        ...(process.env.NODE_ENV === 'development' && { details: error.message }),
      });
    }
  }
}

// DELETE /api/tags?id={tagId}
async function handleDelete(req, res) {
  const { id } = req.query;

  const tagId = parseInt(id, 10);
  if (isNaN(tagId)) {
    res.status(StatusCodes.BAD_REQUEST).json({ error: 'Invalid tag ID' });
    return;
  }

  try {
    // Find the tag to delete
    const existingTag = await prisma.tag.findUnique({
      where: { id: tagId, tenantId: req.user.tenantId }
    });

    if (!existingTag) {
      res.status(StatusCodes.NOT_FOUND).json({ error: 'Tag not found in this tenant' });
      return;
    }

    // Check if tag is associated with any transactions
    const transactionCount = await prisma.transactionTag.count({
      where: { tagId: tagId }
    });

    if (transactionCount > 0) {
      res.status(StatusCodes.CONFLICT).json({ 
          error: 'Cannot delete tag', 
          details: `Tag is currently associated with ${transactionCount} transaction(s). Remove associations first.` 
      });
      return;
    }

    // Delete tag and create audit log
    await prisma.$transaction(async (prisma) => {
      await prisma.tag.delete({
        where: { id: tagId }
      });

      await prisma.auditLog.create({
        data: {
          userId: req.user.email,
          action: "DELETE",
          table: "Tag",
          recordId: tagId.toString(),
          tenantId: req.user.tenantId
        },
      });
    });

    res.status(StatusCodes.NO_CONTENT).end();
    return;

  } catch (error) {
    Sentry.captureException(error);
    res.status(StatusCodes.BAD_REQUEST).json({
      error: 'Failed to delete tag',
      ...(process.env.NODE_ENV === 'development' && { details: error.message }),
    });
  }
} 
import prisma from '../../prisma/prisma.js';
import { StatusCodes } from 'http-status-codes';
import * as Sentry from '@sentry/nextjs';
import { RelationshipType } from '@prisma/client'; // Import the enum
import { cors } from '../../utils/cors.js';
import { rateLimiters } from '../../utils/rateLimit.js';
import { withAuth } from '../../utils/withAuth.js';

export default withAuth(async function handler(req, res) {

  // Apply rate limiting
  await new Promise((resolve, reject) => {
    rateLimiters.users(req, res, (result) => {
      if (result instanceof Error) return reject(result);
      resolve(result);
    });
  });
  
  // Handle CORS
  if (cors(req, res)) return;
  
  try {
    const user = req.user;

    switch (req.method) {
      case 'GET':
        await handleGet(req, res, user);
        break;
      case 'POST':
        await handlePost(req, res, user);
        break;
      case 'PUT':
        await handlePut(req, res, user);
        break;
      case 'DELETE':
        await handleDelete(req, res, user);
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

// GET /api/users OR /api/users?id={userId}
async function handleGet(req, res, user) {
  const { id } = req.query;
  const tenantId = user.tenantId;
  if (!tenantId) {
     res.status(StatusCodes.BAD_REQUEST).json({ error: 'Tenant ID missing from user.' });
     return;
  }
  if (id) {
    const foundUser = await prisma.user.findUnique({
      where: { id: String(id) }
    });

    if (!foundUser || foundUser.tenantId !== tenantId) {
      res.status(StatusCodes.NOT_FOUND).json({ error: 'User not found or access denied' });
      return;
    }
    res.status(StatusCodes.OK).json(foundUser);
    return;
  } else {
    const users = await prisma.user.findMany({
      where: { tenantId: tenantId }
    });
    res.status(StatusCodes.OK).json(users);
    return;
  }
}

// POST /api/users
async function handlePost(req, res, user) {
  // Only admins may invite new users to the tenant
  if (user.role !== 'admin') {
    res.status(StatusCodes.FORBIDDEN).json({ error: 'Admin access required' });
    return;
  }

  const tenantId = user.tenantId;
  const { email, name, profilePictureUrl, birthDate, relationshipType, preferredLocale } = req.body;

  // --- Basic Validation ---
  if (!email) {
    res.status(StatusCodes.BAD_REQUEST).json({ error: 'Email is required.' });
    return;
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      res.status(StatusCodes.BAD_REQUEST).json({ error: 'Invalid email format.' });
      return;
  }
  if (name && (name.length < 1 || name.length > 100)) { // Allow name length 1
      res.status(StatusCodes.BAD_REQUEST).json({ error: 'User name must be between 1 and 100 characters.'});
      return;
  }
  if (relationshipType && !Object.values(RelationshipType).includes(relationshipType)) {
      res.status(StatusCodes.BAD_REQUEST).json({ error: 'Invalid relationshipType provided.', validTypes: Object.values(RelationshipType) });
      return;
  }
  let validBirthDate = null;
  if (birthDate) {
      try {
          validBirthDate = new Date(birthDate);
          if (isNaN(validBirthDate.getTime())) throw new Error('Invalid date');
      } catch (e) {
          res.status(StatusCodes.BAD_REQUEST).json({ error: 'Invalid birthDate format. Please use ISO 8601 format (YYYY-MM-DDTHH:mm:ss.sssZ).' });
          return;
      }
  }
  if (preferredLocale && (typeof preferredLocale !== 'string' || preferredLocale.trim().length === 0)) {
    res.status(StatusCodes.BAD_REQUEST).json({ error: 'Invalid preferredLocale provided. Must be a non-empty string.'});
    return;
  }
  // --- End Basic Validation ---

  try {
    // Check if email already exists within this tenant
    // The encryption middleware will handle the email encryption/decryption
    const existingUser = await prisma.user.findFirst({
        where: {
        email,
        tenantId
        }
    });

    if (existingUser) {
        res.status(StatusCodes.CONFLICT).json({ error: 'User with this email already exists in this tenant.'});
        return;
    }

    // Create new user - the encryption middleware will handle email encryption
    const newUser = await prisma.user.create({
      data: {
        email,
        tenantId,
        name: name || null,
        profilePictureUrl: profilePictureUrl || null,
        birthDate: validBirthDate || null,
        relationshipType: relationshipType || null,
        preferredLocale: preferredLocale || null
      }
    });

    // Audit Log - use unencrypted email for audit log
    await prisma.auditLog.create({
      data: {
        userId: user.email, // Use the original unencrypted email
        action: "CREATE",
        table: "User",
        recordId: newUser.id,
        tenantId: tenantId,
      },
    });

    res.status(StatusCodes.CREATED).json(newUser);
    return;

  } catch (error) {
    Sentry.captureException(error);
    res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
        error: 'Failed to create user',
        ...(process.env.NODE_ENV === 'development' && { details: error.message })
    });
  }
}

// PUT /api/users?id={userId}
async function handlePut(req, res, user) {
  const { id } = req.query;
  const tenantId = user.tenantId;
  const { name, profilePictureUrl, birthDate, relationshipType, preferredLocale, role } = req.body;

  if (!tenantId) {
     res.status(StatusCodes.BAD_REQUEST).json({ error: 'Tenant ID missing from user.' });
     return;
  }

  if (!id) {
     res.status(StatusCodes.BAD_REQUEST).json({ error: 'User ID is required in query parameters.' });
     return;
  }

  // Validate relationshipType if provided
  if (relationshipType && !Object.values(RelationshipType).includes(relationshipType)) {
      res.status(StatusCodes.BAD_REQUEST).json({ error: 'Invalid relationshipType provided.', validTypes: Object.values(RelationshipType) });
      return;
  }

  // Validate birthDate if provided
  let validBirthDate = null;
  if (birthDate) {
      try {
          validBirthDate = new Date(birthDate);
          if (isNaN(validBirthDate.getTime())) throw new Error('Invalid date');
      } catch (e) {
          res.status(StatusCodes.BAD_REQUEST).json({ error: 'Invalid birthDate format. Please use ISO 8601 format (YYYY-MM-DDTHH:mm:ss.sssZ).' });
          return;
      }
  }

  // Validate preferredLocale if provided
  if (preferredLocale && (typeof preferredLocale !== 'string' || preferredLocale.trim().length === 0)) {
    res.status(StatusCodes.BAD_REQUEST).json({ error: 'Invalid preferredLocale provided. Must be a non-empty string.'});
    return;
  }

  // Validate role if provided — only admins may change roles
  if (role !== undefined) {
    if (user.role !== 'admin') {
      res.status(StatusCodes.FORBIDDEN).json({ error: 'Only admins can change user roles.' });
      return;
    }
    if (!['admin', 'member'].includes(role)) {
      res.status(StatusCodes.BAD_REQUEST).json({ error: 'Invalid role. Must be "admin" or "member".' });
      return;
    }
  }

  try {
    // Check if user exists and belongs to the tenant
    const existingUser = await prisma.user.findFirst({
        where: {
            id: String(id),
            tenantId: tenantId
        }
    });

    if (!existingUser) {
        res.status(StatusCodes.NOT_FOUND).json({ error: 'User not found or access denied' });
        return;
    }

    // Prepare update data - only include fields that are present in the request
    const updateData = {};
    if (req.body.hasOwnProperty('name')) updateData.name = name;
    if (req.body.hasOwnProperty('profilePictureUrl')) updateData.profilePictureUrl = profilePictureUrl;
    if (req.body.hasOwnProperty('birthDate')) updateData.birthDate = validBirthDate;
    if (req.body.hasOwnProperty('relationshipType')) updateData.relationshipType = relationshipType;
    if (req.body.hasOwnProperty('preferredLocale')) updateData.preferredLocale = preferredLocale;
    if (req.body.hasOwnProperty('role')) updateData.role = role;

    if (Object.keys(updateData).length === 0) {
        res.status(StatusCodes.BAD_REQUEST).json({ error: 'No valid fields provided for update.' });
        return;
    }

    const updatedUser = await prisma.user.update({
      where: { id: String(id) },
      data: updateData
    });

    // Audit Log
    await prisma.auditLog.create({
      data: {
        userId: user.email,
        action: "UPDATE",
        table: "User",
        recordId: updatedUser.id,
        tenantId: tenantId,
      },
    });

    res.status(StatusCodes.OK).json(updatedUser);
    return;

  } catch (error) {
    Sentry.captureException(error);
    // Handle potential errors like unique constraint violations if email were updatable
    res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
        error: 'Failed to update user',
        ...(process.env.NODE_ENV === 'development' && { details: error.message })
    });
  }
}

// DELETE /api/users?id={userId}
async function handleDelete(req, res, user) {
  // Only admins may remove users from the tenant
  if (user.role !== 'admin') {
    res.status(StatusCodes.FORBIDDEN).json({ error: 'Admin access required' });
    return;
  }

  const { id } = req.query;
  const tenantId = user.tenantId;

  if (!tenantId) {
    res.status(StatusCodes.BAD_REQUEST).json({ error: 'Tenant ID missing from user.' });
    return;
  }

  if (!id) {
    res.status(StatusCodes.BAD_REQUEST).json({ error: 'User ID is required in query parameters.' });
    return;
  }

  if (id === user.id) {
    res.status(StatusCodes.FORBIDDEN).json({ error: 'Users cannot delete themselves.' });
    return;
  }

  try {
    // Check how many users are left in the tenant
    const userCount = await prisma.user.count({
        where: { tenantId: tenantId }
    });

    if (userCount <= 1) {
        res.status(StatusCodes.FORBIDDEN).json({ error: 'Cannot delete the last user of a tenant.' });
        return;
    }

    // Check if the user to be deleted exists and belongs to the tenant
    const userToDelete = await prisma.user.findFirst({
        where: {
            id: String(id),
            tenantId: tenantId
        }
    });

    if (!userToDelete) {
        res.status(StatusCodes.NOT_FOUND).json({ error: 'User not found or access denied' });
        return;
    }

    // Perform deletion within a transaction to ensure atomicity
    await prisma.$transaction(async (prisma) => {

        // 1. Delete related AccountOwner entries
        await prisma.accountOwner.deleteMany({
            where: { userId: String(id) }
        });

        // 2. Create Audit Log BEFORE deleting the user record
        await prisma.auditLog.create({
            data: {
                userId: user.email,
                action: "DELETE",
                table: "User",
                recordId: String(id),
                tenantId: tenantId,
            },
        });

        // 3. Delete the user
        await prisma.user.delete({
            where: { id: String(id) }
        });
    });

    res.status(StatusCodes.NO_CONTENT).end();
    return;

  } catch (error) {
    Sentry.captureException(error);
    res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
        error: 'Failed to delete user',
        ...(process.env.NODE_ENV === 'development' && { details: error.message })
    });
  }
} 
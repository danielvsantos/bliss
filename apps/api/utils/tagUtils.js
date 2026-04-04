import prisma from '../prisma/prisma.js';

/**
 * Find or create tags by name for a tenant.
 * For each name string: looks up existing tag, creates if not found.
 * Handles P2002 race condition (concurrent creates) gracefully.
 *
 * @param {string[]} tagNames - Array of tag name strings
 * @param {string} tenantId - Tenant ID
 * @param {string} userId - User ID (email) for audit logging
 * @returns {Promise<Array<{id: number, name: string}>>}
 */
export async function resolveTagsByName(tagNames, tenantId, userId) {
  if (!tagNames || !Array.isArray(tagNames) || tagNames.length === 0) {
    return [];
  }

  const results = [];

  for (const rawName of tagNames) {
    const name = typeof rawName === 'string' ? rawName.trim() : '';
    if (!name) continue;

    let tag = await prisma.tag.findFirst({ where: { name, tenantId } });
    if (!tag) {
      try {
        tag = await prisma.tag.create({
          data: {
            name,
            tenantId,
            color: '#' + Math.floor(Math.random() * 16777215).toString(16),
          },
        });

      } catch (e) {
        // Race condition: another concurrent request created the same tag
        if (e.code === 'P2002') {
          tag = await prisma.tag.findFirst({ where: { name, tenantId } });
        } else {
          throw e;
        }
      }
    }

    if (tag) {
      results.push({ id: tag.id, name: tag.name });
    }
  }

  return results;
}

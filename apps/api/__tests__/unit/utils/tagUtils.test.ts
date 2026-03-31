/**
 * Unit tests for resolveTagsByName() — shared tag find-or-create utility.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock Prisma — use vi.hoisted() so the object is available before vi.mock hoisting
const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    tag: { findFirst: vi.fn(), create: vi.fn() },
    auditLog: { create: vi.fn() },
  },
}));

vi.mock('../../../prisma/prisma.js', () => ({
  default: mockPrisma,
}));

import { resolveTagsByName } from '../../../utils/tagUtils.js';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('resolveTagsByName', () => {
  const tenantId = 'test-tenant-123';
  const userId = 'user@test.com';

  it('returns empty array for null input', async () => {
    const result = await resolveTagsByName(null, tenantId, userId);
    expect(result).toEqual([]);
    expect(mockPrisma.tag.findFirst).not.toHaveBeenCalled();
  });

  it('returns empty array for empty array input', async () => {
    const result = await resolveTagsByName([], tenantId, userId);
    expect(result).toEqual([]);
    expect(mockPrisma.tag.findFirst).not.toHaveBeenCalled();
  });

  it('returns empty array for undefined input', async () => {
    const result = await resolveTagsByName(undefined, tenantId, userId);
    expect(result).toEqual([]);
  });

  it('returns existing tags without creating duplicates', async () => {
    mockPrisma.tag.findFirst.mockResolvedValueOnce({ id: 1, name: 'Japan 2026' });

    const result = await resolveTagsByName(['Japan 2026'], tenantId, userId);

    expect(result).toEqual([{ id: 1, name: 'Japan 2026' }]);
    expect(mockPrisma.tag.create).not.toHaveBeenCalled();
    expect(mockPrisma.auditLog.create).not.toHaveBeenCalled();
  });

  it('creates new tags with random color and audit log', async () => {
    mockPrisma.tag.findFirst.mockResolvedValueOnce(null);
    mockPrisma.tag.create.mockResolvedValueOnce({ id: 42, name: 'Business' });
    mockPrisma.auditLog.create.mockResolvedValueOnce({});

    const result = await resolveTagsByName(['Business'], tenantId, userId);

    expect(result).toEqual([{ id: 42, name: 'Business' }]);
    expect(mockPrisma.tag.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        name: 'Business',
        tenantId,
        color: expect.stringMatching(/^#[0-9a-f]+$/),
      }),
    });
    expect(mockPrisma.auditLog.create).toHaveBeenCalledWith({
      data: {
        userId,
        action: 'CREATE',
        table: 'Tag',
        recordId: '42',
        tenantId,
      },
    });
  });

  it('trims whitespace from tag names', async () => {
    mockPrisma.tag.findFirst.mockResolvedValueOnce({ id: 5, name: 'Travel' });

    const result = await resolveTagsByName(['  Travel  '], tenantId, userId);

    expect(result).toEqual([{ id: 5, name: 'Travel' }]);
    expect(mockPrisma.tag.findFirst).toHaveBeenCalledWith({
      where: { name: 'Travel', tenantId },
    });
  });

  it('filters out non-string and empty values', async () => {
    mockPrisma.tag.findFirst.mockResolvedValueOnce({ id: 1, name: 'Valid' });

    const result = await resolveTagsByName(
      ['Valid', '', '  ', 123 as any, null as any, undefined as any],
      tenantId,
      userId,
    );

    expect(result).toEqual([{ id: 1, name: 'Valid' }]);
    // Only one findFirst call for "Valid"
    expect(mockPrisma.tag.findFirst).toHaveBeenCalledTimes(1);
  });

  it('handles P2002 race condition gracefully', async () => {
    // First findFirst: not found
    mockPrisma.tag.findFirst
      .mockResolvedValueOnce(null)
      // Second findFirst after P2002: found
      .mockResolvedValueOnce({ id: 99, name: 'RaceTag' });

    // create throws P2002 (unique constraint violation)
    const p2002Error = new Error('Unique constraint failed') as any;
    p2002Error.code = 'P2002';
    mockPrisma.tag.create.mockRejectedValueOnce(p2002Error);

    const result = await resolveTagsByName(['RaceTag'], tenantId, userId);

    expect(result).toEqual([{ id: 99, name: 'RaceTag' }]);
    expect(mockPrisma.tag.findFirst).toHaveBeenCalledTimes(2);
  });

  it('rethrows non-P2002 errors', async () => {
    mockPrisma.tag.findFirst.mockResolvedValueOnce(null);
    mockPrisma.tag.create.mockRejectedValueOnce(new Error('DB connection lost'));

    await expect(resolveTagsByName(['Fail'], tenantId, userId)).rejects.toThrow('DB connection lost');
  });

  it('handles multiple tags — mix of existing and new', async () => {
    // Tag 1: exists
    mockPrisma.tag.findFirst.mockResolvedValueOnce({ id: 1, name: 'Japan 2026' });
    // Tag 2: new
    mockPrisma.tag.findFirst.mockResolvedValueOnce(null);
    mockPrisma.tag.create.mockResolvedValueOnce({ id: 2, name: 'Business' });
    mockPrisma.auditLog.create.mockResolvedValueOnce({});

    const result = await resolveTagsByName(['Japan 2026', 'Business'], tenantId, userId);

    expect(result).toEqual([
      { id: 1, name: 'Japan 2026' },
      { id: 2, name: 'Business' },
    ]);
    expect(mockPrisma.tag.create).toHaveBeenCalledTimes(1);
  });
});

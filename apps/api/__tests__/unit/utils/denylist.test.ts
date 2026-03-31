import { describe, it, expect, vi, beforeEach } from 'vitest';

// Hoisted mock functions so they're available before vi.mock runs
const mockSet = vi.hoisted(() => vi.fn().mockResolvedValue('OK'));
const mockExists = vi.hoisted(() => vi.fn().mockResolvedValue(0));

vi.mock('ioredis', () => {
  return {
    default: class MockRedis {
      set = mockSet;
      exists = mockExists;
      on = vi.fn();
    },
  };
});

describe('denylist', () => {
  describe('with REDIS_URL set', () => {
    let addToDenylist: typeof import('../../../utils/denylist.js').addToDenylist;
    let isRevoked: typeof import('../../../utils/denylist.js').isRevoked;

    beforeEach(async () => {
      vi.clearAllMocks();
      vi.resetModules();
      process.env.REDIS_URL = 'redis://localhost:6379';
      const mod = await import('../../../utils/denylist.js');
      addToDenylist = mod.addToDenylist;
      isRevoked = mod.isRevoked;
    });

    it('addToDenylist — calls redis.set with correct key, value, EX, and ttl', async () => {
      await addToDenylist('abc-123', 300);

      expect(mockSet).toHaveBeenCalledWith('denylist:abc-123', '1', 'EX', 300);
    });

    it('addToDenylist — enforces minimum TTL of 1', async () => {
      await addToDenylist('short-lived', 0.2);

      expect(mockSet).toHaveBeenCalledWith('denylist:short-lived', '1', 'EX', 1);
    });

    it('addToDenylist — catches Redis errors without throwing', async () => {
      mockSet.mockRejectedValueOnce(new Error('connection refused'));

      await expect(addToDenylist('err-jti', 60)).resolves.toBeUndefined();
    });

    it('isRevoked — returns true when jti exists in Redis (exists returns 1)', async () => {
      mockExists.mockResolvedValueOnce(1);

      const result = await isRevoked('revoked-jti');

      expect(mockExists).toHaveBeenCalledWith('denylist:revoked-jti');
      expect(result).toBe(true);
    });

    it('isRevoked — returns false when jti does not exist (exists returns 0)', async () => {
      mockExists.mockResolvedValueOnce(0);

      const result = await isRevoked('valid-jti');

      expect(mockExists).toHaveBeenCalledWith('denylist:valid-jti');
      expect(result).toBe(false);
    });
  });

  describe('without REDIS_URL', () => {
    let addToDenylist: typeof import('../../../utils/denylist.js').addToDenylist;
    let isRevoked: typeof import('../../../utils/denylist.js').isRevoked;

    beforeEach(async () => {
      vi.clearAllMocks();
      vi.resetModules();
      delete process.env.REDIS_URL;
      const mod = await import('../../../utils/denylist.js');
      addToDenylist = mod.addToDenylist;
      isRevoked = mod.isRevoked;
    });

    it('addToDenylist — no-ops when REDIS_URL is not set', async () => {
      await expect(addToDenylist('some-jti', 120)).resolves.toBeUndefined();
      expect(mockSet).not.toHaveBeenCalled();
    });

    it('isRevoked — returns false when REDIS_URL is not set', async () => {
      const result = await isRevoked('some-jti');

      expect(result).toBe(false);
      expect(mockExists).not.toHaveBeenCalled();
    });
  });
});

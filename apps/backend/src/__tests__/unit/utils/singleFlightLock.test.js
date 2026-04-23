/**
 * Unit tests for the Redis-backed single-flight lock helper.
 *
 * ioredis is mocked so we can assert on the exact Redis commands
 * without requiring a live Redis connection. The contract we care
 * about:
 *
 *   - `acquire` uses `SET key value EX ttl NX` (atomic acquire-or-fail)
 *   - `release` uses `DEL`
 *   - `isHeld` uses `TTL`, returns -2 as "not held", any non-negative
 *     value as "held"
 */

const mockSet = jest.fn();
const mockDel = jest.fn();
const mockTtl = jest.fn();

jest.mock('../../../utils/redis', () => ({
  getRedisConnection: jest.fn(() => ({
    set: mockSet,
    del: mockDel,
    ttl: mockTtl,
  })),
}));

const { acquire, release, isHeld } = require('../../../utils/singleFlightLock');

describe('singleFlightLock', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('acquire', () => {
    it('returns true when Redis SET NX succeeds', async () => {
      mockSet.mockResolvedValueOnce('OK');

      const ok = await acquire('rebuild-lock:t1:full-portfolio', 3600);

      expect(ok).toBe(true);
      expect(mockSet).toHaveBeenCalledWith(
        'rebuild-lock:t1:full-portfolio',
        '1',
        'EX',
        3600,
        'NX',
      );
    });

    it('returns false when the key already exists (NX fails)', async () => {
      // ioredis returns null when SET NX didn't take effect.
      mockSet.mockResolvedValueOnce(null);

      const ok = await acquire('rebuild-lock:t1:full-portfolio', 3600);

      expect(ok).toBe(false);
    });
  });

  describe('release', () => {
    it('calls DEL on the key', async () => {
      mockDel.mockResolvedValueOnce(1);

      await release('rebuild-lock:t1:full-portfolio');

      expect(mockDel).toHaveBeenCalledWith('rebuild-lock:t1:full-portfolio');
    });

    it('does not throw when the key is already gone (DEL returns 0)', async () => {
      mockDel.mockResolvedValueOnce(0);

      await expect(release('some-key')).resolves.toBeUndefined();
    });
  });

  describe('isHeld', () => {
    it('returns { held: false, ttlSeconds: null } when TTL is -2 (no key)', async () => {
      mockTtl.mockResolvedValueOnce(-2);

      const r = await isHeld('rebuild-lock:t1:full-portfolio');

      expect(r).toEqual({ held: false, ttlSeconds: null });
    });

    it('returns { held: true, ttlSeconds } with remaining seconds', async () => {
      mockTtl.mockResolvedValueOnce(1234);

      const r = await isHeld('rebuild-lock:t1:full-portfolio');

      expect(r).toEqual({ held: true, ttlSeconds: 1234 });
    });

    it('returns { held: true, ttlSeconds: -1 } when key exists without expire', async () => {
      // Shouldn't happen in normal usage since we always SET EX, but
      // the helper shouldn't crash if it does.
      mockTtl.mockResolvedValueOnce(-1);

      const r = await isHeld('some-key');

      expect(r).toEqual({ held: true, ttlSeconds: -1 });
    });
  });
});

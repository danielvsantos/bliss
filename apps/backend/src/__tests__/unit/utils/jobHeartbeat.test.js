jest.mock('../../../utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const { createHeartbeat } = require('../../../utils/jobHeartbeat');
const logger = require('../../../utils/logger');

describe('createHeartbeat()', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('no-op when prerequisites are missing', () => {
    it('returns an async no-op when job is null', async () => {
      const heartbeat = createHeartbeat(null, 'token');
      await expect(heartbeat()).resolves.toBeUndefined();
    });

    it('returns an async no-op when token is null', async () => {
      const job = { id: 'job-1', extendLock: jest.fn() };
      const heartbeat = createHeartbeat(job, null);
      await expect(heartbeat()).resolves.toBeUndefined();
      expect(job.extendLock).not.toHaveBeenCalled();
    });

    it('returns an async no-op when token is undefined', async () => {
      const job = { id: 'job-1', extendLock: jest.fn() };
      const heartbeat = createHeartbeat(job, undefined);
      await expect(heartbeat()).resolves.toBeUndefined();
      expect(job.extendLock).not.toHaveBeenCalled();
    });

    it('returns an async no-op when job.extendLock is not a function', async () => {
      const job = { id: 'job-1' }; // no extendLock
      const heartbeat = createHeartbeat(job, 'token');
      await expect(heartbeat()).resolves.toBeUndefined();
    });

    it('returns an async no-op when job is undefined', async () => {
      const heartbeat = createHeartbeat(undefined, 'token');
      await expect(heartbeat()).resolves.toBeUndefined();
    });
  });

  describe('rate-limiting (intervalMs)', () => {
    it('does NOT call extendLock when called before intervalMs elapses', async () => {
      const extendLock = jest.fn().mockResolvedValue(undefined);
      const job = { id: 'job-1', extendLock };
      const heartbeat = createHeartbeat(job, 'token', { intervalMs: 30_000, name: 'test' });

      // First call at t=0 should extend (lastExtend starts in the past just enough)
      jest.setSystemTime(Date.now() + 30_001);
      await heartbeat();
      expect(extendLock).toHaveBeenCalledTimes(1);

      // Second call immediately after should be rate-limited
      await heartbeat();
      expect(extendLock).toHaveBeenCalledTimes(1);
    });

    it('calls extendLock again after intervalMs has elapsed since last extend', async () => {
      const extendLock = jest.fn().mockResolvedValue(undefined);
      const job = { id: 'job-1', extendLock };
      const now = Date.now();

      jest.setSystemTime(now + 30_001);
      const heartbeat = createHeartbeat(job, 'token', { intervalMs: 30_000, name: 'test' });

      await heartbeat(); // triggers extend
      expect(extendLock).toHaveBeenCalledTimes(1);

      // Advance time past the interval
      jest.setSystemTime(now + 60_002);
      await heartbeat(); // should trigger again
      expect(extendLock).toHaveBeenCalledTimes(2);
    });
  });

  describe('extendLock call parameters', () => {
    it('calls extendLock with the correct token and lockDurationMs', async () => {
      const extendLock = jest.fn().mockResolvedValue(undefined);
      const job = { id: 'job-2', extendLock };
      const now = Date.now();
      jest.setSystemTime(now + 300_001);

      const heartbeat = createHeartbeat(job, 'my-token', {
        intervalMs: 30_000,
        lockDurationMs: 300_000,
        name: 'testWorker',
      });

      await heartbeat();
      expect(extendLock).toHaveBeenCalledWith('my-token', 300_000);
    });
  });

  describe('error handling', () => {
    it('logs a warning and rethrows when extendLock fails', async () => {
      const lockError = new Error('Redis connection lost');
      const extendLock = jest.fn().mockRejectedValue(lockError);
      const job = { id: 'job-3', extendLock };
      const now = Date.now();
      jest.setSystemTime(now + 30_001);

      const heartbeat = createHeartbeat(job, 'token', {
        intervalMs: 30_000,
        name: 'analyticsWorker',
      });

      await expect(heartbeat()).rejects.toThrow('Redis connection lost');
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('analyticsWorker'),
        expect.objectContaining({ jobId: 'job-3', error: 'Redis connection lost' })
      );
    });
  });

  describe('default option values', () => {
    it('uses default intervalMs of 30s, lockDurationMs of 300s, and name of "heartbeat"', async () => {
      const extendLock = jest.fn().mockResolvedValue(undefined);
      const job = { id: 'job-4', extendLock };
      const now = Date.now();
      jest.setSystemTime(now + 30_001);

      const heartbeat = createHeartbeat(job, 'token');
      await heartbeat();

      expect(extendLock).toHaveBeenCalledWith('token', 300_000);
    });
  });
});

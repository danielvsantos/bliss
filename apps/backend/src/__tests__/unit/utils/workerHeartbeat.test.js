const mockRedis = { set: jest.fn(), get: jest.fn() };

jest.mock('../../../utils/redis', () => ({
  getRedisConnection: jest.fn(() => mockRedis),
}));

jest.mock('../../../utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const {
  startWorkerHeartbeat,
  stopWorkerHeartbeat,
  readWorkerHeartbeat,
  HEARTBEAT_KEY,
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_TTL_SECONDS,
} = require('../../../utils/workerHeartbeat');
const logger = require('../../../utils/logger');

describe('workerHeartbeat', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    mockRedis.set.mockResolvedValue('OK');
    stopWorkerHeartbeat();
  });

  afterEach(() => {
    stopWorkerHeartbeat();
    jest.useRealTimers();
  });

  // The TTL must exceed the interval, or a single slow beat (a GC pause, a busy
  // event loop during a large import) makes a perfectly healthy worker look
  // dead. This is the invariant the whole liveness signal rests on.
  it('has a TTL comfortably longer than the write interval', () => {
    expect(HEARTBEAT_TTL_SECONDS * 1000).toBeGreaterThan(HEARTBEAT_INTERVAL_MS * 2);
  });

  describe('publishing', () => {
    it('writes immediately on start rather than waiting a full interval', async () => {
      startWorkerHeartbeat();
      await Promise.resolve();

      expect(mockRedis.set).toHaveBeenCalledTimes(1);
      const [key, , mode, ttl] = mockRedis.set.mock.calls[0];
      expect(key).toBe(HEARTBEAT_KEY);
      expect(mode).toBe('EX');
      expect(ttl).toBe(HEARTBEAT_TTL_SECONDS);
    });

    it('publishes the worker runtime, tagged with its role', async () => {
      startWorkerHeartbeat();
      await Promise.resolve();

      const payload = JSON.parse(mockRedis.set.mock.calls[0][1]);
      expect(payload.role).toBe('backend-worker');
      expect(payload.node).toBe(process.version);
      expect(payload.heartbeatAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(payload.dependencies).toBeDefined();
    });

    it('keeps beating on the interval', async () => {
      startWorkerHeartbeat();
      await Promise.resolve();
      expect(mockRedis.set).toHaveBeenCalledTimes(1);

      jest.advanceTimersByTime(HEARTBEAT_INTERVAL_MS * 3);
      expect(mockRedis.set).toHaveBeenCalledTimes(4);
    });

    it('is idempotent — a second start does not double the beat rate', async () => {
      startWorkerHeartbeat();
      startWorkerHeartbeat();
      await Promise.resolve();
      mockRedis.set.mockClear();

      jest.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);
      expect(mockRedis.set).toHaveBeenCalledTimes(1);
    });

    it('stops beating after stop', async () => {
      startWorkerHeartbeat();
      await Promise.resolve();
      stopWorkerHeartbeat();
      mockRedis.set.mockClear();

      jest.advanceTimersByTime(HEARTBEAT_INTERVAL_MS * 5);
      expect(mockRedis.set).not.toHaveBeenCalled();
    });

    // A diagnostic that can take the worker process down is worse than no
    // diagnostic. The missing key is itself the signal.
    it('logs and swallows a Redis write failure', async () => {
      mockRedis.set.mockRejectedValue(new Error('Redis down'));

      expect(() => startWorkerHeartbeat()).not.toThrow();
      // Let the rejected write settle through the .catch().
      await Promise.resolve();
      await Promise.resolve();

      expect(logger.warn).toHaveBeenCalledWith(
        '[runtime] worker heartbeat write failed',
        { error: 'Redis down' },
      );
    });
  });

  describe('reading', () => {
    it('returns the parsed payload as alive', async () => {
      mockRedis.get.mockResolvedValue(JSON.stringify({ role: 'backend-worker', node: 'v22.0.0' }));

      const result = await readWorkerHeartbeat();

      expect(result.status).toBe('alive');
      expect(result.node).toBe('v22.0.0');
    });

    // A lapsed TTL is the whole point: it means the worker is down or wedged,
    // which Bliss otherwise has no way to surface.
    it('reports absent when the key has expired', async () => {
      mockRedis.get.mockResolvedValue(null);

      const result = await readWorkerHeartbeat();

      expect(result.status).toBe('absent');
      expect(result.note).toMatch(/down, wedged, or has not been deployed/i);
    });

    it('never throws when Redis is unreachable', async () => {
      mockRedis.get.mockRejectedValue(new Error('ECONNREFUSED'));

      const result = await readWorkerHeartbeat();

      expect(result.status).toBe('unavailable');
      expect(result.note).toContain('ECONNREFUSED');
    });

    it('never throws on a corrupt payload', async () => {
      mockRedis.get.mockResolvedValue('{not json');

      const result = await readWorkerHeartbeat();

      expect(result.status).toBe('unavailable');
    });
  });
});

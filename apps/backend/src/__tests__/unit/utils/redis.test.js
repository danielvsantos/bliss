// ─── redis.test.js ──────────────────────────────────────────────────────────
// Unit tests for Redis utility: initializeRedis(), disconnectRedis(),
// getRedisConnection(). Verifies lifecycle management, keepalive ping
// interval, and error handling.
//
// Each test re-requires the redis module after jest.resetModules() to get a
// fresh module-scope (redisConnection = undefined, pingInterval = undefined).
// The ioredis constructor mock captures the 'connect' callback and fires it
// synchronously so that the Promise returned by initializeRedis() resolves.

jest.mock('../../../utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

/** Build a fresh mock Redis instance for each test. */
function createMockRedis() {
  const listeners = {};
  return {
    on: jest.fn((event, cb) => { listeners[event] = cb; }),
    quit: jest.fn().mockResolvedValue('OK'),
    ping: jest.fn().mockResolvedValue('PONG'),
    config: jest.fn().mockResolvedValue(['timeout', '0']),
    status: 'ready',
    _listeners: listeners,
    /** Simulate ioredis emitting the 'connect' event. */
    _emitConnect() { if (listeners.connect) listeners.connect(); },
    _emitError(err) { if (listeners.error) listeners.error(err); },
  };
}

let mockInstance;

describe('redis utility', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    jest.resetModules();

    // Create a fresh mock for each test
    mockInstance = createMockRedis();

    // Re-mock ioredis with the fresh instance
    jest.mock('ioredis', () => jest.fn().mockImplementation(() => mockInstance));
    jest.mock('../../../utils/logger', () => ({
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    }));

    process.env.REDIS_URL = 'redis://localhost:6379';
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  /** Helper: require a fresh redis module and init, firing the connect event. */
  async function requireAndInit() {
    const mod = require('../../../utils/redis');
    const initPromise = mod.initializeRedis();
    // The 'on' call is synchronous, so the connect listener is already registered.
    mockInstance._emitConnect();
    const conn = await initPromise;
    return { mod, conn };
  }

  // 1. getRedisConnection() throws before init
  it('throws when getRedisConnection() is called before initializeRedis()', () => {
    const mod = require('../../../utils/redis');
    expect(() => mod.getRedisConnection()).toThrow(
      'Redis has not been initialized. Please call initializeRedis first.'
    );
  });

  // 2. initializeRedis() creates connection and starts ping interval
  it('creates an ioredis connection and starts keepalive ping interval', async () => {
    const Redis = require('ioredis');
    const { conn } = await requireAndInit();

    expect(Redis).toHaveBeenCalledWith(
      'redis://localhost:6379',
      expect.objectContaining({
        maxRetriesPerRequest: null,
        enableReadyCheck: false,
        keepAlive: 10000,
      })
    );
    expect(conn).toBe(mockInstance);
    expect(mockInstance.on).toHaveBeenCalledWith('connect', expect.any(Function));
    expect(mockInstance.on).toHaveBeenCalledWith('error', expect.any(Function));

    // Verify ping interval fires after 30s
    jest.advanceTimersByTime(30_000);
    expect(mockInstance.ping).toHaveBeenCalled();
  });

  // 3. getRedisConnection() returns connection after init
  it('returns the connection after initialization', async () => {
    const { mod } = await requireAndInit();
    const conn = mod.getRedisConnection();
    expect(conn).toBe(mockInstance);
  });

  // 4. disconnectRedis() calls quit and clears interval
  it('calls quit() and clears ping interval on disconnect', async () => {
    const { mod } = await requireAndInit();

    await mod.disconnectRedis();

    expect(mockInstance.quit).toHaveBeenCalledTimes(1);

    // After disconnect, advancing timers should NOT trigger more pings
    mockInstance.ping.mockClear();
    jest.advanceTimersByTime(60_000);
    expect(mockInstance.ping).not.toHaveBeenCalled();
  });

  // 5. Multiple init calls reuse existing connection
  it('reuses existing connection on subsequent initializeRedis() calls', async () => {
    const { mod, conn: conn1 } = await requireAndInit();

    // Second init — the module already has a redisConnection, but it still
    // creates a new Redis and the 'connect' handler runs. Both resolve to
    // the same mockInstance because our factory always returns the same object.
    const initPromise2 = mod.initializeRedis();
    mockInstance._emitConnect();
    const conn2 = await initPromise2;

    expect(conn1).toBe(conn2);
  });

  // 6. initializeRedis() rejects when REDIS_URL is not set
  it('rejects when REDIS_URL is not defined', async () => {
    delete process.env.REDIS_URL;

    jest.resetModules();
    jest.mock('ioredis', () => jest.fn().mockImplementation(() => mockInstance));
    jest.mock('../../../utils/logger', () => ({
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    }));

    const freshModule = require('../../../utils/redis');
    await expect(freshModule.initializeRedis()).rejects.toThrow('REDIS_URL is not defined.');
  });

  // 7. Ping interval does not fire when connection status is not ready
  it('skips ping when connection status is not ready', async () => {
    await requireAndInit();
    mockInstance.ping.mockClear();

    mockInstance.status = 'connecting';
    jest.advanceTimersByTime(30_000);
    expect(mockInstance.ping).not.toHaveBeenCalled();
  });
});

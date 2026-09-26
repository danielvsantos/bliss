const express = require('express');
const request = require('supertest');

jest.mock('../../../utils/workerHeartbeat', () => ({
  readWorkerHeartbeat: jest.fn(),
}));

const runtimeRouter = require('../../../routes/runtime');
const { readWorkerHeartbeat } = require('../../../utils/workerHeartbeat');

const API_KEY = 'test-internal-api-key-32-chars!!';

function makeApp() {
  const app = express();
  app.use('/api/runtime', runtimeRouter);
  return app;
}

describe('GET /api/runtime', () => {
  const ORIGINAL_KEY = process.env.INTERNAL_API_KEY;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.INTERNAL_API_KEY = API_KEY;
    readWorkerHeartbeat.mockResolvedValue({ status: 'alive', role: 'backend-worker' });
  });

  afterAll(() => {
    process.env.INTERNAL_API_KEY = ORIGINAL_KEY;
  });

  // The whole point of putting this behind apiKeyAuth rather than on /health:
  // exact runtime and dependency versions turn an untargeted scan into a
  // targeted CVE lookup. These assertions are the guard against someone later
  // "simplifying" it onto an unauthenticated route.
  describe('is not reachable without the internal API key', () => {
    it.each([
      ['no header', undefined],
      ['wrong key of the same length', 'wrong-internal-api-key-32-chars!'],
      ['wrong key of a different length', 'x'],
      ['empty key', ''],
    ])('returns 401 for %s', async (_label, key) => {
      const req = request(makeApp()).get('/api/runtime');
      if (key !== undefined) req.set('x-api-key', key);

      const res = await req;

      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: 'Unauthorized' });
    });

    it('leaks nothing in the 401 body', async () => {
      const res = await request(makeApp()).get('/api/runtime');

      const body = JSON.stringify(res.body);
      expect(body).not.toContain(process.version);
      expect(body).not.toMatch(/node|axios|version/i);
    });
  });

  describe('with a valid key', () => {
    it('identifies itself as the backend web role', async () => {
      const res = await request(makeApp())
        .get('/api/runtime')
        .set('x-api-key', API_KEY);

      expect(res.body.role).toBe('backend-web');
      expect(res.body.commit).toEqual(expect.any(String));
    });

    // The worker has no HTTP server at all, so this is the only channel by
    // which its runtime can ever be observed.
    it('includes the worker heartbeat read from Redis', async () => {
      const res = await request(makeApp())
        .get('/api/runtime')
        .set('x-api-key', API_KEY);

      expect(res.body.worker).toEqual({ status: 'alive', role: 'backend-worker' });
    });

    it('still answers when the worker heartbeat is absent', async () => {
      readWorkerHeartbeat.mockResolvedValue({ status: 'absent', note: 'no key' });

      const res = await request(makeApp())
        .get('/api/runtime')
        .set('x-api-key', API_KEY);

      expect(res.status).toBe(200);
      expect(res.body.node).toBe(process.version);
      expect(res.body.worker.status).toBe('absent');
    });

    it('reports the running Node version', async () => {
      const res = await request(makeApp())
        .get('/api/runtime')
        .set('x-api-key', API_KEY);

      expect(res.status).toBe(200);
      expect(res.body.node).toBe(process.version);
      expect(res.body.node).toMatch(/^v\d+\.\d+\.\d+/);
    });

    it('reports platform, arch, libc flavour and start mode', async () => {
      const res = await request(makeApp())
        .get('/api/runtime')
        .set('x-api-key', API_KEY);

      expect(res.body.platform).toBe(process.platform);
      expect(res.body.arch).toBe(process.arch);
      expect(['glibc', 'musl']).toContain(res.body.libc);
      expect(typeof res.body.startMode).toBe('string');
      expect(typeof res.body.uptimeSeconds).toBe('number');
    });

    it('resolves every tracked package in this service tree', async () => {
      const res = await request(makeApp())
        .get('/api/runtime')
        .set('x-api-key', API_KEY);

      // Every package in TRACKED_PACKAGES is either a direct backend
      // dependency or reachable through a declared `via` parent, so a null
      // here means resolution broke — not that the package is missing.
      const unresolved = Object.entries(res.body.dependencies)
        .filter(([, version]) => version === null)
        .map(([name]) => name);

      expect(unresolved).toEqual([]);
    });

    // These four are pinned by pnpm.overrides in the root package.json because
    // their own parents still resolve to vulnerable versions. A silently
    // unapplied override is exactly the failure this endpoint exists to catch,
    // so assert the floors rather than just "some version string".
    it.each([
      ['axios', 1, 18],
      ['ws', 8, 21],
      ['lodash', 4, 18],
      ['form-data', 4, 0],
    ])('reports %s at or above the pinned security floor', async (name, major, minor) => {
      const res = await request(makeApp())
        .get('/api/runtime')
        .set('x-api-key', API_KEY);

      const version = res.body.dependencies[name];
      expect(version).toMatch(/^\d+\.\d+\.\d+/);

      const [gotMajor, gotMinor] = version.split('.').map(Number);
      expect(gotMajor).toBeGreaterThanOrEqual(major);
      if (gotMajor === major) expect(gotMinor).toBeGreaterThanOrEqual(minor);
    });

        // null has to mean "genuinely not installed", not "the lookup failed" —
    // otherwise a vulnerable version and an absent one look identical. ws was
    // the one the first deployed build reported as null.
    it('resolves ws, which is only reachable through its optional peer parent', async () => {
      const res = await request(makeApp())
        .get('/api/runtime')
        .set('x-api-key', API_KEY);

      expect(res.body.dependencies.ws).toMatch(/^\d+\.\d+\.\d+/);
    });

    it('resolves a package whose exports map blocks deep package.json imports', async () => {
      // openai reports ERR_PACKAGE_PATH_NOT_EXPORTED for
      // require('openai/package.json'), which looks nothing like a missing
      // install — the walk-up fallback is what makes it resolvable.
      const res = await request(makeApp())
        .get('/api/runtime')
        .set('x-api-key', API_KEY);

      expect(res.body.dependencies.openai).toMatch(/^\d+\.\d+\.\d+/);
    });

    // Docker images are pruned per service. A package that cannot be resolved
    // must report null, not turn the endpoint into a 500 — otherwise the
    // diagnostic breaks exactly when something is wrong enough to need it.
    it('never returns a malformed version, and never 500s', async () => {
      const res = await request(makeApp())
        .get('/api/runtime')
        .set('x-api-key', API_KEY);

      expect(res.status).toBe(200);

      // Collect offenders so a failure names the package rather than just
      // reporting "expected true, got false".
      const invalid = Object.entries(res.body.dependencies)
        .filter(([, version]) => version !== null && !/^\d+\.\d+\.\d+/.test(version))
        .map(([name, version]) => `${name}=${version}`);

      expect(invalid).toEqual([]);
    });
  });
});

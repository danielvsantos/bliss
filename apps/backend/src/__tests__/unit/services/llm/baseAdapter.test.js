// Mock external dependencies before requiring the module under test
jest.mock('../../../../utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const MODULE_PATH = '../../../../services/llm/baseAdapter';

/** Load a fresh copy of baseAdapter with the given env overrides. */
function loadWithEnv(env = {}) {
  const saved = {};
  for (const [key, value] of Object.entries(env)) {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  let mod;
  jest.isolateModules(() => {
    mod = { ...require(MODULE_PATH), logger: require('../../../../utils/logger') };
  });
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return mod;
}

describe('baseAdapter timeouts', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('defaults classification/embedding calls to 20s and insights to 120s', () => {
    const mod = loadWithEnv({ LLM_CALL_TIMEOUT_MS: undefined, LLM_INSIGHT_TIMEOUT_MS: undefined });
    // A 5s cap aborted healthy thinking-model classification calls (#153).
    expect(mod.CALL_TIMEOUT_MS).toBe(20_000);
    expect(mod.INSIGHT_CALL_TIMEOUT_MS).toBe(120_000);
  });

  it('honours LLM_CALL_TIMEOUT_MS and LLM_INSIGHT_TIMEOUT_MS overrides', () => {
    const mod = loadWithEnv({ LLM_CALL_TIMEOUT_MS: '30000', LLM_INSIGHT_TIMEOUT_MS: '180000' });
    expect(mod.CALL_TIMEOUT_MS).toBe(30_000);
    expect(mod.INSIGHT_CALL_TIMEOUT_MS).toBe(180_000);
  });

  it.each(['abc', '0', '-5', '1.5'])('falls back to the default for invalid value %p', (raw) => {
    const mod = loadWithEnv({ LLM_CALL_TIMEOUT_MS: raw });
    expect(mod.CALL_TIMEOUT_MS).toBe(mod.DEFAULT_CALL_TIMEOUT_MS);
    expect(mod.logger.warn).toHaveBeenCalledWith(expect.stringContaining('LLM_CALL_TIMEOUT_MS'));
  });
});

describe('withTimeout', () => {
  const { withTimeout } = require(MODULE_PATH);

  afterEach(() => {
    jest.useRealTimers();
  });

  it('resolves when the promise settles before the deadline', async () => {
    await expect(withTimeout(Promise.resolve('ok'), 1000, 'call')).resolves.toBe('ok');
  });

  it('rejects with a labelled error when the deadline passes', async () => {
    jest.useFakeTimers();
    const pending = withTimeout(new Promise(() => {}), 1000, 'Gemini classification');
    jest.advanceTimersByTime(1000);
    await expect(pending).rejects.toThrow('Gemini classification timed out after 1000ms');
  });

  it('clears its timer once the promise settles', async () => {
    jest.useFakeTimers();
    await withTimeout(Promise.resolve('ok'), 60_000, 'call');
    expect(jest.getTimerCount()).toBe(0);
  });
});

describe('withRetry', () => {
  it('applies CALL_TIMEOUT_MS when no timeoutMs is given', async () => {
    jest.useFakeTimers();
    const { withRetry, CALL_TIMEOUT_MS } = loadWithEnv({ LLM_CALL_TIMEOUT_MS: undefined });
    // Resolves just under the cap — the old 5s default would have aborted it.
    const operation = jest.fn(
      () => new Promise((resolve) => setTimeout(() => resolve('done'), CALL_TIMEOUT_MS - 1))
    );
    const pending = withRetry({ operation, label: 'call' });
    await jest.advanceTimersByTimeAsync(CALL_TIMEOUT_MS - 1);
    await expect(pending).resolves.toBe('done');
    expect(operation).toHaveBeenCalledTimes(1);
    jest.useRealTimers();
  });
});

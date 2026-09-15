// Covers the CJS resolution path for @bliss/shared/sentry. The module is
// required from app.js on line 1, before validateEnv() runs, so this also
// guards the "zero imports" constraint: a stray require of encryption.js would
// throw here because ENCRYPTION_SECRET is not guaranteed to be set.
const { scrubEvent } = require('../../../utils/sentryScrub');

describe('scrubEvent (backend / CJS)', () => {
  it('resolves through the CJS conditional export', () => {
    expect(typeof scrubEvent).toBe('function');
  });

  it('strips the axios config envelope but keeps the message and stacktrace', () => {
    const event = scrubEvent({
      exception: {
        values: [
          {
            type: 'AxiosError',
            value: 'connect ECONNREFUSED',
            stacktrace: { frames: [{ filename: 'twelveData.js' }] },
            mechanism: {
              data: {
                config: {
                  data: '{"description":"SAINSBURYS SACAT"}',
                  headers: { 'x-api-key': 'td-live-key' },
                },
              },
            },
          },
        ],
      },
    });

    const entry = event.exception.values[0];
    expect(entry.mechanism.data.config).toBe('[redacted]');
    expect(entry.value).toBe('connect ECONNREFUSED');
    expect(entry.stacktrace.frames[0].filename).toBe('twelveData.js');
    expect(JSON.stringify(event)).not.toContain('td-live-key');
    expect(JSON.stringify(event)).not.toContain('SAINSBURYS');
  });

  it('never returns null — a dropped event would be an invisible failure', () => {
    const circular = {};
    circular.self = circular;

    expect(scrubEvent({ extra: { circular } })).not.toBeNull();
    expect(scrubEvent({})).not.toBeNull();
  });
});

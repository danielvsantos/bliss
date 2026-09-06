import { describe, it, expect } from 'vitest';
import { encryptedFields } from '@bliss/shared/encryption';
import { ROTATION_COVERAGE, assertCoverageComplete } from '../../../scripts/lib/encryptionRotationCoverage.mjs';

describe('encryptionRotationCoverage', () => {
  it('covers every field currently in the encryptedFields registry', () => {
    expect(() => assertCoverageComplete(encryptedFields)).not.toThrow();
  });

  it('covers PlaidTransaction.rawJson even though it is not in the automatic registry', () => {
    const entry = ROTATION_COVERAGE.find((e) => e.model === 'PlaidTransaction');
    expect(entry).toBeDefined();
    expect(entry!.fields.map((f) => f.name)).toContain('rawJson');
    expect(entry!.manual).toBe(true);
  });

  it('throws when the registry has a field missing from ROTATION_COVERAGE', () => {
    const fakeRegistry = {
      ...encryptedFields,
      SomeFutureModel: { newSecretField: { searchable: false } },
    };
    expect(() => assertCoverageComplete(fakeRegistry)).toThrow(/SomeFutureModel\.newSecretField/);
  });

  it('throws when a searchable flag disagrees with the registry', () => {
    const fakeRegistry = {
      ...encryptedFields,
      User: { email: { searchable: false } }, // registry field is actually searchable
    };
    expect(() => assertCoverageComplete(fakeRegistry)).toThrow(/searchable flag mismatch/);
  });
});

import { describe, it, expect } from 'vitest';
import { eventOrigin } from '../../../utils/eventOrigin.js';

describe('eventOrigin (#100)', () => {
  it('labels integration-key writes as agent work', () => {
    expect(eventOrigin({ user: { authType: 'integration' } } as any)).toEqual({ _trigger: 'agent' });
  });

  it('adds nothing for sessions or a missing user', () => {
    expect(eventOrigin({ user: { id: 1 } } as any)).toEqual({});
    expect(eventOrigin({} as any)).toEqual({});
    expect(eventOrigin(undefined as any)).toEqual({});
  });
});

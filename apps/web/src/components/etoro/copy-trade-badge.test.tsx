import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { CopyTradeBadge } from './copy-trade-badge';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k, i18n: { language: 'en' } }),
}));

const linked = { linked: true as const, copyId: 'c', status: 'ACTIVE' as const, connectionStatus: 'ACTIVE' as const, lastValueAt: '2026-10-21T03:30:00Z', unmappedPct: 0 };

describe('CopyTradeBadge (#143, R12)', () => {
  it.each([
    [{ linked: false as const }, 'notLinked'],
    [linked, 'linked'],
    [{ ...linked, status: 'CLOSED' as const }, 'closed'],
    [{ ...linked, connectionStatus: 'NEEDS_RECONNECT' as const }, 'needsReconnect'],
  ])('%o → %s', (copyTrade, state) => {
    render(<CopyTradeBadge copyTrade={copyTrade} />);
    const badge = screen.getByTestId('copy-trade-badge');
    expect(badge).toHaveAttribute('data-state', state);
    expect(badge).toHaveTextContent(`etoro.badge.${state}`);
  });

  it('renders nothing for a holding without copy trade status', () => {
    const { container } = render(<CopyTradeBadge copyTrade={undefined} />);
    expect(container).toBeEmptyDOMElement();
  });
});

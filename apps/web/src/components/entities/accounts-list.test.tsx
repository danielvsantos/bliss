import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { AccountsList } from './accounts-list';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

const makeAccount = (id: string, name: string, institution = 'Test Bank') => ({
  id,
  name,
  institution,
  country: 'US',
  currency: 'USD',
});

describe('AccountsList', () => {
  it('renders title translation key', () => {
    render(<AccountsList accounts={[]} />);
    expect(screen.getByText('pages.accounts.title')).toBeInTheDocument();
  });

  it('renders add account button', () => {
    render(<AccountsList accounts={[]} />);
    expect(screen.getByText('pages.accounts.addAccount')).toBeInTheDocument();
  });

  it('renders view all link', () => {
    render(<AccountsList accounts={[]} />);
    expect(screen.getByText('dashboard.viewAll')).toBeInTheDocument();
  });

  it('renders each account name', () => {
    const accounts = [
      makeAccount('1', 'Checking Account'),
      makeAccount('2', 'Savings Account'),
    ];
    render(<AccountsList accounts={accounts} />);
    expect(screen.getByText('Checking Account')).toBeInTheDocument();
    expect(screen.getByText('Savings Account')).toBeInTheDocument();
  });

  it('renders account institution', () => {
    const accounts = [makeAccount('1', 'My Account', 'Chase Bank')];
    render(<AccountsList accounts={accounts} />);
    expect(screen.getByText('Chase Bank')).toBeInTheDocument();
  });

  it('renders country and currency', () => {
    render(<AccountsList accounts={[makeAccount('1', 'Acc')]} />);
    expect(screen.getByText('US (USD)')).toBeInTheDocument();
  });

  it('renders multiple accounts', () => {
    const accounts = [
      makeAccount('1', 'Account 1'),
      makeAccount('2', 'Account 2'),
      makeAccount('3', 'Account 3'),
    ];
    render(<AccountsList accounts={accounts} />);
    expect(screen.getByText('Account 1')).toBeInTheDocument();
    expect(screen.getByText('Account 2')).toBeInTheDocument();
    expect(screen.getByText('Account 3')).toBeInTheDocument();
  });

  it('renders empty state with no accounts', () => {
    render(<AccountsList accounts={[]} />);
    // Just the card structure remains
    expect(screen.getByText('pages.accounts.title')).toBeInTheDocument();
  });
});

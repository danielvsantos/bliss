jest.mock('../../../../utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

jest.mock('../../../../utils/encryption', () => ({
  decrypt: jest.fn(),
}));

const { decrypt } = require('../../../../utils/encryption');
const { generateAssetKey } = require('../../../../workers/portfolio-handlers/asset-aggregator');

describe('asset-aggregator — generateAssetKey', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns null when key strategy is IGNORE', () => {
    const tx = {
      description: 'Some payment',
      ticker: null,
      category: { portfolioItemKeyStrategy: 'IGNORE', name: 'Groceries', type: 'Essentials' },
    };
    expect(generateAssetKey(tx, decrypt)).toBeNull();
  });

  it('returns ticker when strategy is TICKER and ticker contains letters', () => {
    const tx = {
      description: 'Buy AAPL',
      ticker: 'AAPL',
      category: { portfolioItemKeyStrategy: 'TICKER', name: 'Stocks', type: 'Investments' },
    };
    expect(generateAssetKey(tx, decrypt)).toBe('AAPL');
  });

  it('returns category name when strategy is CATEGORY_NAME', () => {
    const tx = {
      description: 'Monthly rent',
      ticker: null,
      category: { portfolioItemKeyStrategy: 'CATEGORY_NAME', name: 'Real Estate', type: 'Asset' },
    };
    expect(generateAssetKey(tx, decrypt)).toBe('Real Estate');
  });

  it('returns category:description when strategy is CATEGORY_NAME_PLUS_DESCRIPTION', () => {
    decrypt.mockReturnValue('My Savings Account');
    const tx = {
      description: 'encrypted-desc',
      ticker: null,
      category: { portfolioItemKeyStrategy: 'CATEGORY_NAME_PLUS_DESCRIPTION', name: 'Cash', type: 'Asset' },
    };
    expect(generateAssetKey(tx, decrypt)).toBe('Cash:My Savings Account');
    expect(decrypt).toHaveBeenCalledWith('encrypted-desc');
  });

  it('falls back to category:description when TICKER but no ticker present', () => {
    decrypt.mockReturnValue('Vanguard Fund');
    const tx = {
      description: 'encrypted-desc',
      ticker: null,
      category: { portfolioItemKeyStrategy: 'TICKER', name: 'Mutual Funds', type: 'Investments' },
    };
    expect(generateAssetKey(tx, decrypt)).toBe('Mutual Funds:Vanguard Fund');
  });

  it('falls back to category:description for TICKER when ticker is pure numeric ("0")', () => {
    decrypt.mockReturnValue('Manual Fund');
    const tx = {
      description: 'encrypted-desc',
      ticker: '0',
      category: { portfolioItemKeyStrategy: 'TICKER', name: 'Index Funds', type: 'Investments' },
    };
    // "0" has no letters, so it should fall back
    expect(generateAssetKey(tx, decrypt)).toBe('Index Funds:Manual Fund');
  });

  it('returns null when transaction is null', () => {
    expect(generateAssetKey(null, decrypt)).toBeNull();
  });

  it('returns null when transaction has no category', () => {
    expect(generateAssetKey({ description: 'test' }, decrypt)).toBeNull();
  });

  it('returns null for CATEGORY_NAME_PLUS_DESCRIPTION when description is missing', () => {
    const tx = {
      description: null,
      ticker: null,
      category: { portfolioItemKeyStrategy: 'CATEGORY_NAME_PLUS_DESCRIPTION', name: 'Debt', type: 'Debt' },
    };
    expect(generateAssetKey(tx, decrypt)).toBeNull();
  });

  it('returns null for TICKER strategy with no ticker and non-Investment type', () => {
    const tx = {
      description: 'some-desc',
      ticker: null,
      category: { portfolioItemKeyStrategy: 'TICKER', name: 'Other', type: 'Essentials' },
    };
    expect(generateAssetKey(tx, decrypt)).toBeNull();
  });
});

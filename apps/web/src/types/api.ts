// This is a simplified version of the Prisma model, adapted for frontend use.

export type User = {
  id: string;
  email: string;
  name?: string;
  profilePictureUrl?: string;
  tenantId?: string;
  tenant?: Tenant;
  role?: string;
  provider?: string;
};

export type Tenant = {
  id: string;
  name: string;
  plan: string;
  createdAt: string;
  countries: Country[];
  currencies: Currency[];
  banks: Bank[];
  transactionYears: number[];
  plaidLinkedBankIds?: number[];
};

export type Bank = {
  id: number;
  name: string;
};

export type BankRequest = {
  name: string;
};

export type Country = {
  id: string;
  name: string;
  emoji?: string;
};

export type Currency = {
  id: string;
  name: string;
  symbol?: string;
};

export type Account = {
  id: number;
  name: string;
  accountNumber: string;
  bankId: number;
  currencyCode: string;
  countryId: string;
  owners: { userId: string }[];
  plaidAccountId?: string | null;
};

export type AccountRequest = {
  name: string;
  accountNumber: string;
  bankId: number;
  currencyCode: string;
  countryId: string;
  ownerIds: string[];
};

export type Category = {
  id: number;
  name: string;
  group: string;
  type: string;
  tenantId: string;
  icon?: string;
  processingHint?: string;
  /** Stable SNAKE_UPPER_CASE code from defaultCategories.js. null for tenant-created custom categories. */
  defaultCategoryCode?: string | null;
  /** Number of transactions tagged to this category — returned by GET /api/categories */
  _count?: { transactions: number };
};

export type CategoryRequest = {
  name: string;
  group: string;
  type: string;
  icon?: string;
};

export type CategoryResponse = {
  categories: Category[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
};

export type Tag = {
  id: number;
  name: string;
  color?: string;
  emoji?: string;
  budget?: number | null;
  startDate?: string | null;
  endDate?: string | null;
};

export type TagRequest = {
  name: string;
  color?: string;
  emoji?: string;
  budget?: number | null;
  startDate?: string | null;
  endDate?: string | null;
};

export type DebtTerms = {
  id: number;
  assetId: number;
  interestRate: number;
  termInMonths?: number;
  originationDate: string;
  initialBalance: number;
};

export type DebtTermsRequest = {
  apr: number;
  term: number;
  firstPaymentDate: string;
  compoundingFrequency: string;
};

export type ManualAssetValue = {
  id: string;
  date: string;
  value: number;
  currency: string;
  notes?: string;
};

type FinancialSummary = {
  costBasis: number;
  marketValue: number;
  unrealizedPnL: number;
  unrealizedPnLPercent: number;
  realizedPnL: number;
  totalInvested: number;
};

export type PortfolioItem = {
  id: number;
  symbol: string;
  currency: string;
  quantity: number;
  category: {
    name: string;
    group: string;
    type: string;
    icon?: string;
    processingHint?: string;
  };
  native: FinancialSummary;
  usd: FinancialSummary;
  portfolio?: FinancialSummary;
  debtTerms?: DebtTerms;
  manualValues?: ManualAssetValue[];
};

export type Transaction = {
  id: number;
  description: string;
  transaction_date: string;
  debit: number | null;
  credit: number | null;
  currency: string;
  accountId: number;
  account?: {
    name: string;
    currencyCode: string;
    country: unknown;
  };
  categoryId: number;
  category?: {
    name: string;
    group: string;
    type: string;
    icon?: string;
  };
  details?: string | Record<string, unknown> | null;
  assetQuantity?: number | null;
  assetPrice?: number | null;
  ticker?: string | null;
  tags?: Tag[];
};

export type TransactionRequest = {
  transaction_date: string;
  description: string;
  debit?: number;
  credit?: number;
  currency: string;
  accountId: number;
  categoryId: number;
};

export type SignUpRequest = {
  email: string;
  password?: string;
  name?: string;
  tenantName: string;
  countries: string[];
  currencies: string[];
  bankIds?: number[];
};

export type TenantUpdateRequest = {
  name?: string;
  plan?: string;
  countries?: string[];
  currencies?: string[];
  bankIds?: number[];
};

export type UserCreateRequest = {
  email: string;
  password: string;
  name?: string;
  role?: string;
  relationshipType?: string;
  preferredLocale?: string;
};

export type UserUpdateRequest = {
  name?: string;
  role?: string;
  profilePictureUrl?: string;
  birthDate?: string;
  relationshipType?: string;
  preferredLocale?: string;
};

export type Error = {
  error: string;
  details?: unknown;
};

export type CurrencyRate = {
  id: number;
  year: number;
  month: number;
  day: number;
  currencyFrom: string;
  currencyTo: string;
  value: number;
};

export type PortfolioHolding = {
  id: number;
  date: string;
  quantity: number;
  totalValue: number;
  costBasis: number;
};

export type PortfolioValueHistory = {
  date: string;
  value: number;
};

export type AnalyticsResponse = {
  currency: string;
  view: string;
  data: unknown;
};

export type TagAnalyticsResponse = {
  currency: string;
  view: string;
  tags: Record<string, Record<string, Record<string, Record<string, Record<string, { credit: number; debit: number; balance: number }>>>>>;
};

// ─── Smart Import Types ──────────────────────────────────────────────────────

export type ImportAdapter = {
  id: number;
  name: string;
  columnMapping: Record<string, string | string[]>;
  dateFormat?: string | null;
  amountStrategy: 'SINGLE_SIGNED' | 'DEBIT_CREDIT_COLUMNS' | 'AMOUNT_WITH_TYPE';
  currencyDefault?: string | null;
  skipRows: number;
  tenantId?: string | null;
};

export type DetectAdapterResult = {
  matched: boolean;
  adapter?: ImportAdapter;
  confidence?: number;
  headers?: string[];
  sampleData?: Record<string, string>[];
};

export type StagedImport = {
  id: string;
  status: 'PROCESSING' | 'READY' | 'COMMITTING' | 'COMMITTED' | 'CANCELLED' | 'ERROR';
  fileName: string;
  adapterName?: string | null;
  accountId?: number | null;
  totalRows: number;
  progress: number;
  errorCount: number;
  errorDetails?: unknown;
  autoConfirmedCount?: number | null;
  seedReady?: boolean;
  createdAt: string;
  updatedAt: string;
};

export type StagedImportRow = {
  id: string;
  stagedImportId: string;
  rowNumber: number;
  rawData: Record<string, unknown>;
  transactionDate?: string | null;
  description?: string | null;
  debit?: number | null;
  credit?: number | null;
  currency?: string | null;
  accountId?: number | null;
  suggestedCategoryId?: number | null;
  confidence?: number | null;
  classificationSource?: string | null;
  details?: string | null;
  status: 'PENDING' | 'CONFIRMED' | 'SKIPPED' | 'DUPLICATE' | 'POTENTIAL_DUPLICATE' | 'ERROR';
  duplicateOfId?: number | null;
  errorMessage?: string | null;
  requiresEnrichment?: boolean;
  enrichmentType?: string | null;
  ticker?: string | null;
  assetQuantity?: number | null;
  assetPrice?: number | null;
  tags?: string[] | null;
  updateTargetId?: number | null;
  updateDiff?: Record<string, { old: unknown; new: unknown; oldName?: string; newName?: string }> | null;
  suggestedCategory?: {
    id: number;
    name: string;
    group: string;
    type: string;
  } | null;
};

export type StagedImportResponse = {
  import: StagedImport;
  rows: StagedImportRow[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
};

export type CreateAdapterRequest = {
  name: string;
  matchSignature: { headers: string[] };
  columnMapping: Record<string, string | string[]>;
  dateFormat?: string;
  amountStrategy: 'SINGLE_SIGNED' | 'DEBIT_CREDIT_COLUMNS' | 'AMOUNT_WITH_TYPE';
  currencyDefault?: string;
  skipRows?: number;
};

export type PlaidTransaction = {
  id: string;
  plaidItemId: string;
  plaidAccountId: string;
  plaidTransactionId: string;
  amount: number;
  date: string;
  authorizedDate?: string | null;
  name: string;
  merchantName?: string | null;
  paymentChannel?: string | null;
  isoCurrencyCode?: string | null;
  pending: boolean;
  category?: unknown;
  syncType: string;
  processed: boolean;
  processingError?: string | null;
  matchedTransactionId?: number | null;
  suggestedCategoryId?: number | null;
  aiConfidence?: number | null;
  classificationSource?: string | null;
  classificationReasoning?: string | null;
  promotionStatus: 'PENDING' | 'CLASSIFIED' | 'PROMOTED' | 'SKIPPED';
  requiresEnrichment?: boolean;
  enrichmentType?: string | null;
  createdAt: string;
  updatedAt: string;
  // Enriched by API
  suggestedCategory?: {
    id: number; name: string; group: string; type: string;
    processingHint?: string;
  } | null;
  accountName?: string | null;
  institutionName?: string | null;
};

export type PlaidTransactionsResponse = {
  transactions: PlaidTransaction[];
  pagination: { page: number; limit: number; total: number; totalPages: number };
  summary: {
    classified: number;
    pending: number;
    promoted: number;
    skipped: number;
    seedHeld: number;
  };
};

export type PlaidItem = {
  id: string;
  itemId: string;
  status: string; // ACTIVE, LOGIN_REQUIRED, ERROR, REVOKED, PENDING_SELECTION
  errorCode?: string | null;
  lastSync?: string | null;
  historicalSyncComplete: boolean;
  earliestTransactionDate?: string | null;
  seedReady?: boolean;
  institutionName?: string | null;
  institutionId?: string | null;
  bankId?: number | null;
  consentExpiration?: string | null;
  environment?: string | null;
  createdAt: string;
  accounts?: {
    id: number;
    name: string;
    mask?: string | null;
    type?: string | null;
    subtype?: string | null;
  }[];
};

// ─── Quick Seed Interview Types ────────────────────────────────────────────────

export type SeedItem = {
  description: string;
  normalizedDescription: string;
  /** Raw bank transaction name (Plaid only) — used to match PlaidTransaction.name in confirm-seeds */
  rawName?: string;
  count: number;
  suggestedCategoryId: number | null;
  suggestedCategoryName: string | null;
  suggestedCategory: { id: number; name: string; group: string; type: string } | null;
  aiConfidence: number | null;
  classificationSource: string | null;
  // Plaid-only
  classificationReasoning?: string | null;
  plaidHint?: string | null;
};

export type ConfirmSeedsRequest = {
  seeds: { description: string; confirmedCategoryId: number }[];
  /** Required for Plaid seeds endpoint */
  plaidItemId?: string;
};

// ─── Plaid Sync Log Types ──────────────────────────────────────────────────────

export type PlaidSyncLog = {
  id: string;
  plaidItemId: string;
  type: string; // INITIAL_SYNC, SYNC_UPDATE, BALANCE_UPDATE, ERROR
  status: string; // SUCCESS, FAILED
  details?: {
    added?: number;
    modified?: number;
    removed?: number;
    batches?: number;
    error?: string;
  } | null;
  createdAt: string;
};

// ─── Insights Types ────────────────────────────────────────────────────────────

/** Cadence tier that produced the insight. DAILY was retired in v1.1. */
export type InsightTier = 'MONTHLY' | 'QUARTERLY' | 'ANNUAL' | 'PORTFOLIO';

/** Insight category grouping (drives the frontend tab bar and chip filters). */
export type InsightCategory =
  | 'SPENDING'
  | 'INCOME'
  | 'SAVINGS'
  | 'PORTFOLIO'
  | 'DEBT'
  | 'NET_WORTH';

export type InsightSeverity = 'POSITIVE' | 'INFO' | 'WARNING' | 'CRITICAL';

export type InsightMetadata = {
  actionTypes?: string[];
  relatedLenses?: string[];
  suggestedAction?: string;
  dataPoints?: Record<string, unknown>;
} & Record<string, unknown>;

export type Insight = {
  id: string;
  lens: string;
  tier: InsightTier;
  category: InsightCategory;
  periodKey: string;
  severity: InsightSeverity;
  title: string;
  body: string;
  priority: number;
  date?: string;
  dismissed?: boolean;
  metadata?: InsightMetadata;
  createdAt?: string;
};

// ─── Notification Signal Types ─────────────────────────────────────────────────

export type UserSignal = {
  type: string;
  severity: string;
  href: string;
  label: string;
  isNew?: boolean;
};

// ─── Merchant History Types ────────────────────────────────────────────────────

export type MerchantHistoryTransaction = {
  id: number;
  transaction_date: string;
  description: string;
  debit: number | null;
  credit: number | null;
  currency: string;
  source: string;
  category?: { id: number; name: string; group: string } | null;
  account?: { id: number; name: string } | null;
};
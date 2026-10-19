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
  /** True for the tenant's primary country (first picked during onboarding). */
  isDefault?: boolean;
};

export type Currency = {
  id: string;
  name: string;
  symbol?: string;
  /** True for the tenant's primary currency (first picked during onboarding). */
  isDefault?: boolean;
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
  description?: string | null;
  processingHint?: string;
  /** When true, this category's transactions are treated as recurring-by-default
   *  in the Subscriptions view (Tier A — one occurrence qualifies). User-toggleable. */
  isRecurring?: boolean;
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
  description?: string | null;
  isRecurring?: boolean;
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
  /** When the row was keyed in — distinguishes a backdated entry from its creation time. */
  createdAt: string;
  updatedAt: string;
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
  /** Brokerage account this position belongs to. */
  accountId: number | null;
  /** Resolved account object — present when the item is linked to an account. */
  account?: { id: number; name: string } | null;
  /** True when FIFO lot calculation produced a negative quantity — indicates a
   *  missing buy transaction or an unrecorded cross-account share transfer.
   *  Surface this as a data quality warning in the UI. */
  hasLotMismatch: boolean;
  currency: string;
  quantity: number;
  category: {
    name: string;
    group: string;
    type: string;
    icon?: string;
    processingHint?: string;
    defaultCategoryCode?: string | null;
  };
  native: FinancialSummary;
  usd: FinancialSummary;
  portfolio?: FinancialSummary;
  debtTerms?: DebtTerms;
  /** SYNCED (priced) or MANUAL (manually valued). */
  source?: string;
  /** Passive Income (#77): present when the holding has income terms. */
  incomeTerms?: { id: number; incomeType: string; isDistributing: boolean } | null;
  manualValues?: ManualAssetValue[];
};

/**
 * The fields the manual price / debt terms forms and the price history dialog
 * need. A full PortfolioItem satisfies it, and so does a Manage Assets row.
 */
export type AssetRef = Pick<PortfolioItem, 'id' | 'symbol' | 'currency'> & { debtTerms?: DebtTerms | null };

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

// ─── Admin Maintenance (rebuild) ──────────────────────────────────────────

export type RebuildScope = 'full-portfolio' | 'full-analytics' | 'scoped-analytics' | 'single-asset' | 'security-data';

export type RebuildJobState = 'active' | 'waiting' | 'delayed' | 'completed' | 'failed' | 'unknown';

export type RebuildJob = {
  id: string | number;
  name: string;
  state: RebuildJobState;
  progress: number;
  rebuildType: RebuildScope | null;
  requestedBy: string | null;
  requestedAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  failedReason: string | null;
  attemptsMade: number;
};

export type RebuildLockInfo = {
  scope: RebuildScope;
  held: boolean;
  ttlSeconds: number | null;
};

// Lightweight portfolio-item shape used by the Maintenance tab's
// single-asset picker. Shipped alongside status to avoid calling
// `/api/portfolio/items`, which triggers a live price fetch per asset.
export type RebuildAsset = {
  id: number;
  symbol: string;
  currency: string;
  category: { name: string } | null;
  account: { name: string } | null;
};

export type RebuildStatusResponse = {
  locks: RebuildLockInfo[];
  current: RebuildJob[];
  recent: RebuildJob[];
  assets: RebuildAsset[];
};

export type RebuildTriggerRequest = {
  scope: RebuildScope;
  payload?: {
    earliestDate?: string;       // required for scope=scoped-analytics (ISO date)
    portfolioItemId?: number;    // legacy single-asset (kept for backward compat)
    portfolioItemIds?: number[]; // preferred: all item IDs for the selected symbol
  };
};

export type RebuildTriggerResponse = {
  status: 'accepted';
  scope: RebuildScope;
  requestedAt: string;
  lockTtlSeconds: number;
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
  amountStrategy: 'SINGLE_SIGNED' | 'SINGLE_SIGNED_INVERTED' | 'DEBIT_CREDIT_COLUMNS' | 'AMOUNT_WITH_TYPE';
  currencyDefault?: string | null;
  skipRows: number;
  tenantId?: string | null;
};

export type DetectAdapterResult = {
  matched: boolean;
  adapter?: ImportAdapter;
  confidence?: number;
  headers?: string[];
  // ExcelJS-derived rows may contain numbers/booleans — use unknown, coerce with String()
  sampleData?: Record<string, unknown>[];
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

/** Reason a commit held a row back (#142) — mirrors HOLD_BACK_REASONS in @bliss/shared/import. */
export type HoldBackReason =
  | 'MISSING_TICKER'
  | 'MISSING_QUANTITY'
  | 'MISSING_PRICE'
  | 'MISSING_ACCOUNT'
  | 'DUPLICATE'
  | 'UPDATE_FAILED'
  | 'COMMIT_ERROR';

/** `StagedImport.errorDetails.commitResult`, written by the backend commitWorker. */
export type CommitResult = {
  transactionCount: number;
  updateCount?: number;
  remaining: number;
  /** Rows held back in this commit run. `total` counts rows; a row can carry several reasons. Absent before #142. */
  heldBack?: { total: number; byReason: Partial<Record<HoldBackReason, number>> };
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
  categorySummary?: Array<{
    categoryId: number | null;
    category: { id: number; name: string; group: string; type: string } | null;
    count: number;
    /** Server-side count of rows in this category that bulk-confirm would actually approve
     *  (status in PENDING/ERROR/STAGED, requiresEnrichment !== true). Drives the
     *  "Approve All (N)" badge so it reflects all pages, not just the current page. */
    eligibleCount?: number;
  }>;
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
  amountStrategy: 'SINGLE_SIGNED' | 'SINGLE_SIGNED_INVERTED' | 'DEBIT_CREDIT_COLUMNS' | 'AMOUNT_WITH_TYPE';
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
  promotionStatus: 'PENDING' | 'CLASSIFIED' | 'PROMOTED' | 'SKIPPED' | 'FAILED';
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
    failed: number;
    seedHeld: number;
  };
};

export type BankProvider = 'PLAID' | 'ENABLE_BANKING';

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
  /** Which aggregator syncs this connection (#132). Absent on older API responses = PLAID. */
  provider?: BankProvider;
  /** ISO 3166-1 alpha-2 country of the Enable Banking bank (null for Plaid). */
  aspspCountry?: string | null;
  /** The user who authorised the connection (only they can reconnect an Enable Banking one). */
  userId?: string | null;
  /** Enable Banking only (#148): the tenant has no credentials, so the connection does not sync. */
  paused?: boolean;
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
  /** null = label only (e.g. PROCESSING_FAILED for non-admins, #100). */
  href: string | null;
  label: string;
  count?: number;
  isNew?: boolean;
  /** BANK_CONSENT_EXPIRING (#132): when the bank access expires (ISO). */
  expiresAt?: string;
};

// ─── Enable Banking (#132) ─────────────────────────────────────────────────────

/** GET /api/enablebanking/status (#148). */
export type EnableBankingStatus = {
  /** The tenant has saved Enable Banking credentials (any validation status). */
  enabled: boolean;
  /** The caller may set the credentials up (admins). */
  configurable: boolean;
  /** Connections waiting for credentials (0 when enabled). */
  pausedConnections: number;
};

export type EnableBankingCredentialStatus = 'VERIFIED' | 'UNVERIFIED' | 'INVALID';
export type EnableBankingCredentialAction = 'SET' | 'REPLACED' | 'KEY_ROTATED' | 'REMOVED';

/** The tenant's Enable Banking app (#148). The private key is write-only and never returned. */
export type EnableBankingCredential = {
  appId: string;
  keyFingerprint: string;
  keyBits: number;
  status: EnableBankingCredentialStatus;
  lastValidatedAt: string | null;
  /** Whether the Bliss callback URL is registered on the app; null = unknown. */
  callbackRegistered: boolean | null;
  updatedAt: string;
};

export type EnableBankingCredentialEvent = {
  action: EnableBankingCredentialAction;
  appId: string;
  keyFingerprint: string | null;
  user: { id: string; name: string | null } | null;
  createdAt: string;
};

/** GET /api/enablebanking/credentials (admins only). */
export type EnableBankingCredentialsView = {
  configured: boolean;
  callbackUrl: string;
  credential: EnableBankingCredential | null;
  usage: { activeConnections: number; pausedConnections: number; linkedAccounts: number; limit: number };
  history: EnableBankingCredentialEvent[];
};

export type EnableBankingCredentialsRequest = {
  appId: string;
  privateKey: string;
  confirmAppChange?: boolean;
};

export type EnableBankingAspsp = {
  name: string;
  /** ISO 3166-1 alpha-2 */
  country: string;
  logo: string | null;
  maximumConsentValiditySec: number | null;
};

export type EnableBankingAspspsResponse = {
  aspsps: EnableBankingAspsp[];
  /** First day a new connection's initial sync would import (YYYY-MM-DD). */
  startDate: string;
};

export type EnableBankingConnectRequest =
  | { aspspName: string; aspspCountry: string }
  | { reconnectItemId: string };

export type EnableBankingConnectResponse = { url: string; startDate: string };

export type EnableBankingConnection = {
  id: string;
  institutionName: string | null;
  aspspCountry: string | null;
  status: string;
  consentExpiration: string | null;
  lastSync: string | null;
  createdAt: string;
  authorizedByMe: boolean;
  /** The tenant has no Enable Banking credentials, so the connection does not sync (#148). */
  paused?: boolean;
};

export type EnableBankingBankAccount = {
  id: string;
  name: string | null;
  ibanLast4: string | null;
  currency: string | null;
  accountId: number | null;
  suggestedAccountId: number | null;
  /** Already synced through another person's active connection (R6). */
  conflict: boolean;
  /** Decimal as a string — never parsed by the numeric response parser. */
  lastBalance: string | null;
  lastBalanceCurrency: string | null;
  lastBalanceAt: string | null;
};

export type EnableBankingBlissAccount = {
  id: number;
  name: string;
  currencyCode: string;
  last4: string | null;
  linkedProvider: BankProvider | null;
  linkedToThisConnection: boolean;
};

export type EnableBankingConnectionResponse = {
  connection: EnableBankingConnection;
  startDate: string;
  accounts: EnableBankingBankAccount[];
  blissAccounts: EnableBankingBlissAccount[];
};

export type EnableBankingCreateAccount = {
  name: string;
  bankId: number;
  countryId: string;
  currencyCode: string;
};

export type EnableBankingMapping =
  | { ebAccountId: string; accountId: number }
  | { ebAccountId: string; create: EnableBankingCreateAccount }
  | { ebAccountId: string; skip: true };

export type EnableBankingMapRequest = {
  mappings: EnableBankingMapping[];
  confirmProviderSwitch?: boolean;
};

export type EnableBankingMapResponse = {
  mapped: number;
  created: number;
  skipped: number;
  switched: number;
  active: boolean;
};

/** An account that would stop syncing from its current provider (409 PROVIDER_SWITCH_REQUIRED). */
export type EnableBankingSwitchAccount = {
  id: number;
  name: string;
  provider: BankProvider;
  institutionName: string | null;
};

/** Error body shared by the Enable Banking routes. */
export type EnableBankingErrorBody = {
  error?: string;
  code?: string;
  resetsAt?: string;
  accounts?: EnableBankingSwitchAccount[];
  /** 409 CONFIRMATION_REQUIRED on the credential routes (#148). */
  affectedConnections?: number;
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
// ─── Subscriptions / Recurring Charges ────────────────────────────────────────

export type RecurringCadence = 'WEEKLY' | 'MONTHLY' | 'QUARTERLY' | 'ANNUAL';
export type RecurringState = 'DETECTED' | 'CONFIRMED' | 'DISMISSED';
export type RecurringStatus = 'ACTIVE' | 'LAPSED';
export type SubscriptionsView = 'active' | 'lapsed' | 'all';

export type SubscriptionItem = {
  id: number;
  descriptionHash: string;
  merchantLabel: string;
  categoryId: number;
  category: { id: number; name: string; icon?: string | null } | null;
  state: RecurringState;
  cadence: RecurringCadence | null;
  userCadenceLocked: boolean;
  /** True once the user has given this charge a custom name — detector stops renaming it. */
  userLabelLocked: boolean;
  status: RecurringStatus;
  detectionReason: 'CATEGORY_SIGNAL' | 'INTERVAL_HEURISTIC' | 'USER_CONFIRMED' | null;
  amount: number | null;
  currency: string | null;
  amountInDisplayCurrency: number | null;
  monthlyAmount: number | null;
  fxUnavailable: boolean;
  occurrenceCount: number;
  firstChargedAt: string | null;
  lastChargedAt: string | null;
  nextExpectedAt: string | null;
  lastDetectedAt: string | null;
  contributingTransactionIds: number[];
  /** Set when this row is a manual-merge tombstone — folded into another merchant. */
  mergedIntoHash: string | null;
  /** Set when this row is a manual split marker — its charges are shown per amount in other rows. */
  splitByAmount?: boolean;
  /** Human label of the merge target (the row this one folds into). */
  mergedIntoLabel: string | null;
  /** True when this tombstone's merge target row no longer exists. */
  mergeTargetMissing?: boolean;
  /** True when this row is a merge target that a detection run has not folded into (guard-rail). */
  mergeStale?: boolean;
};

export type SubscriptionsResponse = {
  displayCurrency: string;
  lastDetectedAt: string | null;
  fullScanAt: string | null;
  refreshCooldownSeconds: number;
  /** 1-based page of `items` (summary/facets always span the full filtered set). */
  page: number;
  limit: number;
  total: number;
  totalPages: number;
  categories: Array<{ id: number; name: string; icon?: string | null; count: number }>;
  /** All non-dismissed, non-merged rows for the tenant — merge picker targets, view-independent. */
  mergeCandidates: Array<{
    descriptionHash: string;
    merchantLabel: string;
    status: RecurringStatus;
    state: RecurringState;
    categoryIcon: string | null;
    categoryName: string | null;
  }>;
  summary: {
    monthlyTotal: number;
    annualTotal: number;
    activeCount: number;
    lapsedCount: number;
    fxUnavailableCount: number;
    /** Rows folded into another subscription — where the Unmerge action lives (All view). */
    mergedCount: number;
  };
  items: SubscriptionItem[];
};

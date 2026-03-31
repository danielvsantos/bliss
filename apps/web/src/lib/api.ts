import axios, { AxiosError, AxiosInstance, AxiosResponse } from 'axios';
import type {
  User,
  Tenant,
  Account,
  AccountRequest,
  Category,
  CategoryRequest,
  Tag,
  TagRequest,
  Transaction,
  TransactionRequest,
  SignUpRequest,
  TenantUpdateRequest,
  UserCreateRequest,
  UserUpdateRequest,
  Error as APIError,
  CategoryResponse,
  CurrencyRate,
  PortfolioItem,
  ManualAssetValue,
  PortfolioHolding,
  PortfolioValueHistory,
  DebtTerms,
  DebtTermsRequest,
  AnalyticsResponse,
  TagAnalyticsResponse,
  PlaidItem,
  PlaidTransaction,
  PlaidTransactionsResponse,
  ImportAdapter,
  DetectAdapterResult,
  StagedImportResponse,
  CreateAdapterRequest,
  PlaidSyncLog,
  MerchantHistoryTransaction,
  SeedItem,
} from '../types/api';

export interface AggregatedPortfolioHistory {
  date: string;
  Investments?: {
    total: number;
    groups: { [key: string]: number };
  };
  Asset?: {
    total: number;
    groups: { [key: string]: number };
  };
  Debt?: {
    total: number;
    groups: { [key: string]: number };
  };
}

// Regular expression to check for strings that look like numbers (including decimals and negatives)
const numericRegex = /^-?\d+(\.\d+)?$/;

/**
 * Recursively walks through an object or array and parses numeric strings into numbers.
 * @param data The data to parse (object, array, or primitive).
 * @returns The parsed data.
 */
function recursiveNumericParser(data: any): any {
  if (data === null || data === undefined) {
    return data;
  }

  if (Array.isArray(data)) {
    return data.map(recursiveNumericParser);
  }

  if (typeof data === 'object') {
    return Object.entries(data).reduce((acc, [key, value]) => {
      acc[key] = recursiveNumericParser(value);
      return acc;
    }, {} as { [key: string]: any });
  }

  if (typeof data === 'string' && numericRegex.test(data)) {
    // Check if parsing would result in a very large number that loses precision
    const num = parseFloat(data);
    if (Math.abs(num) > Number.MAX_SAFE_INTEGER) {
      return data; // Keep as string if it's too large to be a safe integer
    }
    return num;
  }

  return data;
}

interface SignInRequest {
  email: string;
  password: string;
}

interface Session {
  user: User;
}

interface Country {
  id: string;
  name: string;
  emoji?: string;
}

interface Currency {
  id: string;
  name: string;
  symbol?: string;
}

interface Bank {
  id: number;
  name: string;
}

// Module-level flag to fire session-expired event only once per page load
let sessionExpiredFired = false;

class APIClient {
  private client: AxiosInstance;

  constructor() {
    const baseURL = (import.meta.env.NEXT_PUBLIC_API_URL || '').replace(/\/$/, '');

    // Remove the /api suffix if it exists in the base URL
    const normalizedBaseURL = baseURL.endsWith('/api')
      ? baseURL.slice(0, -4)
      : baseURL;

    this.client = axios.create({
      baseURL: normalizedBaseURL,
      headers: {
        'Content-Type': 'application/json',
      },
      withCredentials: true, // Important for cross-domain cookies
      transformResponse: [(data) => {
        try {
          // Axios automatically parses JSON, but if it fails and returns a string, parse it.
          const jsonData = typeof data === 'string' ? JSON.parse(data) : data;
          return recursiveNumericParser(jsonData);
        } catch (error) {
          return data; // Return original data if parsing fails
        }
      }],
    });

    // Request interceptor for logging (auth is handled via HttpOnly cookie)
    this.client.interceptors.request.use((config) => {
      console.log(`[API Request] ${config.method?.toUpperCase()} ${config.url}`);
      return config;
    });

    // Response interceptor for handling errors
    this.client.interceptors.response.use(
      (response) => {
        console.log(`[API Response] ${response.status} ${response.config.method?.toUpperCase()} ${response.config.url}`);
        return response;
      },
      (error: AxiosError<APIError>) => {
        console.error(`[API Error] ${error.response?.status} ${error.config?.method?.toUpperCase()} ${error.config?.url}`, error.response?.data);
        // On 401, emit a custom event so AuthContext can clear the user and show a toast.
        // Do NOT redirect here — window.location.href causes a full page reload
        // which remounts AuthContext → infinite loop. The withAuth HOC handles the redirect.
        if (error.response?.status === 401 && !sessionExpiredFired) {
          sessionExpiredFired = true;
          window.dispatchEvent(new Event('auth:session-expired'));
        }
        return Promise.reject(error);
      }
    );
  }

  // Auth
  async signup(data: SignUpRequest): Promise<{ user: User; tenant: Tenant }> {
    const response = await this.client.post('/api/auth/signup', data);
    return response.data;
  }

  async signin(data: SignInRequest): Promise<{ user: User }> {
    const response = await this.client.post('/api/auth/signin', data);
    return response.data;
  }

  async signout(): Promise<void> {
    await this.client.post('/api/auth/signout');
  }

  async getSession(): Promise<Session | null> {
    const response = await this.client.get('/api/auth/session');
    return response.data;
  }

  async getScriptToken(): Promise<{ token: string; expiresIn: number }> {
    const response = await this.client.post('/api/auth/get-script-token');
    return response.data;
  }

  async changePassword(data: { currentPassword: string; newPassword: string; confirmPassword: string }): Promise<{ message: string }> {
    const response = await this.client.put('/api/auth/change-password', data);
    return response.data;
  }

  // Tenants
  async getTenants(params?: { name?: string; plan?: 'FREE' | 'PRO' | 'AI' }): Promise<Tenant[]> {
    const response = await this.client.get('/api/tenants', { params });
    return response.data;
  }

  async getTenant(id: string): Promise<Tenant> {
    const response = await this.client.get('/api/tenants', { params: { id } });
    return response.data;
  }

  async updateTenant(id: string, data: TenantUpdateRequest): Promise<Tenant> {
    const response = await this.client.put('/api/tenants', data, { params: { id } });
    return response.data;
  }

  async deleteTenant(id: string): Promise<void> {
    await this.client.delete('/api/tenants', { params: { id } });
  }

  // Users
  async getUsers(params?: { email?: string }): Promise<User[]> {
    const response = await this.client.get('/api/users', { params });
    return response.data;
  }

  async createUser(data: UserCreateRequest): Promise<User> {
    const response = await this.client.post('/api/users', data);
    return response.data;
  }

  async updateUser(id: string, data: UserUpdateRequest): Promise<User> {
    const response = await this.client.put('/api/users', data, { params: { id } });
    return response.data;
  }

  async deleteUser(id: string): Promise<void> {
    await this.client.delete('/api/users', { params: { id } });
  }

  // Accounts
  async getAccounts(params?: {
    id?: number;
    page?: number;
    limit?: number;
    sortBy?: string;
    sortOrder?: 'asc' | 'desc';
    name?: string;
    bankId?: number;
    countryId?: string;
    currencyCode?: string;
    ownerId?: string;
  }): Promise<{ accounts: Account[]; total: number; page: number; limit: number; totalPages: number }> {
    const response = await this.client.get('/api/accounts', { params });
    return response.data;
  }

  async createAccount(data: AccountRequest): Promise<Account> {
    const response = await this.client.post('/api/accounts', data);
    return response.data;
  }

  async updateAccount(id: number, data: Partial<AccountRequest>): Promise<Account> {
    const response = await this.client.put('/api/accounts', data, { params: { id } });
    return response.data;
  }

  async deleteAccount(id: number): Promise<void> {
    await this.client.delete('/api/accounts', { params: { id } });
  }

  // Categories
  async getCategories(params?: {
    name?: string;
    group?: string;
    type?: string;
    page?: number;
    limit?: number;
    sortBy?: string;
    sortOrder?: 'asc' | 'desc';
  }): Promise<CategoryResponse> {
    const response = await this.client.get('/api/categories', { params });
    return response.data;
  }

  async createCategory(data: CategoryRequest): Promise<Category> {
    const response = await this.client.post('/api/categories', data);
    return response.data;
  }

  async updateCategory(id: number, data: CategoryRequest): Promise<Category> {
    const response = await this.client.put('/api/categories', data, { params: { id } });
    return response.data;
  }

  async deleteCategory(id: number, mergeInto?: number): Promise<void> {
    await this.client.delete('/api/categories', { params: { id, ...(mergeInto && { mergeInto }) } });
  }

  // Tags
  async getTags(params?: { name?: string }): Promise<Tag[]> {
    const response = await this.client.get('/api/tags', { params });
    return response.data;
  }

  async createTag(data: TagRequest): Promise<Tag> {
    const response = await this.client.post('/api/tags', data);
    return response.data;
  }

  async updateTag(id: number, data: Partial<TagRequest>): Promise<Tag> {
    const response = await this.client.put('/api/tags', data, { params: { id } });
    return response.data;
  }

  async deleteTag(id: number): Promise<void> {
    await this.client.delete('/ tags', { params: { id } });
  }

  // Transactions
  async getTransactions(params?: {
    page?: number;
    limit?: number;
    sortBy?: string;
    sortOrder?: 'asc' | 'desc';
    accountId?: number;
    categoryId?: number;
    tagIds?: string;
    startDate?: string;
    endDate?: string;
    year?: number;
    month?: number;
    quarter?: string;
    group?: string;
    type?: 'Income' | 'Expense' | 'Transfer' | 'Investment';
    source?: string;
    currencyCode?: string;
  }): Promise<{ transactions: Transaction[]; total: number; page: number; limit: number; totalPages: number }> {
    const response = await this.client.get('/api/transactions', { params });
    return response.data;
  }

  async createTransaction(data: TransactionRequest): Promise<Transaction> {
    const response = await this.client.post('/api/transactions', data);
    return response.data;
  }

  async updateTransaction(id: number, data: Partial<TransactionRequest>): Promise<Transaction> {
    const response = await this.client.put('/api/transactions', data, { params: { id } });
    return response.data;
  }

  async deleteTransaction(id: number): Promise<void> {
    await this.client.delete('/api/transactions', { params: { id } });
  }

  async exportTransactions(params?: {
    startDate?: string;
    endDate?: string;
    accountId?: number;
    categoryId?: number;
    group?: string;
    type?: string;
    source?: string;
    currencyCode?: string;
    tags?: string[];
  }): Promise<Blob> {
    const response = await this.client.get('/api/transactions/export', {
      params,
      responseType: 'blob',
      transformResponse: [(data: unknown) => data], // skip JSON parsing for blob
    });
    return response.data;
  }

  // Currency Rates
  async getCurrencyRates(params?: {
    id?: number;
    year?: number;
    month?: number;
    currencyFrom?: string;
    currencyTo?: string;
  }): Promise<any> {
    const response = await this.client.get('/api/currency-rates', { params });
    return response.data;
  }

  async createOrUpdateCurrencyRate(data: {
    year: number;
    month: number;
    day: number;
    currencyFrom: string;
    currencyTo: string;
    value: number | string;
    provider?: string;
  }): Promise<any> {
    const response = await this.client.post('/api/currency-rates', data);
    return response.data;
  }

  async updateCurrencyRate(id: number, data: {
    year: number;
    month: number;
    day: number;
    currencyFrom: string;
    currencyTo: string;
    value: number | string;
    provider?: string;
  }): Promise<any> {
    const response = await this.client.put('/api/currency-rates', data, { params: { id } });
    return response.data;
  }

  async deleteCurrencyRate(id: number): Promise<void> {
    await this.client.delete('/api/currency-rates', { params: { id } });
  }

  // Asset Prices
  async getAssetPrice(params: {
    symbol?: string;
    symbols?: string;
    type: 'Equity' | 'Crypto';
    currency?: string;
    date?: string;
    forceRefresh?: boolean;
    cacheDuration?: number;
  }): Promise<any> {
    const response = await this.client.get('/api/asset-price', { params });
    return response.data;
  }

  // Metadata endpoints
  async getCurrencies(): Promise<Currency[]> {
    const response = await this.client.get('/api/currencies');
    return response.data;
  }

  async getCountries(): Promise<Country[]> {
    const response = await this.client.get('/api/countries');
    return response.data;
  }

  async getBanks(): Promise<Bank[]> {
    const response = await this.client.get('/api/banks');
    return response.data;
  }

  async getUserPreferences() {
    const response = await this.client.get('/api/user/preferences');
    return response.data;
  }

  async getAnalytics(params: {
    view: 'year' | 'quarter' | 'month';
    years?: number[];
    startMonth?: string;
    endMonth?: string;
    startQuarter?: string;
    endQuarter?: string;
    currency?: string;
    countries?: string[];
    types?: string[];
    groups?: string[];
  }): Promise<AnalyticsResponse> {
    // Convert array parameters to form style
    const formParams = new URLSearchParams();

    // Add non-array parameters
    if (params.view) formParams.append('view', params.view);
    if (params.currency) formParams.append('currency', params.currency);
    if (params.startMonth) formParams.append('startMonth', params.startMonth);
    if (params.endMonth) formParams.append('endMonth', params.endMonth);
    if (params.startQuarter) formParams.append('startQuarter', params.startQuarter);
    if (params.endQuarter) formParams.append('endQuarter', params.endQuarter);

    // Add array parameters with explode: true
    if (params.years) {
      params.years.forEach(year => formParams.append('years', year.toString()));
    }
    if (params.countries) {
      params.countries.forEach(country => formParams.append('countries', country));
    }
    if (params.types) {
      params.types.forEach(type => formParams.append('types', type));
    }
    if (params.groups) {
      params.groups.forEach(group => formParams.append('groups', group));
    }

    const response = await this.client.get('/api/analytics', {
      params: formParams,
      paramsSerializer: params => params.toString() // Ensure proper form serialization
    });
    return response.data;
  }

  async getTagAnalytics(params: {
    tagIds: number[];
    view: 'year' | 'quarter' | 'month';
    years?: number[];
    startMonth?: string;
    endMonth?: string;
    startQuarter?: string;
    endQuarter?: string;
    currency?: string;
  }): Promise<TagAnalyticsResponse> {
    const formParams = new URLSearchParams();
    if (params.view) formParams.append('view', params.view);
    if (params.currency) formParams.append('currency', params.currency);
    if (params.startMonth) formParams.append('startMonth', params.startMonth);
    if (params.endMonth) formParams.append('endMonth', params.endMonth);
    if (params.startQuarter) formParams.append('startQuarter', params.startQuarter);
    if (params.endQuarter) formParams.append('endQuarter', params.endQuarter);
    params.tagIds.forEach(id => formParams.append('tagIds[]', id.toString()));
    if (params.years) {
      params.years.forEach(year => formParams.append('years', year.toString()));
    }
    const response = await this.client.get('/api/analytics/tags', {
      params: formParams,
      paramsSerializer: params => params.toString()
    });
    return response.data;
  }

  // --- Portfolio ---

  async getPortfolioItems(filters: { assetType?: string; source?: string; include_manual_values?: boolean } = {}): Promise<{ portfolioCurrency: string; items: PortfolioItem[] }> {
    const response = await this.client.get('/api/portfolio/items', { params: filters });
    return response.data;
  }

  async getPortfolioHoldings(filters: { account?: string; category?: string; categoryGroup?: string; ticker?: string } = {}): Promise<PortfolioHolding[]> {
    const response = await this.client.get('/api/portfolio/holdings', { params: filters });
    return response.data;
  }

  async getPortfolioHistory(
    filters: { from?: string; to?: string; type?: string; group?: string } = {}
  ): Promise<{ portfolioCurrency: string; history: AggregatedPortfolioHistory[] }> {
    const response = await this.client.get('/api/portfolio/history', { params: filters });
    return response.data;
  }

  // --- Manual Values and Debt Terms (nested under a portfolio item) ---

  async getManualAssetValues(itemId: number): Promise<ManualAssetValue[]> {
    const response = await this.client.get(`/api/portfolio/items/${itemId}/manual-values`);
    return response.data;
  }

  async createManualAssetValue(
    itemId: number,
    data: {
      date: string;
      value: number;
      currency: string;
      notes?: string;
    }
  ): Promise<ManualAssetValue> {
    const response = await this.client.post(`/api/portfolio/items/${itemId}/manual-values`, data);
    return response.data;
  }

  async updateManualAssetValue(
    itemId: number,
    valueId: string,
    data: Partial<{ date: string; value: number; currency: string; notes?: string; }>
  ): Promise<ManualAssetValue> {
    const response = await this.client.put(`/api/portfolio/items/${itemId}/manual-values`, data, { params: { valueId } });
    return response.data;
  }

  async deleteManualAssetValue(itemId: number, valueId: string): Promise<void> {
    await this.client.delete(`/api/portfolio/items/${itemId}/manual-values`, { params: { valueId } });
  }

  async createOrUpdateDebtTerms(itemId: number, data: DebtTermsRequest): Promise<DebtTerms> {
    const response = await this.client.post(`/api/portfolio/items/${itemId}/debt-terms`, data);
    return response.data;
  }

  // --- Plaid ---

  async createBank(data: { name: string }): Promise<Bank> {
    const response = await this.client.post('/api/banks', data);
    return response.data;
  }

  async createLinkToken(plaidItemId?: string): Promise<{ link_token: string; expiration: string; request_id: string }> {
    const response = await this.client.post('/api/plaid/create-link-token', plaidItemId ? { plaidItemId } : {});
    return response.data;
  }

  async exchangePublicToken(public_token: string, metadata: any, bankName?: string): Promise<{ plaidItemId: string }> {
    const response = await this.client.post('/api/plaid/exchange-public-token', {
      public_token,
      institutionId: metadata.institution?.institution_id,
      institutionName: metadata.institution?.name,
      bankName: bankName, // Pass custom bank name if provided
    });
    return response.data;
  }

  async getPlaidAccounts(plaidItemId: string): Promise<{ accounts: any[]; institution: string }> {
    const response = await this.client.get('/api/plaid/accounts', { params: { plaidItemId } });
    return response.data;
  }

  async syncPlaidAccounts(plaidItemId: string, selectedAccountIds: string[], countryId?: string, accountMappings?: Record<string, number>, accountNames?: Record<string, string>): Promise<void> {
    await this.client.post('/api/plaid/sync-accounts', { plaidItemId, selectedAccountIds, countryId, accountMappings, accountNames });
  }

  async getPlaidItems(): Promise<PlaidItem[]> {
    const response = await this.client.get('/api/plaid/items');
    return response.data;
  }

  async updatePlaidItem(id: string, data: { status?: string }): Promise<PlaidItem> {
    const response = await this.client.patch('/api/plaid/items', data, { params: { id } });
    return response.data;
  }

  // --- Smart Import ---

  async detectAdapter(file: File): Promise<DetectAdapterResult> {
    const formData = new FormData();
    formData.append('file', file);
    const response = await this.client.post('/api/imports/detect-adapter', formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
    });
    return response.data;
  }

  async getAdapters(): Promise<ImportAdapter[]> {
    const response = await this.client.get('/api/imports/adapters');
    return response.data;
  }

  async createAdapter(data: CreateAdapterRequest): Promise<ImportAdapter> {
    const response = await this.client.post('/api/imports/adapters', data);
    return response.data;
  }

  async updateAdapter(id: number, data: Partial<CreateAdapterRequest>): Promise<ImportAdapter> {
    const response = await this.client.put(`/api/imports/adapters/${id}`, data);
    return response.data;
  }

  async deleteAdapter(id: number): Promise<void> {
    await this.client.delete(`/api/imports/adapters/${id}`);
  }

  async uploadSmartImport(file: File, accountId: number | null, adapterId: string): Promise<{ stagedImportId: string }> {
    const formData = new FormData();
    formData.append('file', file);
    if (accountId != null) formData.append('accountId', accountId.toString());
    formData.append('adapterId', adapterId);
    const response = await this.client.post('/api/imports/upload', formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
    });
    return response.data;
  }

  async getStagedImport(id: string, params?: { page?: number; limit?: number; status?: string }): Promise<StagedImportResponse> {
    const response = await this.client.get(`/api/imports/${id}`, { params });
    return response.data;
  }

  async updateImportRow(importId: string, rowId: string, data: {
    suggestedCategoryId?: number;
    accountId?: number;
    status?: string;
    details?: string | null;
    ticker?: string | null;
    assetQuantity?: number | null;
    assetPrice?: number | null;
  }): Promise<any> {
    const response = await this.client.put(`/api/imports/${importId}/rows/${rowId}`, data);
    return response.data;
  }

  async commitImport(id: string, rowIds?: string[]): Promise<{ status: string; message: string }> {
    const response = await this.client.post(`/api/imports/${id}`, rowIds ? { rowIds } : null, { params: { action: 'commit' } });
    return response.data;
  }

  async cancelImport(id: string): Promise<void> {
    await this.client.post(`/api/imports/${id}`, null, { params: { action: 'cancel' } });
  }

  async getPendingImports(): Promise<{ imports: Array<{ id: string; fileName: string; adapterName: string | null; accountId: number | null; totalRows: number; pendingRowCount: number; createdAt: string }> }> {
    const response = await this.client.get('/api/imports/pending');
    return response.data;
  }

  // --- Plaid Transaction Review ---

  async getPlaidTransactions(params?: {
    page?: number;
    limit?: number;
    promotionStatus?: string;
    plaidItemId?: string;
    minConfidence?: number;
    maxConfidence?: number;
  }): Promise<PlaidTransactionsResponse> {
    const response = await this.client.get('/api/plaid/transactions', { params });
    return response.data;
  }

  async updatePlaidTransaction(id: string, data: {
    suggestedCategoryId?: number;
    promotionStatus?: 'PROMOTED' | 'SKIPPED' | 'CLASSIFIED';
    ticker?: string;
    assetQuantity?: number;
    assetPrice?: number;
    details?: string;
  }): Promise<PlaidTransaction> {
    const response = await this.client.put(`/api/plaid/transactions/${id}`, data);
    return response.data;
  }

  async bulkPromotePlaidTransactions(params: {
    minConfidence?: number;
    plaidItemId?: string;
    categoryId?: number;
    transactionIds?: string[];
    /** When set, every transaction in the batch is assigned this category (drawer "promote-all" flow). */
    overrideCategoryId?: number;
  }): Promise<{ promoted: number; skipped: number; errors: number }> {
    const response = await this.client.post('/api/plaid/transactions/bulk-promote', params);
    return response.data;
  }

  // --- Tenant Settings (AI classification thresholds, portfolio currency, Plaid history) ---

  async getTenantSettings(): Promise<{ autoPromoteThreshold: number; reviewThreshold: number; portfolioCurrency: string; plaidHistoryDays: number }> {
    const response = await this.client.get('/api/tenants/settings');
    return response.data;
  }

  // Aliases for backwards compatibility with useUserSettings hook
  async getUserSettings() {
    return this.getTenantSettings();
  }

  async updateTenantSettings(data: { autoPromoteThreshold?: number; reviewThreshold?: number; portfolioCurrency?: string; plaidHistoryDays?: number }): Promise<{ autoPromoteThreshold: number; reviewThreshold: number; portfolioCurrency: string; plaidHistoryDays: number }> {
    const response = await this.client.put('/api/tenants/settings', data);
    return response.data;
  }

  async updateUserSettings(data: { autoPromoteThreshold?: number; reviewThreshold?: number; portfolioCurrency?: string; plaidHistoryDays?: number }) {
    return this.updateTenantSettings(data);
  }

  // --- Ticker Search (Sprint 14) ---

  async searchTickers(query: string, type?: string): Promise<{ results: Array<{ symbol: string; name: string; exchange: string; country: string; currency: string; type: string; mic_code: string }> }> {
    const params: Record<string, string> = { q: query };
    if (type) params.type = type;
    const response = await this.client.get('/api/ticker/search', { params });
    return response.data;
  }

  // --- Sprint 12: Plaid Hardening ---

  async resyncPlaidItem(plaidItemId: string): Promise<{ message: string }> {
    const response = await this.client.post('/api/plaid/resync', null, { params: { id: plaidItemId } });
    return response.data;
  }

  async fetchHistoricalTransactions(plaidItemId: string, fromDate: string): Promise<{ message: string }> {
    const response = await this.client.post('/api/plaid/fetch-historical', { fromDate }, { params: { id: plaidItemId } });
    return response.data;
  }

  async rotatePlaidToken(plaidItemId: string): Promise<{ message: string }> {
    const response = await this.client.post('/api/plaid/rotate-token', null, { params: { id: plaidItemId } });
    return response.data;
  }

  async disconnectPlaidItem(plaidItemId: string): Promise<{ message: string }> {
    const response = await this.client.post('/api/plaid/disconnect', null, { params: { id: plaidItemId } });
    return response.data;
  }

  async getPlaidSyncLogs(plaidItemId: string, limit?: number): Promise<PlaidSyncLog[]> {
    const response = await this.client.get('/api/plaid/sync-logs', { params: { plaidItemId, limit } });
    return response.data;
  }

  async getMerchantHistory(description: string, limit?: number): Promise<MerchantHistoryTransaction[]> {
    const response = await this.client.get('/api/transactions/merchant-history', { params: { description, limit } });
    return response.data;
  }

  async bulkRequeuePlaidTransactions(plaidItemId?: string): Promise<{ updated: number }> {
    const response = await this.client.post('/api/plaid/transactions/bulk-requeue', { plaidItemId });
    return response.data;
  }

  async requeuePlaidTransaction(id: string): Promise<PlaidTransaction> {
    const response = await this.client.put(`/api/plaid/transactions/${id}`, { promotionStatus: 'CLASSIFIED' });
    return response.data;
  }

  // --- Quick Seed Interview ---

  async getPlaidSeeds(plaidItemId: string, limit?: number): Promise<SeedItem[]> {
    const response = await this.client.get('/api/plaid/transactions/seeds', {
      params: { plaidItemId, ...(limit != null && { limit }) },
    });
    return response.data;
  }

  async confirmPlaidSeeds(
    plaidItemId: string,
    seeds: { description: string; rawName?: string; confirmedCategoryId: number }[]
  ): Promise<{ confirmed: number }> {
    const response = await this.client.post('/api/plaid/transactions/confirm-seeds', {
      plaidItemId,
      seeds,
    });
    return response.data;
  }

  async getImportSeeds(importId: string, limit?: number): Promise<SeedItem[]> {
    const response = await this.client.get(`/api/imports/${importId}/seeds`, {
      params: { ...(limit != null && { limit }) },
    });
    return response.data;
  }

  async confirmImportSeeds(
    importId: string,
    seeds: { description: string; confirmedCategoryId: number }[]
  ): Promise<{ confirmed: number }> {
    const response = await this.client.post(`/api/imports/${importId}/confirm-seeds`, { seeds });
    return response.data;
  }

  // --- Onboarding Progress ---

  async getOnboardingProgress(): Promise<{ onboardingProgress: any; onboardingCompletedAt: string | null }> {
    const response = await this.client.get('/api/onboarding/progress');
    return response.data;
  }

  async completeOnboardingStep(step: string, data?: any): Promise<{ onboardingProgress: any; onboardingCompletedAt: string | null }> {
    const response = await this.client.put('/api/onboarding/progress', { step, data });
    return response.data;
  }

  // --- Insights ---

  async getInsights(params?: {
    limit?: number;
    offset?: number;
    lens?: string;
    severity?: string;
    includeDismissed?: boolean;
  }): Promise<{ insights: any[]; total: number; latestBatchDate: string | null }> {
    const response = await this.client.get('/api/insights', { params });
    return response.data;
  }

  async dismissInsight(insightId: string, dismissed: boolean): Promise<any> {
    const response = await this.client.put('/api/insights', { insightId, dismissed });
    return response.data;
  }

  async generateInsights(): Promise<{ message: string }> {
    const response = await this.client.post('/api/insights');
    return response.data;
  }

  // --- Notifications ---

  async getNotificationSummary(): Promise<{ totalUnseen: number; lastSeenAt: string | null; signals: any[] }> {
    const response = await this.client.get('/api/notifications/summary');
    return response.data;
  }

  async markNotificationsSeen(): Promise<void> {
    await this.client.put('/api/notifications/summary');
  }

  // --- Equity Analysis ---

  async getEquityAnalysis(params: { groupBy?: string } = {}): Promise<import('@/types/equity-analysis').EquityAnalysisResponse> {
    const response = await this.client.get('/api/portfolio/equity-analysis', { params });
    return response.data;
  }
}

export const api = new APIClient();
export default api; 
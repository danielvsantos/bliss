# 6. Portfolio Management (Frontend)

This document outlines the frontend implementation of the portfolio management features, which include the main portfolio dashboard and the manual updates page.

## 6.1. Key Features

The portfolio management frontend is designed to give users a comprehensive and interactive view of their assets and liabilities. The key features are:

- **Portfolio Dashboard**: A detailed breakdown of all holdings, with performance metrics and historical charts.
- **Manual Updates Page**: A dedicated interface for users to provide prices for manually-tracked assets and to manage the terms of their debts.

These features are powered by a set of hooks that interact with the `/api/portfolio/` endpoints.

## 6.2. Portfolio Dashboard

The main portfolio dashboard provides a detailed overview of the user's assets and liabilities.

- **File Path**: `src/pages/reports/portfolio.tsx`

### 6.2.1. Data Presentation and Architecture

A key architectural feature of the portfolio dashboard is its reliance on **server-side calculations**. To ensure accuracy and performance, all currency conversions and complex financial calculations (e.g., historical cost basis) are handled by the backend services. The frontend is responsible for presentation only and performs no currency conversions.

- **Portfolio Currency**: Values are shown in the tenant's configured `portfolioCurrency` (default USD). When `portfolioCurrency !== 'USD'`, an additional `portfolio` block is present in the API response with converted values.
- **Assets and Liabilities**: The page clearly separates assets from liabilities, with each section showing a total value.
- **Grouped Holdings**: Within each section, holdings are grouped by their category (e.g., "US Stocks", "Crypto", "Mortgage").
- **Detailed Metrics**: For each asset, the dashboard displays USD-denominated values for:
    - Quantity
    - Market Price
    - Total Market Value
    - Cost Basis
    - Realized P&L
    - Unrealized P&L (both absolute and percentage)
    - Total ROI %
- **Debt Information**: For liabilities, the dashboard shows the principal balance and key terms like interest rate and loan duration.

### 6.2.2. Visualizations and Interactivity

- **Performance Chart**: A "Performance" tab displays a historical area chart of the user's net worth, with options to filter the time range.
- **Filtering and Sorting**: Users can filter the list of assets by their symbol and sort the holdings table by various columns.

### 6.2.3. Data Fetching

The dashboard uses three primary hooks:
- `usePortfolioItems`: Fetches the current state of all portfolio items from the `/api/portfolio/items` endpoint. The API response contains a structured payload with pre-calculated financial summaries in both the asset's native currency and in USD, eliminating the need for any client-side conversion.
- `usePortfolioHistory`: Fetches historical data for the performance chart.
- `useMetadata`: Retrieves category definitions and other metadata.

## 6.3. Manual Updates & Debt Management Page

This page provides a centralized location for users to manage assets and liabilities that require manual input.

- **File Path**: `src/pages/manual-updates.tsx`

### 6.3.1. Manual Price Updates

- **Asset Identification**: The page automatically identifies all manually-tracked assets (`processingHint: 'MANUAL'`) that have not had a price update in over 30 days.
- **Update Mechanism**: For each outdated asset, the user is prompted to enter a new price. This is done through the `<ManualPriceForm />` component, which opens in a dialog.

### 6.3.2. Debt Terms Management

- **Liability Listing**: The page displays a table of all liabilities.
- **Terms Management**: Users can add or edit the terms of their loans (e.g., interest rate, amortization schedule) using the `<DebtTermsForm />` component. This information is crucial for the backend workers that process loan payments and calculate remaining balances.

## 6.4. Ticker Search & Resolution

### 6.4.1. Ticker Search Component

Investment transaction forms include a ticker search input with debounced autocomplete (300ms). The `useTickerSearch()` hook calls `GET /api/ticker/search?q={query}` and supports a `searchType` parameter:
- Default: searches stocks/funds via Twelve Data
- `searchType: 'crypto'`: searches crypto via Twelve Data with digital currency filtering (triggered when category `processingHint === 'API_CRYPTO'`)

### 6.4.2. Resolution Flow

1. User selects a result from the autocomplete dropdown
2. Frontend stores: `ticker`, `isin`, `exchange`, `assetCurrency`
3. Fields are submitted with the transaction and propagated through Transaction → PortfolioItem

### 6.4.3. Currency Mismatch Validation

When the selected ticker's `assetCurrency` differs from the account's currency:
- **Transaction form** (`transaction-form.tsx`): Blocking error prevents submission
- **Deep-dive drawer** (`deep-dive-drawer.tsx`): Non-blocking warning banner

### 6.4.4. Ticker Validation

Tickers must contain at least one letter. The frontend pre-populates ticker fields from raw transaction data (`deep-dive-drawer.tsx`) and validates before submission.

## 6.5. Portfolio Currency Settings

The portfolio display currency is configurable per tenant via `GET/PUT /api/tenants/settings` (`portfolioCurrency` field). The settings page allows users to select from their configured currencies. When changed, the dashboard automatically reflects values in the new currency.

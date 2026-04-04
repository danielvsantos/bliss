# 7. Cash Holdings Management (Backend)

This document provides a detailed specification of the cash holdings processing system, which is responsible for creating and maintaining accurate `PortfolioHolding` records for all CASH assets.

## 7.1. Overview & Architecture

The cash holdings system is a dedicated worker (`cash-processor.js`) that implements a **transaction-date-only strategy**. This approach creates holdings records only on dates when actual cash flow changes occur, making it both accurate and efficient.

### Key Principles

1. **Transaction-Date-Only**: Holdings are created only on dates with actual transactions that affect cash balances
2. **Currency Separation**: Each currency is processed independently with year-by-year batching for performance
3. **Authoritative Source**: The cash processor is the single source of truth for all CASH asset holdings
4. **Event-Driven**: Integrates seamlessly with the broader portfolio processing pipeline

## 7.2. Processing Strategy

### 7.2.1. Transaction-Date-Only Holdings

Unlike traditional daily snapshots, the cash processor creates holdings records only when the cash balance actually changes:

```
Example for BRL cash:
2010-12-02: Transaction occurs → Create holding with new balance
2010-12-03: Transaction occurs → Create holding with new balance  
2010-12-04: No transactions → No holding record created
2010-12-05: Transaction occurs → Create holding with new balance
```

**Benefits:**
- **Efficiency**: Dramatically fewer records than daily snapshots
- **Accuracy**: Holdings reflect actual cash flow events
- **Performance**: Faster queries and reduced storage requirements

### 7.2.2. Year-by-Year Processing

To handle large transaction volumes without memory issues, the processor:

1. **Determines Date Range**: Finds first transaction year through current year
2. **Processes Sequentially**: Handles one year of transactions at a time
3. **Maintains Continuity**: Carries running balance forward between years
4. **Bulk Operations**: Uses single `createMany` for all holdings per currency

## 7.3. Core Components

### 7.3.1. Main Entry Point (`processCashHoldings`)

Handles both full rebuilds and scoped updates:

**Full Rebuild:**
- Deletes all existing cash holdings for tenant
- Processes all currencies from beginning of transaction history
- Triggered by `TRANSACTIONS_IMPORTED` events

**Scoped Rebuild:**
- Finds oldest transaction in affected scope
- Rebuilds from that date forward to present
- Triggered by manual transaction modifications

### 7.3.2. Currency Processing (`processCurrencyHoldings`)

For each currency:

1. **Retrieves Cash Portfolio Item**: Finds the corresponding CASH asset
2. **Determines Starting Balance**: For scoped rebuilds, gets balance before rebuild date
3. **Year-by-Year Processing**: Handles transactions in annual batches
4. **Running Balance Calculation**: Maintains accurate balance across years
5. **Bulk Insert**: Creates all holdings for the currency in single operation
6. **Portfolio Item Update**: Updates final balance and USD conversion

### 7.3.3. Transaction Processing (`processYearTransactions`)

Within each year:

1. **Groups by Date**: Organizes transactions by transaction date
2. **Calculates Net Flow**: Sums credits minus debits for each date
3. **Updates Running Balance**: Applies net flow to running balance
4. **Creates Holdings**: Generates holding record for each transaction date

## 7.4. Integration with Portfolio Pipeline

### 7.4.1. Event Flow

```
TRANSACTIONS_IMPORTED
  ↓
process-portfolio-changes
  ↓
PORTFOLIO_CHANGES_PROCESSED
  ↓
process-cash-holdings ← Cash processor runs here
  ↓
CASH_HOLDINGS_PROCESSED
  ↓
full-rebuild-analytics
  ↓
ANALYTICS_RECALCULATION_COMPLETE
  ↓
value-all-assets (reads cash holdings)
```

### 7.4.2. Event Triggers

**Primary Triggers:**
- `PORTFOLIO_CHANGES_PROCESSED`: Full or scoped cash processing
- `MANUAL_TRANSACTION_MODIFIED`: For simple transactions affecting cash

**Event Emission:**
- `CASH_HOLDINGS_PROCESSED`: Signals completion and triggers downstream analytics

### 7.4.3. Scope Handling

**Full Rebuild Scope:**
```javascript
{ tenantId: "xxx" } // No additional scope parameters
```

**Scoped Rebuild Scope:**
```javascript
{ 
  tenantId: "xxx",
  scope: {
    currency: "EUR",    // Optional: specific currency
    year: 2024,         // Optional: specific year
    month: 12           // Optional: specific month (requires year)
  }
}
```

## 7.5. Performance Optimizations

### 7.5.1. Batching Strategy

- **Currency Sequential**: Processes currencies one at a time to avoid memory issues
- **Year Batching**: Handles large date ranges by processing annual chunks
- **Bulk Database Operations**: Single `createMany` operation per currency

### 7.5.2. Smart Deletion

- **Full Rebuild**: Deletes all cash holdings upfront
- **Scoped Rebuild**: Deletes only holdings from rebuild start date forward
- **Targeted Scope**: Can target specific currencies/years for surgical updates

### 7.5.3. Memory Management

- **Stateless Processing**: Each currency processed independently
- **In-Memory Aggregation**: Holdings accumulated in memory before bulk insert
- **Minimal Queries**: Single query per year per currency for transactions

## 7.6. Data Model

### 7.6.1. PortfolioHolding Structure

For cash holdings, the processor creates records with:

```javascript
{
  portfolioItemId: Number,    // Reference to cash portfolio item
  date: Date,                 // Transaction date (not daily)
  quantity: Decimal,          // Running cash balance
  totalValue: Decimal,        // Same as quantity for cash
  costBasis: Decimal(0)       // Always 0 for cash assets
}
```

### 7.6.2. Portfolio Item Updates

The processor also updates the parent `PortfolioItem` with:

```javascript
{
  quantity: Decimal,          // Final cash balance
  currentValue: Decimal,      // Same as quantity  
  currentValueInUSD: Decimal  // USD-converted final balance
}
```

## 7.7. Data Integrity & Concurrency

### 7.7.1. Unique Constraint

`PortfolioHolding` has a unique constraint on `(portfolioItemId, date)`. This prevents duplicate holdings for the same asset on the same date when concurrent jobs race. The `createMany({ skipDuplicates: true })` call relies on this constraint to be idempotent.

### 7.7.2. Job Debouncing

All `process-cash-holdings` jobs are enqueued via `scheduleDebouncedJob()` with a 5-second debounce window. This prevents rapid-fire events (e.g., multiple quick transaction edits) from spawning redundant cash rebuilds.

### 7.7.3. UTC Date Consistency

All date boundary calculations use `Date.UTC()` to match the valuation engine's UTC convention. This prevents timezone/DST-related edge cases where transactions near year or month boundaries could fall into the wrong processing bucket.

## 7.8. Error Handling & Resilience

### 7.8.1. Transaction Processing

- **Missing Portfolio Items**: Warns and skips if cash portfolio item not found
- **Zero Balances**: Creates holdings even when balance becomes zero
- **Currency Conversion**: Handles USD conversion failures gracefully

### 7.8.2. Event Integration

- **Scope Preservation**: Maintains original scope data for downstream analytics
- **Error Isolation**: Cash processing failures don't block other pipeline stages
- **Idempotent Operations**: Safe to re-run without data corruption

## 7.8. Relationship with Other Components

### 7.8.1. Analytics Worker

- **Separation of Concerns**: Analytics focuses on cross-currency reporting
- **Data Independence**: Analytics no longer manages cash holdings
- **Event Sequence**: Cash processing occurs before analytics

### 7.8.2. Valuation Engine

- **Holdings Consumer**: Reads cash holdings created by processor
- **Value History Creation**: Converts holdings to daily value history with forward-filling
- **Preservation Strategy**: Only deletes value history, preserves holdings

### 7.8.3. Portfolio Sync

- **Cash Portfolio Items**: Auto-created on demand by `getOrCreateCashPortfolioItem()` — the cash processor is self-sufficient and does not depend on a prior portfolio sync step. The function looks up an existing CASH `PortfolioItem` for the given `(tenantId, currency)` and creates one via upsert if none exists.
- **Currency Discovery**: Gets currency list from transaction data

This architecture ensures that cash holdings are managed with precision, performance, and reliability while maintaining clean separation from analytics and valuation concerns.

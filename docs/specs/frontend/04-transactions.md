# 4. Transactions (Frontend)

This document outlines the frontend implementation for managing transactions, covering the main transaction list, the creation/editing form, and the data-fetching logic.

---

## 4.1. Data Fetching

The frontend uses a dedicated hook to manage the fetching and caching of transaction data.

### `src/hooks/use-transactions.ts`

-   **Responsibility**: This hook is the centralized point for fetching paginated and filtered transaction data from the API.
-   **`react-query` Integration**: It uses the `react-query` library to handle caching, request deduplication, and background refetching. The query key is dynamically generated to include the current filters, ensuring that different filtered views are cached independently.
-   **Filtering**: It accepts a `filters` object, allowing components to request a specific subset of transactions (e.g., by date, account, or category).

---

## 4.2. Transaction List and Management

The main user interface for interacting with transactions is a comprehensive, feature-rich page.

### `src/pages/transactions.tsx`

-   **Responsibility**: This component renders the main list of transactions and provides a suite of tools for users to filter, sort, and manage their data.
-   **Client-Side Logic**: The component fetches transactions, accounts, and categories, building `accountsMap` and `categoriesMap` for enriching each row with account/category metadata.
-   **Card-Based Layout**: The transaction list uses the liquid glass `Card` component (with `CardDivider`) instead of a plain HTML table:
    -   **Column Headers**: Uppercase tracking-widest labels (`Date`, `Account`, `Category`, `Description`, `Amount`) with responsive visibility (`hidden sm:block`, `hidden md:block`).
    -   **Transaction Rows**: Each row displays:
        -   **Emoji Square**: Category icon in a colored `rounded-[10px]` square. Background color is set by `getCategoryBg(type)`: `bg-positive/10` for Income, `bg-brand-primary/10` for Essentials/Lifestyle, `bg-negative/10` for Debt, `bg-muted` for others.
        -   **Date**: Formatted as "MMM d, yyyy" (hidden on mobile).
        -   **Account / Category**: Shown on tablet/desktop (hidden on mobile).
        -   **Description**: Primary text with a mobile subtitle showing "date · category · account".
        -   **Amount**: Colored with `text-positive` (credits) or `text-negative` (debits), with `tabular-nums` for alignment.
        -   **Actions**: `DropdownMenu` (Edit | Delete) on hover, hidden on mobile.
    -   **Row Separators**: `h-px bg-border/60` indented past the emoji square (`ml-[60px]`).
    -   **Clickable Rows**: Each row opens the edit dialog on click.
    -   **Pagination**: Footer inside the Card with Previous/Next buttons and page counter.
-   **Filtering**: A horizontal filter bar above the card provides four inline filters that drive the `TransactionFilters` state:
    -   **Start Date / End Date** — Calendar + Popover pickers (using `captionLayout="dropdown-buttons"` for easy month/year navigation). Formatted as "MMM d, yyyy" or "Pick date" placeholder.
    -   **Account** — `Select` dropdown listing all accounts, with an "All Accounts" default option.
    -   **Category Group** — `Select` dropdown listing unique category groups. When changed, the Category filter is reset and its options are narrowed to that group.
    -   **Category** — `Select` dropdown listing categories (filtered by the selected group if any).
    -   A "Clear Filters" button appears when any filter is active.
-   All filter changes reset pagination to page 1. The `TransactionFilters` type includes `startDate`, `endDate`, `accountId`, `group`, `categoryId`, `page`, `sort`, and `order`.
-   **Loading / Error / Empty States**: All rendered inside the Card for visual consistency.

---

## 4.2. CSV Import

The "Import CSV" button in the transactions toolbar navigates to `/agents/import?adapter=native`, pre-selecting the "Bliss Native CSV" adapter in the Smart Import page. All CSV imports are now handled through the Smart Import pipeline — see the Smart Import spec for full details.

---

## 4.3. Transaction Creation and Editing

A dedicated form component is used for both creating new transactions and editing existing ones.

### `src/components/entities/transaction-form.tsx`

-   **Responsibility**: To provide a user-friendly interface for inputting all the details of a transaction.
-   **Data Fetching**: The form fetches its own lists of accounts and categories to populate selectors.
-   **Dynamic Currency**: The form includes intelligent logic to automatically set the `currency` field based on the selected `account`, ensuring data consistency.
-   **Validation**: It uses the `zod` library to perform comprehensive client-side validation, ensuring that all required fields are filled and that the data is in the correct format before it is sent to the API.

### Category Combobox (`src/components/entities/category-combobox.tsx`)

A single searchable Popover + Command (cmdk) combobox replaces the previous two-dropdown (Group + Category) selector pattern:
-   Categories are grouped by type in `CommandGroup` sections, ordered: Income, Essentials, Lifestyle, Growth, Investments, Asset, Debt, Transfers.
-   Each item shows `{emoji} {name}` on the left and `{group}` in muted text on the right.
-   `CommandItem` value combines `name`, `group`, and `type` for fuzzy cross-field search.
-   The trigger button displays the selected category's emoji and name.

### Tag Input (`src/components/entities/tag-input.tsx`)

A multi-select tag picker with inline create-new support:
-   Uses the Popover + Command combobox multi-select pattern (checkbox items).
-   Data fetched via the `useTags()` hook (`src/hooks/use-tags.ts`) — a React Query wrapper around `api.getTags()` with 5-minute staleTime.
-   **Create-new**: When search yields no exact match, a "Create '{term}'" button appears. Uses the `useCreateTag()` mutation, which invalidates the tags cache on success.
-   Selected tags render as `Badge` pills (variant="secondary", text-xs) below the trigger, each with an X button to remove.

### Investment Details Accordion

The investment enrichment section is always visible as a collapsible `Accordion`:
-   **Controlled state**: `investmentAccordionValue` state auto-opens (`'investment-details'`) when an Investment category is selected via `isInvestment` detection.
-   When no investment category is selected, the accordion trigger shows a muted hint: "(select an investment category to enable)".
-   The user can freely open/close the accordion regardless of category.
-   Fields inside: Ticker (with autocomplete from Twelve Data), Asset Price, Asset Quantity (auto-calculated from amount / price).
-   The **Debt Details** accordion remains conditionally rendered (only visible for Debt categories with a credit value).

---

## 4.4. CSV Export

The Transactions page header includes an **Export CSV** button (outline variant, `Download` icon from lucide-react) alongside the existing "Import CSV" link and "Add Transaction" button.

See `bliss-backend-service/specs/17-transaction-export-update.md` for the backend pipeline and `bliss-finance-api/specs/17-transaction-export-update-api.md` for the API layer.

### Export Scope Dialog

When filters are active, clicking Export opens a dialog asking the user to choose between exporting the current filtered set or all transactions. If no filters are active the dialog is skipped and all transactions are downloaded immediately.

- **"Current filters"** is pre-selected when any filter is active. The count comes from the current `useTransactions` query total.
- **"All transactions"** exports every transaction for the tenant.
- Forwarded filters: `startDate`, `endDate`, `accountId`, `categoryId`, `categoryGroup`, `type`, `tags`, `source`, `currencyCode`.

### Download Mechanism

The export uses `fetch` with auth headers, receives the response as a blob, and triggers a browser download via a programmatic `<a>` element click. The downloaded file is named `bliss-export-YYYY-MM-DD.csv` (date = today).

- **Loading state**: The Export button shows a spinner and is disabled while the download is in progress.
- **Empty state**: If no transactions match the filters, the CSV contains only the header row. No error is shown.
- **Toast**: On successful download, a brief toast: *"Exported N transactions"*.

### Hook: `useExportTransactions`

```typescript
useExportTransactions(): {
  exportCsv: (filters: TransactionFilters) => Promise<void>;
  isExporting: boolean;
}
```

Calls `GET /api/transactions/export` with the current filters, receives the CSV blob, and triggers the browser download.
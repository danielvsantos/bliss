# 3. Reference Data Management (Frontend)

This document outlines the frontend implementation for managing the core reference data entities: Banks, Countries, and Currencies. It covers the user workflows in both the onboarding process and the main application settings.

---

## 3.1. Centralized Data Fetching

To ensure consistency and efficiency, a custom hook, `useMetadata`, has been created to handle the fetching of all reference data from a single, centralized location.

### `src/hooks/use-metadata.ts`

-   **Responsibility**: This hook encapsulates the logic for fetching the master lists of banks, countries, and currencies using `react-query`.
-   **Benefits**: It provides caching, automatic refetching, and a unified loading/error state for all reference data, which simplifies the components that consume this data.

---

## 3.2. Onboarding Flow

The `onboarding.tsx` component guides new users through the initial setup of their tenant, which includes selecting their preferred countries, currencies, and banks.

### `src/pages/onboarding.tsx`

-   **Responsibility**: To provide a step-by-step, wizard-like interface for new users to configure their tenant.
-   **Data Fetching**: It uses the `useMetadata` hook to fetch all required reference data.
-   **State Management**: It uses local `useState` to manage the lists of selected items for each of the three entities.
-   **User Interaction**: It presents the data in a multi-select format, allowing users to choose their preferred options.
-   **Submission**: On completion, it sends the selected IDs to the `tenants` API to update the tenant's profile.

## 3.3. Application Settings

The main application settings page is a comprehensive tenant configuration interface with multiple tabs.

### `src/pages/settings/index.tsx`

-   **Responsibility**: To allow users to view and update all aspects of their tenant configuration after the initial onboarding.
-   **Data Fetching**: Uses the `useMetadata` hook to get the master lists of countries, currencies, banks, categories, and accounts, along with tenant settings hooks for current selections.
-   **Tabbed Interface**: The settings page is organized into multiple tabs:
    -   **General Settings** — Tenant name, plan, and basic configuration.
    -   **Countries / Currencies** — Multi-select interfaces for choosing the tenant's active countries and currencies.
    -   **Banks** — Multi-select for the tenant's banks, with Plaid-linked banks indicated.
    -   **AI Classification Thresholds** — Slider controls for `autoPromoteThreshold` and `reviewThreshold`, allowing users to tune the sensitivity of the AI classification pipeline.
    -   **Portfolio Currency** — Selector for the tenant's base portfolio currency (auto-detected with USD > EUR > GBP priority when currencies change).
    -   **Change Password** — Password update form.
    -   **Delete Tenant** — Destructive action to permanently delete the tenant and all associated data, with confirmation safeguards.
-   **State Management**: The component's state is derived from two primary sources: the `useMetadata` hook provides the lists of available entities, and the tenant settings provide the user's current selections.
-   **Submission**: When the user saves their changes, the component sends a `TenantUpdateRequest` object to the `tenants` API. Join table updates use conditional-replace semantics — only non-empty provided arrays trigger changes.
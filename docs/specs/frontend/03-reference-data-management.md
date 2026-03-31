# 3. Reference Data Management (Frontend)

This document outlines the frontend implementation for managing the core reference data entities: Banks, Countries, and Currencies. It covers the user workflows in both the onboarding process and the main application settings.

---

## 3.1. Centralized Data Fetching

To ensure consistency and efficiency, a custom hook, `useReferenceData`, has been created to handle the fetching of all reference data from a single, centralized location.

### `src/hooks/use-reference-data.ts`

-   **Responsibility**: This hook encapsulates the logic for fetching the master lists of banks, countries, and currencies using `react-query`.
-   **Benefits**: It provides caching, automatic refetching, and a unified loading/error state for all reference data, which simplifies the components that consume this data.

---

## 3.2. Onboarding Flow

The `onboarding.tsx` component guides new users through the initial setup of their tenant, which includes selecting their preferred countries, currencies, and banks.

### `src/pages/onboarding.tsx`

-   **Responsibility**: To provide a step-by-step, wizard-like interface for new users to configure their tenant.
-   **Data Fetching**: It uses the `useReferenceData` hook to fetch all required reference data.
-   **State Management**: It uses local `useState` to manage the lists of selected items for each of the three entities.
-   **User Interaction**: It presents the data in a multi-select format, allowing users to choose their preferred options.
-   **Submission**: On completion, it sends the selected IDs to the `tenants` API to update the tenant's profile.

## 3.3. Application Settings

The main application settings page allows users to modify their tenant's reference data at any time.

### `src/pages/settings/index.tsx`

-   **Responsibility**: To allow users to view and update their selected banks, countries, and currencies after the initial onboarding.
-   **Data Fetching**: It also uses the `useReferenceData` hook to get the master lists and `getTenantMeta` to get the user's current selections.
-   **User Interaction**: It provides a similar multi-select interface as the onboarding page, but within the main application layout.
-   **State Management**: The component's state is derived from two primary sources: the `useReferenceData` hook provides the lists of available entities, and the `getTenantMeta` utility provides the user's currently selected entities. A single `useState` hook manages the user's selections as they are being edited.
-   **Data Flow**: The component follows a clean, unidirectional data flow. Data from hooks and local storage is passed down into the UI, and user interactions trigger handler functions that update the state. This clear flow prevents race conditions and makes the component easy to reason about.
-   **Error Handling**: The component has robust error handling for the API calls made by the `useReferenceData` hook. It will display a clear error message to the user if the reference data cannot be loaded, and it will show a loading spinner while the data is being fetched.
-   **Submission**: When the user saves their changes, the component sends a simplified `TenantUpdateRequest` object, containing only the IDs of the selected entities, to the `tenants` API. 
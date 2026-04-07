# Bliss Frontend

This is the user-facing web application for the Bliss platform. It is a rich, single-page application (SPA) built with React and Vite, providing a comprehensive and interactive experience for users to manage their finances.

## Core Purpose

The frontend application is responsible for the entire user experience. Its primary goals are:

-   **User Interface**: To provide a clean, intuitive, and responsive interface for all platform features, including transaction management, portfolio tracking, and analytics.
-   **Data Visualization**: To present complex financial data in an understandable way through a suite of charts, tables, and interactive dashboards.
-   **Client-Side State Management**: To efficiently manage client-side state, including user authentication, UI state, and cached data fetched from the API.
-   **API Interaction**: To act as a robust client for the `bliss-finance-api`, handling all data fetching, mutation, and error handling gracefully.
-   **Equity Analysis**: A dedicated stock portfolio analysis page (`/reports/equity-analysis`) with sector/industry/country allocation charts, fundamental metrics (P/E, dividend yield, EPS), and a sortable holdings table.

## Technology Stack

### Core Framework
-   **[React](https://reactjs.org/)**: The application is built on the React library, using modern features like Hooks for state and lifecycle management.
-   **[Vite](https://vitejs.dev/)**: Serves as the build tool, providing a fast and efficient development experience with hot module replacement (HMR).
-   **[TypeScript](https://www.typescriptlang.org/)**: The entire codebase is written in TypeScript, ensuring type safety and improved developer experience.

### UI & Styling
-   **[Shadcn/ui](https://ui.shadcn.com/)**: A collection of beautifully designed, accessible, and composable components built on top of Radix UI and Tailwind CSS.
-   **[Tailwind CSS](https://tailwindcss.com/)**: A utility-first CSS framework for rapidly building custom designs.
-   **[Framer Motion](https://www.framer.com/motion/)**: Used for creating smooth, declarative animations.
-   **[Recharts](https://recharts.org/)**: The primary library for building the financial charts and visualizations.

### State Management & Data Fetching
-   **[TanStack Query (React Query)](https://tanstack.com/query/latest)**: The core of the data-fetching layer. It handles server-state management, including caching, background refetching, and optimistic updates.
-   **[React Context](https://reactjs.org/docs/context.html)**: Used for managing global UI state that needs to be shared across the application, such as the authenticated user session.
-   **[Axios](https://axios-http.com/)**: The HTTP client used to make requests to the `bliss-finance-api`.

### Forms & Validation
-   **[React Hook Form](https://react-hook-form.com/)**: A performant, flexible, and extensible library for managing form state and validation.
-   **[Zod](https://zod.dev/)**: A TypeScript-first schema declaration and validation library, used to ensure all form and API data conforms to the expected shape.

## Setup and Running Locally

1.  **Install Dependencies**:
    ```bash
    npm install
    ```

2.  **Setup Environment Variables**:
    Create a `.env.local` file in the root of the project and define the URL for the backend API:
    ```
    VITE_API_URL=http://localhost:3000/api
    ```

3.  **Run the Development Server**:
    ```bash
    npm run dev
    ```

The application will now be running and accessible at `http://localhost:5173`.

## Project Structure

The project follows a standard feature-based organization within the `/src` directory:

-   **/src/pages**: Contains the top-level page components, which correspond to the main routes of the application.
-   **/src/components**: A collection of all reusable UI components, organized by feature (`entities`, `charts`, `layout`, `accounts`, `review`) and a generic `ui` directory for the base Shadcn components.
-   **/src/hooks**: Contains all custom React hooks. This is a key part of the architecture, encapsulating business logic, state management, and data fetching logic.
-   **/src/lib**: Contains the configured API client (`api.ts`), shared utility functions, and other core library code.
-   **/src/contexts**: Contains React Context providers for managing global state that is shared across the entire component tree (e.g., `AuthContext`).
-   **/src/types**: TypeScript type definitions for API response shapes and shared domain models.
-   **/specs**: Contains detailed markdown documentation for each frontend feature set, providing a deep dive into the implementation and logic.

## System Documentation

This `README.md` provides a high-level architectural overview. For detailed information on specific features, please refer to the specification documents in the `/specs` directory.

-   **[1. User Identity & Tenant Management](./specs/01-user-identity.md)**
-   **[2. Accounts & Categories](./specs/02-accounts-and-categories.md)**
-   **[3. Reference Data Management](./specs/03-reference-data-management.md)**
-   **[4. Transactions & CSV Import](./specs/04-transactions.md)**
-   **[5. Analytics & Reporting](./specs/05-analytics.md)**
-   **[6. Portfolio Management](./specs/06-portfolio-management.md)**
-   **[8. Plaid Integration UI](./specs/08-plaid-integration.md)**
-   **[9. Smart Import UI](./specs/09-smart-import-ui.md)**
-   **[10. AI Classification & Review UI](./specs/10-ai-classification-and-review.md)**
-   **[14. Notification Center](./specs/14-notification-center.md)**
-   **[15. Insights](./specs/15-insights.md)**
-   **[19. Equity Analysis](./specs/19-equity-analysis.md)**

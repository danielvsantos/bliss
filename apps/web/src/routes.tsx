import { Navigate } from "react-router-dom";
import CategoriesPage from "./pages/Categories";
import AccountsPage from "./pages/accounts";
import AuthPage from "./pages/auth";
import AuthCallbackPage from "./pages/auth/callback";
import ExpenseTrackingPage from "./pages/reports/expenses";
import PnlPage from "./pages/reports/pnl";
import PortfolioPage from "./pages/reports/portfolio";
import OnboardingPage from "./pages/onboarding";
import DashboardPage from "./pages/dashboard";
import SettingsPage from "./pages/settings";
import UserManagementPage from "./pages/settings/users";
import TransactionsPage from "./pages/transactions";
import ManualUpdatesPage from "./pages/manual-updates";
import SmartImportPage from "./pages/smart-import";
import TransactionReviewPage from "./pages/transaction-review";
import InsightsPage from "./pages/insights";
import TagAnalyticsPage from "./pages/reports/tags";
import EquityAnalysisPage from "./pages/reports/equity-analysis";

export const routes = [
  { path: "/auth", element: <AuthPage />, protected: false },
  { path: "/auth/callback", element: <AuthCallbackPage />, protected: false },
  { path: "/categories", component: CategoriesPage, protected: true },
  { path: "/accounts", component: AccountsPage, protected: true },
  { path: "/manual-updates", component: ManualUpdatesPage, protected: true },
  { path: "/reports/expenses", component: ExpenseTrackingPage, protected: true },
  { path: "/reports/pnl", component: PnlPage, protected: true },
  { path: "/reports", element: <Navigate to="/reports/pnl" replace />, protected: true },
  { path: "/reports/portfolio", component: PortfolioPage, protected: true },
  { path: "/reports/tags", component: TagAnalyticsPage, protected: true },
  { path: "/reports/equity-analysis", component: EquityAnalysisPage, protected: true },
  { path: "/onboarding", component: OnboardingPage, protected: true },
  { path: "/", component: DashboardPage, protected: true },
  { path: "/settings", component: SettingsPage, protected: true },
  { path: "/settings/users", component: UserManagementPage, protected: true },
  { path: "/transactions", component: TransactionsPage, protected: true },
  { path: "/agents/import", component: SmartImportPage, protected: true },
  { path: "/agents/review", component: TransactionReviewPage, protected: true },
  { path: "/agents/insight", component: InsightsPage, protected: true },
];

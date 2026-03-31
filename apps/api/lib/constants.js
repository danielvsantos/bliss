// This constant defines the immutable "types" that drive core logic.
// Tenants can create any group/category they want, but it must be under one of these types.
//
// P&L structure:
//   Income → Essentials → Gross Profit → Lifestyle → Operating Profit → Growth → Net Profit
//   → Ventures → Transfers → Investments → Debt
//
// Essentials = non-discretionary (housing, utilities, groceries, health, transport)
// Lifestyle  = discretionary (dining out, entertainment, shopping, beauty)
// Growth     = long-term self-investment / CAPEX (education, travel, therapy, donations)
// Ventures   = own businesses / side projects (revenue, COGS, opex, people, capital)
export const ALLOWED_CATEGORY_TYPES = Object.freeze([
  'Income',
  'Essentials',
  'Lifestyle',
  'Growth',
  'Ventures',    // For own businesses / side projects
  'Investments', // For assets that appreciate/generate income
  'Asset',       // For transactional assets like cash
  'Debt',        // For liabilities
  'Transfers',
]); 
/**
 * Default category set seeded for every new tenant at signup.
 * This is the canonical source of truth for default categories.
 *
 * Rules:
 *  - `processingHint` drives backend worker behaviour. Immutable after creation.
 *  - `portfolioItemKeyStrategy` controls how portfolio items are keyed/aggregated.
 *  - `code` is a stable SNAKE_UPPER_CASE identifier used by Sprint B global embeddings.
 *    It is persisted as `defaultCategoryCode` on the Category row.
 *    Custom tenant categories (not in this list) always have code = null.
 *
 * Category types follow a personal P&L structure:
 *   Income → Essentials → Gross Profit → Lifestyle → Operating Profit → Growth → Net Profit
 *   → Ventures → Transfers → Investments → Debt
 *
 *   Essentials = non-discretionary (housing, utilities, groceries, health, transport)
 *   Lifestyle  = discretionary (dining out, entertainment, shopping, beauty)
 *   Growth     = long-term self-investment / CAPEX (education, travel, therapy, donations)
 *   Ventures   = own businesses / side projects (revenue, COGS, opex, people, capital)
 */

export const DEFAULT_CATEGORIES = [
  // ── Investments ────────────────────────────────────────────────────────────
  { code: 'OPERATING_CASH',       name: 'Operating Cash',       group: 'Cash',                type: 'Asset',                processingHint: 'CASH',           portfolioItemKeyStrategy: 'CURRENCY',                    icon: '💵' },
  { code: 'STOCKS',               name: 'Stocks',               group: 'Stocks',              type: 'Investments',          processingHint: 'API_STOCK',      portfolioItemKeyStrategy: 'TICKER',                      icon: '📈' },
  { code: 'INVESTMENT_FUNDS',     name: 'Funds',                group: 'Funds',               type: 'Investments',          processingHint: 'API_FUND',       portfolioItemKeyStrategy: 'TICKER',                      icon: '📊' },
  { code: 'ETFS',                 name: 'ETFs',                 group: 'ETFs',                type: 'Investments',          processingHint: 'API_FUND',       portfolioItemKeyStrategy: 'TICKER',                      icon: '📊' },
  { code: 'PENSION_PLAN',         name: 'Pension Plan',         group: 'Pension Plan',        type: 'Investments',          processingHint: 'MANUAL',         portfolioItemKeyStrategy: 'CATEGORY_NAME_PLUS_DESCRIPTION', icon: '👵' },
  { code: 'GOVERNMENT_BONDS',     name: 'Government Bonds',     group: 'Bonds',               type: 'Investments',          processingHint: 'MANUAL',         portfolioItemKeyStrategy: 'CATEGORY_NAME_PLUS_DESCRIPTION', icon: '🏛️' },
  { code: 'CORPORATE_BONDS',      name: 'Corporate Bonds',      group: 'Bonds',               type: 'Investments',          processingHint: 'MANUAL',         portfolioItemKeyStrategy: 'CATEGORY_NAME_PLUS_DESCRIPTION', icon: '🏛️' },
  { code: 'CRYPTO',               name: 'Crypto',               group: 'Crypto',              type: 'Investments',          processingHint: 'API_CRYPTO',     portfolioItemKeyStrategy: 'TICKER',                      icon: '🪙' },
  { code: 'REAL_ESTATE',          name: 'Real Estate',          group: 'Real Estate',         type: 'Investments',          processingHint: 'MANUAL',         portfolioItemKeyStrategy: 'CATEGORY_NAME_PLUS_DESCRIPTION', icon: '🏠' },
  { code: 'COLLECTIBLE',          name: 'Collectible',          group: 'Collectible',         type: 'Investments',          processingHint: 'MANUAL',         portfolioItemKeyStrategy: 'CATEGORY_NAME_PLUS_DESCRIPTION', icon: '🎨' },
  { code: 'VEHICLE',              name: 'Vehicle',              group: 'Depreciating assets', type: 'Investments',          processingHint: 'MANUAL',         portfolioItemKeyStrategy: 'CATEGORY_NAME_PLUS_DESCRIPTION', icon: '🚗' },
  { code: 'COMMODITIES',          name: 'Commodities',          group: 'Commodities',         type: 'Investments',          processingHint: 'API_STOCK',      portfolioItemKeyStrategy: 'TICKER',                      icon: '🥇' },
  { code: 'PRIVATE_EQUITY',       name: 'Private Equity',       group: 'Private Equity',      type: 'Investments',          processingHint: 'MANUAL',         portfolioItemKeyStrategy: 'TICKER',                      icon: '🏦' },

  // ── Debt ───────────────────────────────────────────────────────────────────
  { code: 'MORTGAGE',             name: 'Mortgage',             group: 'Real Estate Loan',    type: 'Debt',                 processingHint: 'AMORTIZING_LOAN',  portfolioItemKeyStrategy: 'CATEGORY_NAME',             icon: '📄' },
  { code: 'CREDIT_CARD_DEBT',     name: 'Credit Card Debt',     group: 'Personal Debt',       type: 'Debt',                 processingHint: 'SIMPLE_LIABILITY', portfolioItemKeyStrategy: 'CATEGORY_NAME',             icon: '💳' },

  // ── Income ────────────────────────────────────────────────────────────────
  { code: 'ALLOWANCE',            name: 'Allowance',            group: 'Passive Income',      type: 'Income',               portfolioItemKeyStrategy: 'IGNORE',  icon: '💰' },
  { code: 'RENT_INCOME',          name: 'Rent Income',          group: 'Passive Income',      type: 'Income',               portfolioItemKeyStrategy: 'IGNORE',  icon: '🏡' },
  { code: 'SALARY',               name: 'Salary',               group: 'Labor Income',        type: 'Income',               portfolioItemKeyStrategy: 'IGNORE',  icon: '💵' },
  { code: 'GOVERNMENT_WELFARE',   name: 'Government Welfare',   group: 'Labor Income',        type: 'Income',               portfolioItemKeyStrategy: 'IGNORE',  icon: '🏛️' },
  { code: 'TAXES',                name: 'Taxes',                group: 'Taxes',               type: 'Income',               portfolioItemKeyStrategy: 'IGNORE',  icon: '🧾' },
  { code: 'DIVIDENDS',            name: 'Dividends',            group: 'Passive Income',      type: 'Income',               portfolioItemKeyStrategy: 'IGNORE',  icon: '💸' },
  { code: 'BOND_INCOME',          name: 'Bond Income',          group: 'Passive Income',      type: 'Income',               portfolioItemKeyStrategy: 'IGNORE',  icon: '🏛️' },
  { code: 'INTEREST_INCOME',      name: 'Interest Income',      group: 'Passive Income',      type: 'Income',               portfolioItemKeyStrategy: 'IGNORE',  icon: '💰' },
  { code: 'OPTIONS_INCOME',       name: 'Options Income',       group: 'Passive Income',      type: 'Income',               portfolioItemKeyStrategy: 'IGNORE',  icon: '📉' },          

  // ── Essentials (non-discretionary spending) ───────────────────────────────
  // Housing
  { code: 'RENT',                 name: 'Rent',                 group: 'Housing',             type: 'Essentials',           portfolioItemKeyStrategy: 'IGNORE',  icon: '🔑' },
  { code: 'HOA_COMMUNITY_FEES',   name: 'HOA / Community fees', group: 'Housing',             type: 'Essentials',           portfolioItemKeyStrategy: 'IGNORE',  icon: '🏘️' },
  { code: 'SECURITY_DEPOSIT',     name: 'Security Deposit',     group: 'Housing',             type: 'Essentials',           portfolioItemKeyStrategy: 'IGNORE',  icon: '🏦' },
  { code: 'HOME_INSURANCE',       name: 'Home Insurance',       group: 'Housing',             type: 'Essentials',           portfolioItemKeyStrategy: 'IGNORE',  icon: '🛡️' },
  // Utilities
  { code: 'POWER_AND_GAS',        name: 'Power & Gas',          group: 'Utilities',           type: 'Essentials',           portfolioItemKeyStrategy: 'IGNORE',  icon: '💡' },
  { code: 'WATER',                name: 'Water',                group: 'Utilities',           type: 'Essentials',           portfolioItemKeyStrategy: 'IGNORE',  icon: '💧' },
  { code: 'DATA_PLAN',            name: 'Data Plan',            group: 'Utilities',           type: 'Essentials',           portfolioItemKeyStrategy: 'IGNORE',  icon: '📱' },
  { code: 'INTERNET',             name: 'Internet',             group: 'Utilities',           type: 'Essentials',           portfolioItemKeyStrategy: 'IGNORE',  icon: '🌐' },
  // Maintenance
  { code: 'CLEANING_SERVICE',     name: 'Cleaning service',     group: 'Home Maintenance',    type: 'Essentials',           portfolioItemKeyStrategy: 'IGNORE',  icon: '🧹' },
  { code: 'HOME_IMPROVEMENT',     name: 'Home Improvement',     group: 'Home Maintenance',    type: 'Essentials',           portfolioItemKeyStrategy: 'IGNORE',  icon: '🔨' },
  // Eating In
  { code: 'GROCERIES',            name: 'Groceries',            group: 'Eating In',           type: 'Essentials',           portfolioItemKeyStrategy: 'IGNORE',  icon: '🛒' },
  { code: 'CONVENIENCE_STORES',   name: 'Convenience stores',   group: 'Eating In',           type: 'Essentials',           portfolioItemKeyStrategy: 'IGNORE',  icon: '🏪' },
  // Healthcare
  { code: 'DOCTOR',               name: 'Doctor',               group: 'Healthcare',          type: 'Essentials',           portfolioItemKeyStrategy: 'IGNORE',  icon: '🩺' },
  { code: 'HEALTH_INSURANCE',     name: 'Health Insurance',     group: 'Healthcare',          type: 'Essentials',           portfolioItemKeyStrategy: 'IGNORE',  icon: '❤️‍🩹' },
  { code: 'PHARMACY',             name: 'Pharmacy',             group: 'Healthcare',          type: 'Essentials',           portfolioItemKeyStrategy: 'IGNORE',  icon: '💊' },
  // Transportation
  { code: 'BIKING',               name: 'Biking',               group: 'Transportation',      type: 'Essentials',           portfolioItemKeyStrategy: 'IGNORE',  icon: '🚲' },
  { code: 'FUEL_AND_GAS',         name: 'Fuel & Gas',           group: 'Transportation',      type: 'Essentials',           portfolioItemKeyStrategy: 'IGNORE',  icon: '⛽' },
  { code: 'VEHICLE_MAINTENANCE',  name: 'Vehicle Maintenance',  group: 'Transportation',      type: 'Essentials',           portfolioItemKeyStrategy: 'IGNORE',  icon: '🔧' },
  { code: 'VEHICLE_TAXES_AND_TICKETS',name: 'Vehicle Taxes & Tickets', group: 'Transportation',      type: 'Essentials',           portfolioItemKeyStrategy: 'IGNORE',  icon: '🧾' },
  { code: 'VEHICLE_INSURANCE',    name: 'Vehicle Insurance',    group: 'Transportation',      type: 'Essentials',           portfolioItemKeyStrategy: 'IGNORE',  icon: '🛡️' },
  { code: 'METRO',                name: 'Metro',                group: 'Transportation',      type: 'Essentials',           portfolioItemKeyStrategy: 'IGNORE',  icon: '🚇' },
  { code: 'PARKING',              name: 'Parking',              group: 'Transportation',      type: 'Essentials',           portfolioItemKeyStrategy: 'IGNORE',  icon: '🅿️' },
  { code: 'TAXI',                 name: 'Taxi',                 group: 'Transportation',      type: 'Essentials',           portfolioItemKeyStrategy: 'IGNORE',  icon: '🚕' },
  { code: 'TRAINS',               name: 'Trains',               group: 'Transportation',      type: 'Essentials',           portfolioItemKeyStrategy: 'IGNORE',  icon: '🚆' },
  { code: 'BUS',                  name: 'Bus',                  group: 'Transportation',         type: 'Essentials',        portfolioItemKeyStrategy: 'IGNORE',  icon: '🚌' },
  
  // Pets
  { code: 'PET_CARE',             name: 'Pet care',             group: 'Pets',                type: 'Essentials',           portfolioItemKeyStrategy: 'IGNORE',  icon: '🐕' },
  { code: 'PET_FOOD',             name: 'Pet food',             group: 'Pets',                type: 'Essentials',           portfolioItemKeyStrategy: 'IGNORE',  icon: '🐈' },
  { code: 'PET_INSURANCE',        name: 'Pet insurance',        group: 'Pets',                type: 'Essentials',           portfolioItemKeyStrategy: 'IGNORE',  icon: '🐹' },
  // Finance
  { code: 'BANKING_FEES',         name: 'Banking fees',         group: 'Finance',             type: 'Essentials',           portfolioItemKeyStrategy: 'IGNORE',  icon: '🏦' },
  // Civil
  { code: 'DOCUMENTATION',        name: 'Documentation',        group: 'Civil',               type: 'Essentials',           portfolioItemKeyStrategy: 'IGNORE',  icon: '📜' },
  { code: 'NOTARY',               name: 'Notary',               group: 'Civil',               type: 'Essentials',           portfolioItemKeyStrategy: 'IGNORE',  icon: '🖋️' },
  { code: 'ACCOUNTING',           name: 'Accounting',           group: 'Civil',               type: 'Essentials',           portfolioItemKeyStrategy: 'IGNORE',  icon: '📒' },

  // ── Lifestyle (discretionary spending) ────────────────────────────────────
  // Dining Out
  { code: 'BUSINESS_MEAL',        name: 'Business Meal',        group: 'Dining Out',          type: 'Lifestyle',            processingHint: 'TAX_DEDUCTIBLE', portfolioItemKeyStrategy: 'IGNORE', icon: '🍽️' },
  { code: 'RESTAURANTS',          name: 'Restaurants',          group: 'Dining Out',          type: 'Lifestyle',            portfolioItemKeyStrategy: 'IGNORE',  icon: '🍔' },
  { code: 'BAKERY_AND_COFFEE',    name: 'Bakery & Coffee',      group: 'Dining Out',          type: 'Lifestyle',            portfolioItemKeyStrategy: 'IGNORE',  icon: '🥐' },
  { code: 'FOOD_DELIVERY',        name: 'Food Delivery',        group: 'Dining Out',          type: 'Lifestyle',           portfolioItemKeyStrategy: 'IGNORE',  icon: '🥡' },
  // Entertainment
  { code: 'BAR',                  name: 'Bar',                  group: 'Entertainment',       type: 'Lifestyle',            portfolioItemKeyStrategy: 'IGNORE',  icon: '🍻' },
  { code: 'NIGHTCLUB',            name: 'Nightclub',            group: 'Entertainment',       type: 'Lifestyle',            portfolioItemKeyStrategy: 'IGNORE',  icon: '🕺' },
  { code: 'CONCERTS',             name: 'Concerts',             group: 'Entertainment',       type: 'Lifestyle',            portfolioItemKeyStrategy: 'IGNORE',  icon: '🎤' },
  { code: 'MOVIES_AND_THEATER',   name: 'Movies & Theater',     group: 'Entertainment',       type: 'Lifestyle',            portfolioItemKeyStrategy: 'IGNORE',  icon: '🎬' },
  { code: 'OUTDOOR_ACTIVITIES',   name: 'Outdoor Activities',   group: 'Entertainment',       type: 'Lifestyle',            portfolioItemKeyStrategy: 'IGNORE',  icon: '🏞️' },
  { code: 'SPORTING_EVENTS',      name: 'Sporting Events',      group: 'Entertainment',       type: 'Lifestyle',            portfolioItemKeyStrategy: 'IGNORE',  icon: '🏟️' },
  { code: 'GAMBLING',             name: 'Gambling',             group: 'Entertainment',       type: 'Lifestyle',            portfolioItemKeyStrategy: 'IGNORE',  icon: '🎲' },
  { code: 'GAMING',               name: 'Gaming',               group: 'Entertainment',       type: 'Lifestyle',            portfolioItemKeyStrategy: 'IGNORE',  icon: '🕹️' },
  // Wellness & Beauty
  { code: 'BEAUTY',               name: 'Beauty',               group: 'Wellness & Beauty',   type: 'Lifestyle',            portfolioItemKeyStrategy: 'IGNORE',  icon: '💅' },
  { code: 'HAIRCARE',             name: 'Haircare',             group: 'Wellness & Beauty',   type: 'Lifestyle',            portfolioItemKeyStrategy: 'IGNORE',  icon: '💈' },
  { code: 'SPORTS_AND_GYM',       name: 'Sports & Gym',         group: 'Wellness & Beauty',   type: 'Lifestyle',            portfolioItemKeyStrategy: 'IGNORE',  icon: '🏋️' },
  // Shopping & Gifts
  { code: 'SHOPPING',             name: 'Shopping',             group: 'Shopping & Gifts',    type: 'Lifestyle',            portfolioItemKeyStrategy: 'IGNORE',  icon: '🛍️' },
  { code: 'ELECTRONICS',          name: 'Electronics',          group: 'Shopping & Gifts',    type: 'Lifestyle',            portfolioItemKeyStrategy: 'IGNORE',  icon: '🖥️' },
  { code: 'FURNITURE_AND_DIY',    name: 'Furniture & DIY',      group: 'Shopping & Gifts',    type: 'Lifestyle',            portfolioItemKeyStrategy: 'IGNORE',  icon: '🛋️' },
  { code: 'CLOTHES_AND_FASHION',  name: 'Clothes & Fashion',    group: 'Shopping & Gifts',    type: 'Lifestyle',            portfolioItemKeyStrategy: 'IGNORE',  icon: '👗' },
  { code: 'GIFTS',                name: 'Gifts',                group: 'Shopping & Gifts',    type: 'Lifestyle',            portfolioItemKeyStrategy: 'IGNORE',  icon: '🎁' },
  { code: 'JEWELRY',              name: 'Jewelry',              group: 'Shopping & Gifts',    type: 'Lifestyle',            portfolioItemKeyStrategy: 'IGNORE',  icon: '💍' },
  { code: 'DECORATION_AND_TEXTILES', name: 'Decoration & textiles', group: 'Shopping & Gifts',    type: 'Lifestyle',            portfolioItemKeyStrategy: 'IGNORE',  icon: '🖼️' },
  { code: 'KITCHENWARE',          name: 'Kitchenware',          group: 'Shopping & Gifts',    type: 'Lifestyle',            portfolioItemKeyStrategy: 'IGNORE',  icon: '🍽️' },

  // Subscriptions
  { code: 'SOFTWARE',             name: 'Software',             group: 'Subscriptions',       type: 'Lifestyle',            portfolioItemKeyStrategy: 'IGNORE',  icon: '💻' },
  { code: 'CONTENT_AND_MEDIA',    name: 'Content & Media',      group: 'Subscriptions',       type: 'Lifestyle',            portfolioItemKeyStrategy: 'IGNORE',  icon: '📺' },
  { code: 'LOYALTY_PROGRAMS',     name: 'Loyalty Programs',     group: 'Subscriptions',       type: 'Lifestyle',            portfolioItemKeyStrategy: 'IGNORE',  icon: '🛒' },
  // Misc
  { code: 'CASH_AT_ATM',          name: 'Cash at ATM',          group: 'Misc',                type: 'Lifestyle',            portfolioItemKeyStrategy: 'IGNORE',  icon: '🏧' },

  // ── Transfers ─────────────────────────────────────────────────────────────
  { code: 'INHERITANCE',           name: 'Inheritance',           group: 'Inheritance',        type: 'Transfers',            portfolioItemKeyStrategy: 'IGNORE',  icon: '⚰️' },
  { code: 'RECEIVED_DOMESTIC',     name: 'Transfer Received — Domestic',     group: 'Domestic',           type: 'Transfers',            portfolioItemKeyStrategy: 'IGNORE',  icon: '📨' },
  { code: 'RECEIVED_INTERNATIONAL',name: 'Transfer Received — International',group: 'International',      type: 'Transfers',            portfolioItemKeyStrategy: 'IGNORE',  icon: '🌍' },
  { code: 'SENT_DOMESTIC',         name: 'Transfer Sent — Domestic',         group: 'Domestic',           type: 'Transfers',            portfolioItemKeyStrategy: 'IGNORE',  icon: '📤' },
  { code: 'SENT_INTERNATIONAL',    name: 'Transfer Sent — International',    group: 'International',      type: 'Transfers',            portfolioItemKeyStrategy: 'IGNORE',  icon: '✈️' },

  // ── Ventures (own businesses / side projects) ─────────────────────────────
  // Revenue
  { code: 'BIZ_SALES_REVENUE',          name: 'Sales Revenue',                group: 'Revenue',              type: 'Ventures',  portfolioItemKeyStrategy: 'IGNORE',  icon: '🛒' },
  { code: 'BIZ_SERVICE_REVENUE',        name: 'Service Revenue',              group: 'Revenue',              type: 'Ventures',  portfolioItemKeyStrategy: 'IGNORE',  icon: '💼' },
  { code: 'BIZ_REFERRAL_INCOME',        name: 'Referral & Affiliate',         group: 'Revenue',              type: 'Ventures',  portfolioItemKeyStrategy: 'IGNORE',  icon: '🤝' },
  // Cost of Goods Sold
  { code: 'BIZ_INVENTORY',              name: 'Inventory & Materials',        group: 'Cost of Goods Sold',   type: 'Ventures',  portfolioItemKeyStrategy: 'IGNORE',  icon: '📦' },
  { code: 'BIZ_SHIPPING',               name: 'Shipping & Logistics',         group: 'Cost of Goods Sold',   type: 'Ventures',  portfolioItemKeyStrategy: 'IGNORE',  icon: '🚚' },
  // Operating Expenses
  { code: 'BIZ_SAAS',                   name: 'SaaS & Tools',                group: 'Operating Expenses',   type: 'Ventures',  portfolioItemKeyStrategy: 'IGNORE',  icon: '💻' },
  { code: 'BIZ_CLOUD',                  name: 'Cloud & Hosting',             group: 'Operating Expenses',   type: 'Ventures',  portfolioItemKeyStrategy: 'IGNORE',  icon: '☁️' },
  { code: 'BIZ_MARKETING',              name: 'Marketing & Advertising',     group: 'Operating Expenses',   type: 'Ventures',  portfolioItemKeyStrategy: 'IGNORE',  icon: '📣' },
  { code: 'BIZ_DATA_SERVICES',          name: 'Data & API Services',         group: 'Operating Expenses',   type: 'Ventures',  portfolioItemKeyStrategy: 'IGNORE',  icon: '📡' },
  { code: 'BIZ_OFFICE',                 name: 'Office & Workspace',          group: 'Operating Expenses',   type: 'Ventures',  portfolioItemKeyStrategy: 'IGNORE',  icon: '🏢' },
  { code: 'BIZ_DOMAINS',                name: 'Domains & Licensing',         group: 'Operating Expenses',   type: 'Ventures',  portfolioItemKeyStrategy: 'IGNORE',  icon: '🌐' },
  { code: 'BIZ_EQUIPMENT',              name: 'Business Equipment',          group: 'Operating Expenses',   type: 'Ventures',  portfolioItemKeyStrategy: 'IGNORE',  icon: '📋' },
  { code: 'BIZ_OTHER_COSTS',            name: 'Other Business Costs',        group: 'Operating Expenses',   type: 'Ventures',  portfolioItemKeyStrategy: 'IGNORE',  icon: '📋' },
  // People & Services
  { code: 'BIZ_FREELANCERS',            name: 'Freelancer & Contractor',     group: 'People & Services',    type: 'Ventures',  portfolioItemKeyStrategy: 'IGNORE',  icon: '👩‍💻' },
  { code: 'BIZ_PROFESSIONAL_SERVICES',  name: 'Professional Services',       group: 'People & Services',    type: 'Ventures',  portfolioItemKeyStrategy: 'IGNORE',  icon: '⚖️' },
  { code: 'BIZ_TAXES',                  name: 'Business Taxes & VAT',        group: 'People & Services',    type: 'Ventures',  portfolioItemKeyStrategy: 'IGNORE',  icon: '🧾' },
  // Capital
  { code: 'BIZ_CAPITAL',                name: 'Capital Injection',           group: 'Capital',              type: 'Ventures',  portfolioItemKeyStrategy: 'IGNORE',  icon: '💰' },

  // ── Growth (long-term self-investment / CAPEX) ────────────────────────────
  { code: 'MUSIC',                 name: 'Musical Instruments',   group: 'Skills',             type: 'Growth',               portfolioItemKeyStrategy: 'IGNORE',  icon: '🎷' },
  { code: 'THERAPY_AND_COUNSELING',name: 'Therapy & Counseling',  group: 'Mental Health',      type: 'Growth',               portfolioItemKeyStrategy: 'IGNORE',  icon: '🧘' },
  { code: 'MENTORING',             name: 'Coaching & Mentoring',  group: 'Education',          type: 'Growth',               portfolioItemKeyStrategy: 'IGNORE',  icon: '🎯' },
  { code: 'SCHOOL',                name: 'School',                group: 'Education',          type: 'Growth',               portfolioItemKeyStrategy: 'IGNORE',  icon: '🎓' },
  { code: 'ONLINE_COURSES',        name: 'Online Course',         group: 'Education',          type: 'Growth',               portfolioItemKeyStrategy: 'IGNORE',  icon: '🎓' },
  { code: 'TRAVEL_TRANSPORT',      name: 'Travel Transport',      group: 'Travel',             type: 'Growth',               portfolioItemKeyStrategy: 'IGNORE',  icon: '✈️' },
  { code: 'ACCOMMODATION',         name: 'Accommodation',         group: 'Travel',             type: 'Growth',               portfolioItemKeyStrategy: 'IGNORE',  icon: '🏨' },
  { code: 'CAR_RENTAL',            name: 'Car Rental',            group: 'Travel',             type: 'Growth',               portfolioItemKeyStrategy: 'IGNORE',  icon: '🚙' },
  { code: 'TOURS_AND_ACTIVITIES',  name: 'Tours & Activities',    group: 'Travel',             type: 'Growth',               portfolioItemKeyStrategy: 'IGNORE',  icon: '🗺️' },
  { code: 'TRAVEL_EXPENSES',       name: 'Travel Expenses',       group: 'Travel',             type: 'Growth',               portfolioItemKeyStrategy: 'IGNORE',  icon: '🗺️' },
  { code: 'DONATIONS',             name: 'Donations',             group: 'Donations',          type: 'Growth',               portfolioItemKeyStrategy: 'IGNORE',  icon: '❤️' },
  { code: 'BOOKS',                 name: 'Books',                 group: 'Education',          type: 'Growth',               portfolioItemKeyStrategy: 'IGNORE',  icon: '📖' },
];

import type { AnalyticsResponse } from '@/types/api';

// Types for Financial Statement data
export interface FinancialCategory {
  name: string;
  value: number;
}

export interface FinancialType {
  name: string;
  totals: { [year: string]: number };
  categories: {
    name: string;
    values: { [year: string]: number };
  }[];
}

export interface FinancialStatement {
  types: FinancialType[];
  netIncome: { [year: string]: number };
  netSavings: { [year: string]: number };
  savingsPercentage: { [year: string]: number };
}

export interface MonthlyData {
  month: string;
  revenue: number;
  expenses: number;
  savings: number;
}

export interface AnalyticsData {
    [timeKey: string]: {
      [typeName: string]: {
        [groupName: string]: {
          balance?: number;
          credit?: number;
          debit?: number;
        };
      };
    };
  }

// Define types for Financial Statement structure
export interface FinancialSection {
  name: string;
  isCalculated: boolean;
  isExpandable: boolean;
}

export interface FinancialTypeSection extends FinancialSection {
  type: string;
  isCalculated: false;
  isSeparator?: never;
  calculation?: never;
}

export interface FinancialCalculatedSection extends FinancialSection {
  isCalculated: true;
  isExpandable: false;
  calculation: (data: FinancialStatement, year: string) => number;
  type?: never;
  isSeparator?: never;
}

export interface FinancialSeparatorSection extends FinancialSection {
  isSeparator: true;
  isCalculated: false;
  isExpandable: false;
  type?: never;
  calculation?: never;
}

export type FinancialSectionType = FinancialTypeSection | FinancialCalculatedSection | FinancialSeparatorSection;

// Helper function to calculate discretionary income: Income - Essentials
export const calculateDiscretionaryIncome = (data: FinancialStatement, year: string): number => {
  const income = data.types.find(t => t.name === 'Income')?.totals[year] || 0;
  const essentials = data.types.find(t => t.name === 'Essentials')?.totals[year] || 0;
  return income + essentials;
};

// Helper function to calculate savings capacity: Discretionary Income - Lifestyle
export const calculateSavingsCapacity = (data: FinancialStatement, year: string): number => {
  const discretionaryIncome = calculateDiscretionaryIncome(data, year);
  const lifestyle = data.types.find(t => t.name === 'Lifestyle')?.totals[year] || 0;
  return discretionaryIncome + lifestyle;
};

// Helper function to calculate net savings: Savings Capacity - Growth
export const calculateNetSavings = (data: FinancialStatement, year: string): number => {
  const savingsCapacity = calculateSavingsCapacity(data, year);
  const growth = data.types.find(t => t.name === 'Growth')?.totals[year] || 0;
  return savingsCapacity + growth;
};

// Helper function to calculate percentage of a total
export const calculatePercentage = (value: number, total: number): number => {
  if (total === 0) return 0;
  return (value / total) * 100;
};

// Helper function to format percentage
export const formatPercentage = (value: number): string => {
  return `${value >= 0 ? '+' : ''}${value.toFixed(0)}%`;
};

// Define the Financial Statement structure
// Income → Essentials → Discretionary Income → Lifestyle → Savings Capacity → Growth → Net Savings
// → [Other Activity] → Ventures → Transfers → Investments → Debt
export const FINANCIAL_STRUCTURE: Record<string, FinancialSectionType> = {
  INCOME: {
    name: 'Income',
    type: 'Income',
    isCalculated: false,
    isExpandable: true,
  },
  ESSENTIALS: {
    name: 'Essentials',
    type: 'Essentials',
    isCalculated: false,
    isExpandable: true,
  },
  DISCRETIONARY_INCOME: {
    name: 'Discretionary Income',
    isCalculated: true,
    isExpandable: false,
    calculation: calculateDiscretionaryIncome
  },
  LIFESTYLE: {
    name: 'Lifestyle',
    type: 'Lifestyle',
    isCalculated: false,
    isExpandable: true,
  },
  SAVINGS_CAPACITY: {
    name: 'Savings Capacity',
    isCalculated: true,
    isExpandable: false,
    calculation: calculateSavingsCapacity
  },
  GROWTH: {
    name: 'Growth',
    type: 'Growth',
    isCalculated: false,
    isExpandable: true,
  },
  NET_SAVINGS: {
    name: 'Net Savings',
    isCalculated: true,
    isExpandable: false,
    calculation: calculateNetSavings
  },
  OTHER_ACTIVITY: {
    name: 'Other Activity',
    isSeparator: true,
    isCalculated: false,
    isExpandable: false,
  },
  VENTURES: {
    name: 'Ventures',
    type: 'Ventures',
    isCalculated: false,
    isExpandable: true,
  },
  TRANSFERS: {
    name: 'Transfers',
    type: 'Transfers',
    isCalculated: false,
    isExpandable: true,
  },
  INVESTMENTS: {
    name: 'Investments',
    type: 'Investments',
    isCalculated: false,
    isExpandable: true,
  },
  DEBT: {
    name: 'Debt',
    type: 'Debt',
    isCalculated: false,
    isExpandable: true,
  }
};

// Type guards for Financial Statement sections
export function isCalculatedSection(section: FinancialSectionType): section is FinancialCalculatedSection {
  return section.isCalculated;
}

export function isTypeSection(section: FinancialSectionType): section is FinancialTypeSection {
  return !section.isCalculated && !('isSeparator' in section && section.isSeparator);
}

export function isSeparatorSection(section: FinancialSectionType): section is FinancialSeparatorSection {
  return 'isSeparator' in section && section.isSeparator === true;
}

export const processAnalyticsIntoFinancialStatement = (
    analytics: AnalyticsResponse,
    timeKeys: string[],
    monthlyAnalytics: AnalyticsResponse | null
  ): {
    statement: FinancialStatement;
    monthlyData: MonthlyData[];
  } => {
    try {
      const statement: FinancialStatement = {
        types: [],
        netIncome: {},
        netSavings: {},
        savingsPercentage: {}
      };

      // Ensure all FINANCIAL_STRUCTURE types exist in the statement to maintain order
      Object.values(FINANCIAL_STRUCTURE).forEach(section => {
        if (isTypeSection(section)) {
          statement.types.push({
            name: section.type,
            totals: {},
            categories: []
          });
        }
      });

      timeKeys.forEach(timeKey => {
        const timeKeyData = (analytics.data as AnalyticsData)[timeKey];
        if (!timeKeyData) return;

        Object.entries(timeKeyData).forEach(([typeName, groups]) => {
          let typeEntry = statement.types.find(t => t.name === typeName);
          if (!typeEntry) {
            typeEntry = { name: typeName, totals: {}, categories: [] };
            statement.types.push(typeEntry);
          }

          let totalForTimeKey = 0;
          Object.entries(groups).forEach(([groupName, values]) => {
            let balance = 0;
            // For Investments and Debt, calculate net cash flow activity
            if (typeName === 'Investments' || typeName === 'Debt') {
              balance = (values.credit || 0) - (values.debit || 0);
            } else {
              balance = values.balance || 0;
            }
            totalForTimeKey += balance;

            let category = typeEntry!.categories.find(c => c.name === groupName);
            if (!category) {
              category = { name: groupName, values: {} };
              typeEntry!.categories.push(category);
            }
            category.values[timeKey] = balance;
          });
          typeEntry.totals[timeKey] = totalForTimeKey;
        });

        // Calculate metrics for this timeKey
        const netIncome = statement.types.find(t => t.name === 'Income')?.totals[timeKey] || 0;
        statement.netIncome[timeKey] = netIncome;
        statement.netSavings[timeKey] = calculateNetSavings({ ...statement }, timeKey);
        statement.savingsPercentage[timeKey] = netIncome > 0 ? (statement.netSavings[timeKey] / netIncome) * 100 : 0;
      });

      const monthlyData: MonthlyData[] = [];
      // Use the passed-in monthlyAnalytics data instead of fetching it here
      if (monthlyAnalytics?.data) {
        Object.entries(monthlyAnalytics.data as AnalyticsData).forEach(([monthKey, monthData]) => {
          let revenue = 0;
          let expenses = 0;

          Object.entries(monthData).forEach(([typeName, groups]) => {
            const typeTotal = Object.values(groups).reduce((sum, group) => sum + (group.balance || 0), 0);
             if (typeName === 'Income') {
              revenue += typeTotal;
            } else if (['Essentials', 'Lifestyle', 'Growth'].includes(typeName)) {
              expenses += Math.abs(typeTotal);
            }
          });

          monthlyData.push({
            month: new Date(monthKey.split('-').join('/')).toLocaleString('default', { month: 'short' }),
            revenue,
            expenses,
            savings: revenue - expenses
          });
        });
      }

      return { statement, monthlyData };
    } catch (error) {
      console.error("Error processing analytics:", error);
      return {
        statement: {
          types: [],
          netIncome: {},
          netSavings: {},
          savingsPercentage: {}
        },
        monthlyData: []
      };
    }
  };

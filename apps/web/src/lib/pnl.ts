import type { AnalyticsResponse } from '@/types/api';

// Types for P&L data
export interface PnLCategory {
  name: string;
  value: number;
}

export interface PnLType {
  name: string;
  totals: { [year: string]: number };
  categories: {
    name: string;
    values: { [year: string]: number };
  }[];
}

export interface PnLStatement {
  types: PnLType[];
  netIncome: { [year: string]: number };
  netProfit: { [year: string]: number };
  profitPercentage: { [year: string]: number };
}

export interface MonthlyData {
  month: string;
  revenue: number;
  expenses: number;
  profit: number;
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

// Define types for P&L structure
export interface PnLSection {
  name: string;
  isCalculated: boolean;
  isExpandable: boolean;
}

export interface PnLTypeSection extends PnLSection {
  type: string;
  isCalculated: false;
  calculation?: never;
}

export interface PnLCalculatedSection extends PnLSection {
  isCalculated: true;
  calculation: (data: PnLStatement, year: string) => number;
  type?: never;
}

export type PnLSectionType = PnLTypeSection | PnLCalculatedSection;

// Helper function to calculate gross profit: Income - Essentials
export const calculateGrossProfit = (data: PnLStatement, year: string): number => {
  const income = data.types.find(t => t.name === 'Income')?.totals[year] || 0;
  const essentials = data.types.find(t => t.name === 'Essentials')?.totals[year] || 0;
  return income + essentials;
};

// Helper function to calculate operating profit: Gross Profit - Lifestyle
export const calculateOperatingProfit = (data: PnLStatement, year: string): number => {
  const grossProfit = calculateGrossProfit(data, year);
  const lifestyle = data.types.find(t => t.name === 'Lifestyle')?.totals[year] || 0;
  return grossProfit + lifestyle;
};

// Helper function to calculate net profit: Operating Profit - Growth
export const calculateNetProfit = (data: PnLStatement, year: string): number => {
  const operatingProfit = calculateOperatingProfit(data, year);
  const growth = data.types.find(t => t.name === 'Growth')?.totals[year] || 0;
  return operatingProfit + growth;
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

// Define the P&L structure
// Income → Essentials → Gross Profit → Lifestyle → Operating Profit → Growth → Net Profit
// → Ventures → Transfers → Investments → Debt
export const PNL_STRUCTURE: Record<string, PnLSectionType> = {
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
  GROSS_PROFIT: {
    name: 'Gross Profit',
    isCalculated: true,
    isExpandable: false,
    calculation: calculateGrossProfit
  },
  LIFESTYLE: {
    name: 'Lifestyle',
    type: 'Lifestyle',
    isCalculated: false,
    isExpandable: true,
  },
  OPERATING_PROFIT: {
    name: 'Operating Profit',
    isCalculated: true,
    isExpandable: false,
    calculation: calculateOperatingProfit
  },
  GROWTH: {
    name: 'Growth',
    type: 'Growth',
    isCalculated: false,
    isExpandable: true,
  },
  NET_PROFIT: {
    name: 'Net Profit',
    isCalculated: true,
    isExpandable: false,
    calculation: calculateNetProfit
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

// Type guards for P&L sections
export function isCalculatedSection(section: PnLSectionType): section is PnLCalculatedSection {
  return section.isCalculated;
}

export function isTypeSection(section: PnLSectionType): section is PnLTypeSection {
  return !section.isCalculated;
}

export const processAnalyticsIntoPnL = (
    analytics: AnalyticsResponse,
    timeKeys: string[],
    monthlyAnalytics: AnalyticsResponse | null
  ): {
    statement: PnLStatement;
    monthlyData: MonthlyData[];
  } => {
    try {
      const statement: PnLStatement = {
        types: [],
        netIncome: {},
        netProfit: {},
        profitPercentage: {}
      };

      // Ensure all PNL STRUCTURE types exist in the statement to maintain order
      Object.values(PNL_STRUCTURE).forEach(section => {
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
        statement.netProfit[timeKey] = calculateNetProfit({ ...statement }, timeKey);
        statement.profitPercentage[timeKey] = netIncome > 0 ? (statement.netProfit[timeKey] / netIncome) * 100 : 0;
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
            profit: revenue - expenses
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
          netProfit: {},
          profitPercentage: {}
        },
        monthlyData: []
      };
    }
  }; 
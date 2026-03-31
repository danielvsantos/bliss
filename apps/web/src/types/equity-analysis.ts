export interface EquityHolding {
  symbol: string;
  name: string;
  quantity: number;
  currentValue: number;
  currentValueUSD: number;
  sector: string;
  industry: string;
  country: string;
  peRatio: number | null;
  dividendYield: number | null;
  trailingEps: number | null;
  latestEpsActual: number | null;
  latestEpsSurprise: number | null;
  week52High: number | null;
  week52Low: number | null;
  averageVolume: number | null;
  logoUrl: string | null;
  weight: number;
}

export interface EquityGroup {
  name: string;
  totalValue: number;
  weight: number;
  holdingsCount: number;
  holdings: EquityHolding[];
}

export interface EquityAnalysisSummary {
  totalEquityValue: number;
  holdingsCount: number;
  weightedPeRatio: number | null;
  weightedDividendYield: number | null;
}

export interface EquityAnalysisResponse {
  portfolioCurrency: string;
  summary: EquityAnalysisSummary;
  groups: EquityGroup[];
}

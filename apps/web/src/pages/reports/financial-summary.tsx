import React, { useState, useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Badge } from "@/components/ui/badge";
import { Check, ChevronsUpDown, X } from "lucide-react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from "recharts";
import { Button } from "@/components/ui/button";
import { formatCurrency } from "@/lib/utils";
import { ChevronDown, ChevronRight } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { MobileFilterDrawer } from "@/components/ui/mobile-filter-drawer";
import { getTenantMeta } from "@/utils/tenantMetaStorage";
import { useTenantSettings } from "@/hooks/use-tenant-settings";
import type { Country, Currency, AnalyticsResponse } from "@/types/api";
import {
  calculateDiscretionaryIncome,
  calculateNetSavings,
  calculatePercentage,
  formatPercentage,
  FINANCIAL_STRUCTURE,
  isCalculatedSection,
  isTypeSection,
  isSeparatorSection,
  processAnalyticsIntoFinancialStatement,
  FinancialStatement,
  MonthlyData,
  AnalyticsData,
} from "@/lib/financial-summary";
import { translateCategoryGroup, translateCategoryType } from "@/lib/category-i18n";

export default function FinancialSummaryPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [viewType, setViewType] = useState<'year' | 'quarter' | 'month'>('year');

  // Get tenant metadata from localStorage and tenant settings (for portfolioCurrency)
  const tenantMeta = getTenantMeta();
  const { data: tenantSettings } = useTenantSettings();

  // Generate arrays for selectors - moved inside component and memoized
  const availableYears = React.useMemo(() => {
    if (tenantMeta?.transactionYears && tenantMeta.transactionYears.length > 0) {
      return tenantMeta.transactionYears.map(String);
    }
    // Fallback for new users with no transactions
    return [new Date().getFullYear().toString()];
  }, [tenantMeta]);

  const [selectedYears, setSelectedYears] = useState<string[]>([availableYears[0]]);
  const [selectedCountries, setSelectedCountries] = useState<string[]>([]);
  const [selectedCurrency, setSelectedCurrency] = useState<string>('USD');
  const [startMonth, setStartMonth] = useState<string>(`${new Date().getFullYear()}-01`);
  const [endMonth, setEndMonth] = useState<string>(`${new Date().getFullYear()}-12`);
  const [startQuarter, setStartQuarter] = useState<string>(`${new Date().getFullYear()}-Q1`);
  const [endQuarter, setEndQuarter] = useState<string>(`${new Date().getFullYear()}-Q4`);
  const [activeTab, setActiveTab] = useState("statement");
  const [expandedSections, setExpandedSections] = useState<Record<string, boolean>>({});
  const [isLoading, setIsLoading] = useState(true);
  const [statementData, setStatementData] = useState<FinancialStatement | null>(null);
  const [monthlyData, setMonthlyData] = useState<MonthlyData[]>([]);
  const [tableColumns, setTableColumns] = useState<string[]>([]);
  const [openCountries, setOpenCountries] = useState(false);
  const [openYears, setOpenYears] = useState(false);

  const availableCountries: Country[] = useMemo(() => tenantMeta?.countries || [], [tenantMeta?.countries]);
  const availableCurrencies: Currency[] = useMemo(() => tenantMeta?.currencies || [], [tenantMeta?.currencies]);

  // Initialize selected countries from tenant metadata
  useEffect(() => {
    if (availableCountries.length > 0 && selectedCountries.length === 0) {
      setSelectedCountries(availableCountries.map(c => c.id));
    }
  }, [availableCountries, selectedCountries]);

  // Sync currency to tenant's portfolioCurrency when settings load
  useEffect(() => {
    if (tenantSettings?.portfolioCurrency) {
      setSelectedCurrency(tenantSettings.portfolioCurrency);
    }
  }, [tenantSettings?.portfolioCurrency]);

  const months = React.useMemo(() => {
    return Array.from({ length: 12 }, (_, i) => {
      const month = i + 1;
      return {
        value: `${month.toString().padStart(2, '0')}`,
        label: new Date(new Date().getFullYear(), i, 1).toLocaleString('default', { month: 'long' })
      };
    });
  }, []);

  const quarters = React.useMemo(() => [
    { value: 'Q1', label: t('financialSummary.quarters.q1') },
    { value: 'Q2', label: t('financialSummary.quarters.q2') },
    { value: 'Q3', label: t('financialSummary.quarters.q3') },
    { value: 'Q4', label: t('financialSummary.quarters.q4') }
  ], [t]);

  useEffect(() => {
    const loadData = async () => {
      await fetchFinancialData();
    };
    loadData();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- fetchFinancialData is defined below the effect; adding it would cause infinite re-renders
  }, [viewType, selectedYears, selectedCountries, selectedCurrency, startMonth, endMonth, startQuarter, endQuarter]);

  const fetchFinancialData = async () => {
    setIsLoading(true);
    try {
      // Prepare API parameters based on view type
      const apiParams: { view: 'year' | 'quarter' | 'month'; currency: string; countries: string[]; years?: number[]; startMonth?: string; endMonth?: string; startQuarter?: string; endQuarter?: string } = {
        view: viewType,
        currency: selectedCurrency,
        countries: selectedCountries,
      };

      switch (viewType) {
        case 'year':
          apiParams.years = selectedYears.map(y => parseInt(y));
          break;
        case 'month':
          apiParams.startMonth = startMonth;
          apiParams.endMonth = endMonth;
          break;
        case 'quarter':
          apiParams.startQuarter = startQuarter;
          apiParams.endQuarter = endQuarter;
          break;
      }

      // Fetch main analytics data
      const analyticsResponse = await api.getAnalytics(apiParams);
      const newTableColumns = Object.keys(analyticsResponse.data).sort();
      setTableColumns(newTableColumns);

      let monthlyAnalyticsResponse: AnalyticsResponse | null = null;
      if (viewType === 'month') {
        // Explicitly fetch monthly data here instead of inside the processing function
        monthlyAnalyticsResponse = await api.getAnalytics({
          view: 'month',
          startMonth,
          endMonth,
          currency: selectedCurrency,
          countries: selectedCountries
        });
      }

      // Process analytics data into Financial Statement format
      const processedData = await processAnalyticsIntoFinancialStatement(
        analyticsResponse,
        newTableColumns,
        viewType === 'month' ? monthlyAnalyticsResponse : null // Pass monthly data if applicable
      );
      setStatementData(processedData.statement);
      setMonthlyData(processedData.monthlyData);
    } catch (error) {
      console.error("Error fetching financial data:", error);
      setStatementData({
        types: [],
        netIncome: {},
        netSavings: {},
        savingsPercentage: {}
      });
      setMonthlyData([]);
    } finally {
      setIsLoading(false);
    }
  };

  // Toggle section expanded state
  const toggleSection = (section: string) => {
    setExpandedSections(prev => ({
      ...prev,
      [section]: !prev[section]
    }));
  };

  // Render a value with the appropriate color (negative values in red)
  const renderValue = (value: number) => {
    const formattedValue = formatCurrency(value, selectedCurrency, "en-US", {
      maximumFractionDigits: 0,
      minimumFractionDigits: 0,
    });
    const isNegative = value < 0;

    return (
      <span className={isNegative ? "text-destructive" : "text-primary"}>
        {formattedValue}
      </span>
    );
  };

  // Map calculated section names to translation keys
  const getCalculatedSectionLabel = (name: string): string => {
    const keyMap: Record<string, string> = {
      'Discretionary Income': 'financialSummary.discretionaryIncome',
      'Savings Capacity': 'financialSummary.savingsCapacity',
      'Net Savings': 'financialSummary.netSavings',
    };
    return t(keyMap[name] || name, name);
  };

  if (isLoading || !statementData) {
    return (
      <div className="container mx-auto py-6">
        <div className="flex justify-center items-center h-[60vh]">
          <p className="text-muted-foreground">{t("common.loading")}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="container mx-auto py-6">
      <div className="flex flex-col space-y-8">
        <div className="flex flex-col sm:flex-row sm:justify-between sm:items-start gap-4">
          <div>
            <h2 className="text-3xl font-bold tracking-tight mb-2">{t("pages.financialSummary.title")}</h2>
            <p className="text-muted-foreground">
              {t("pages.financialSummary.subtitle")}
            </p>
          </div>
          <MobileFilterDrawer>
          <div className="flex flex-col items-end gap-4">
            <div className="flex flex-wrap gap-2">
              <Select value={viewType} onValueChange={(value: 'year' | 'quarter' | 'month') => setViewType(value)}>
                <SelectTrigger className="w-[180px]">
                  <SelectValue placeholder={t("time.period")} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="year">{t("time.year")}</SelectItem>
                  <SelectItem value="quarter">{t("time.quarter")}</SelectItem>
                  <SelectItem value="month">{t("time.month")}</SelectItem>
                </SelectContent>
              </Select>

              {/* Currency Selector */}
              <Select
                value={selectedCurrency}
                onValueChange={setSelectedCurrency}
              >
                <SelectTrigger className="w-[120px]">
                  <SelectValue placeholder={t("common.currency")} />
                </SelectTrigger>
                <SelectContent>
                  {availableCurrencies.map((currency) => (
                    <SelectItem key={currency.id} value={currency.id}>
                      {currency.symbol} {currency.id}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              {/* Country Multi-Select */}
              <Popover open={openCountries} onOpenChange={setOpenCountries}>
                <PopoverTrigger asChild>
                  <Button
                    variant="outline"
                    role="combobox"
                    aria-expanded={openCountries}
                    className="w-[200px] justify-between"
                  >
                    <span className="truncate">
                      {selectedCountries.length > 0
                        ? t('pages.expenses.countriesSelected', { count: selectedCountries.length })
                        : t("common.selectCountries")}
                    </span>
                    <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-[200px] p-0">
                  <Command>
                    <CommandInput placeholder={t("common.searchCountry")} />
                    <CommandEmpty>{t("common.noCountryFound")}</CommandEmpty>
                    <CommandList>
                      <CommandGroup>
                        {availableCountries.map((country) => (
                          <CommandItem
                            key={country.id}
                            value={country.id}
                            onSelect={() => {
                              const newSelection = selectedCountries.includes(country.id)
                                ? selectedCountries.filter((id) => id !== country.id)
                                : [...selectedCountries, country.id];
                              setSelectedCountries(newSelection);
                            }}
                          >
                            <Check
                              className={cn(
                                "mr-2 h-4 w-4",
                                selectedCountries.includes(country.id) ? "opacity-100" : "opacity-0"
                              )}
                            />
                            {country.emoji} {country.name}
                          </CommandItem>
                        ))}
                      </CommandGroup>
                    </CommandList>
                  </Command>
                </PopoverContent>
              </Popover>

              {viewType === 'year' && (
                <Popover open={openYears} onOpenChange={setOpenYears}>
                  <PopoverTrigger asChild>
                    <Button
                      variant="outline"
                      role="combobox"
                      aria-expanded={openYears}
                      className="w-[200px] justify-between"
                    >
                      <span className="truncate">
                        {selectedYears.length > 0
                          ? selectedYears.join(', ')
                          : t("common.selectYears")}
                      </span>
                      <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-[200px] p-0">
                    <Command>
                      <CommandList>
                        <CommandGroup>
                          {availableYears.map((year) => (
                            <CommandItem
                              key={year}
                              value={year}
                              onSelect={() => {
                                const newSelection = selectedYears.includes(year)
                                  ? selectedYears.filter((y) => y !== year)
                                  : [...selectedYears, year];
                                setSelectedYears(newSelection.sort((a, b) => parseInt(b) - parseInt(a)));
                              }}
                            >
                              <Check
                                className={cn(
                                  "mr-2 h-4 w-4",
                                  selectedYears.includes(year) ? "opacity-100" : "opacity-0"
                                )}
                              />
                              {year}
                            </CommandItem>
                          ))}
                        </CommandGroup>
                      </CommandList>
                    </Command>
                  </PopoverContent>
                </Popover>
              )}

              {viewType === 'month' && (
                <div className="flex space-x-2">
                  <Select
                    value={startMonth}
                    onValueChange={setStartMonth}
                  >
                    <SelectTrigger className="w-[180px]">
                      <SelectValue placeholder={t("time.startMonth")} />
                    </SelectTrigger>
                    <SelectContent>
                      {availableYears.map((year) => (
                        months.map((month) => (
                          <SelectItem
                            key={`${year}-${month.value}`}
                            value={`${year}-${month.value}`}
                          >
                            {month.label} {year}
                          </SelectItem>
                        ))
                      ))}
                    </SelectContent>
                  </Select>
                  <Select
                    value={endMonth}
                    onValueChange={setEndMonth}
                  >
                    <SelectTrigger className="w-[180px]">
                      <SelectValue placeholder={t("time.endMonth")} />
                    </SelectTrigger>
                    <SelectContent>
                      {availableYears.map((year) => (
                        months.map((month) => (
                          <SelectItem
                            key={`${year}-${month.value}`}
                            value={`${year}-${month.value}`}
                          >
                            {month.label} {year}
                          </SelectItem>
                        ))
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}

              {viewType === 'quarter' && (
                <div className="flex space-x-2">
                  <Select
                    value={startQuarter}
                    onValueChange={setStartQuarter}
                  >
                    <SelectTrigger className="w-[180px]">
                      <SelectValue placeholder={t("time.startQuarter")} />
                    </SelectTrigger>
                    <SelectContent>
                      {availableYears.map((year) => (
                        quarters.map((quarter) => (
                          <SelectItem
                            key={`${year}-${quarter.value}`}
                            value={`${year}-${quarter.value}`}
                          >
                            {quarter.label} {year}
                          </SelectItem>
                        ))
                      ))}
                    </SelectContent>
                  </Select>
                  <Select
                    value={endQuarter}
                    onValueChange={setEndQuarter}
                  >
                    <SelectTrigger className="w-[180px]">
                      <SelectValue placeholder={t("time.endQuarter")} />
                    </SelectTrigger>
                    <SelectContent>
                      {availableYears.map((year) => (
                        quarters.map((quarter) => (
                          <SelectItem
                            key={`${year}-${quarter.value}`}
                            value={`${year}-${quarter.value}`}
                          >
                            {quarter.label} {year}
                          </SelectItem>
                        ))
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}

            </div>

            {/* Selected Items Display - This section is now removed */}

          </div>
          </MobileFilterDrawer>
        </div>

        <Tabs defaultValue="statement" value={activeTab} onValueChange={setActiveTab}>
          <TabsList className="mb-6">
            <TabsTrigger value="statement">{t("pages.financialSummary.statement")}</TabsTrigger>
            <TabsTrigger value="chart">{t("pages.financialSummary.trend")}</TabsTrigger>
          </TabsList>

          <TabsContent value="statement">
            <Card>
              <CardHeader>
                <CardTitle>{t("pages.financialSummary.statement")}</CardTitle>
                <CardDescription>
                  {t("pages.financialSummary.breakdown")}
                </CardDescription>
              </CardHeader>
              <CardContent>
                <Table>
                  <TableHeader>
                    <TableRow className="hover:bg-transparent">
                      <TableHead className="w-[40%] font-bold">{t("common.type")}</TableHead>
                      {tableColumns.map(column => (
                        <TableHead key={column} className="text-right font-bold">
                          {column}
                        </TableHead>
                      ))}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {Object.entries(FINANCIAL_STRUCTURE).map(([key, section]) => {
                      // Render separator row
                      if (isSeparatorSection(section)) {
                        return (
                          <TableRow key={key} className="bg-muted/30 hover:bg-muted/30">
                            <TableCell
                              colSpan={tableColumns.length + 1}
                              className="py-2 px-4 text-xs font-semibold uppercase tracking-wider text-muted-foreground border-t-2 border-border"
                            >
                              {t('financialSummary.otherActivity')}
                            </TableCell>
                          </TableRow>
                        );
                      }

                      const typeData = isTypeSection(section)
                        ? statementData.types.find(t => t.name === section.type)
                        : null;

                      return (
                        <React.Fragment key={key}>
                          <TableRow
                            className={cn(
                              "group",
                              section.isExpandable && "cursor-pointer hover:bg-muted/50",
                              !section.isExpandable && "border-t-2 border-border"
                            )}
                            onClick={() => section.isExpandable && toggleSection(section.name)}
                          >
                            <TableCell className="font-bold flex items-center">
                              {section.isExpandable && (
                                section.name in expandedSections ? (
                                  <ChevronDown className="mr-2 h-4 w-4 text-muted-foreground" />
                                ) : (
                                  <ChevronRight className="mr-2 h-4 w-4 text-muted-foreground" />
                                )
                              )}
                              {isTypeSection(section)
                                ? translateCategoryType(t, section.name)
                                : getCalculatedSectionLabel(section.name)}
                            </TableCell>
                            {tableColumns.map(column => {
                              const totalIncome = statementData.types.find(t => t.name === 'Income')?.totals[column] || 0;
                              const value = isCalculatedSection(section)
                                ? section.calculation(statementData, column)
                                : typeData?.totals[column] || 0;
                              const percentage = calculatePercentage(value, totalIncome);

                              const isIncomeRow = section.name === 'Income';

                              return (
                                <TableCell key={column} className="text-right font-bold">
                                  <div className="flex flex-col items-end">
                                    {renderValue(value)}
                                    {!isIncomeRow && (
                                      <span className="text-xs text-muted-foreground">
                                        {formatPercentage(percentage)}
                                      </span>
                                    )}
                                  </div>
                                </TableCell>
                              );
                            })}
                          </TableRow>

                          {section.isExpandable && expandedSections[section.name] && typeData?.categories.map((category, catIndex) => (
                            <TableRow key={`${section.name}-${catIndex}`} className="bg-muted/50">
                              <TableCell className="pl-10">
                                {translateCategoryGroup(t, category.name)}
                              </TableCell>
                              {tableColumns.map(column => {
                                const totalIncome = statementData.types.find(t => t.name === 'Income')?.totals[column] || 0;
                                const value = category.values[column] || 0;
                                const percentage = calculatePercentage(value, totalIncome);

                                return (
                                  <TableCell key={column} className="text-right">
                                    <div className="flex flex-col items-end">
                                      {renderValue(value)}
                                      <span className="text-xs text-muted-foreground">
                                        {formatPercentage(percentage)}
                                      </span>
                                    </div>
                                  </TableCell>
                                );
                              })}
                            </TableRow>
                          ))}
                        </React.Fragment>
                      );
                    })}
                  </TableBody>
                </Table>

              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="chart">
            <Card>
              <CardHeader>
                <CardTitle>{t("pages.financialSummary.trend")}</CardTitle>
                <CardDescription>
                  {t("pages.financialSummary.chartDescription")}
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="h-[400px] w-full">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart
                      data={monthlyData}
                      margin={{
                        top: 20,
                        right: 30,
                        left: 20,
                        bottom: 5,
                      }}
                    >
                      <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                      <XAxis dataKey="month" />
                      <YAxis />
                      <Tooltip
                        formatter={(value) => formatCurrency(value as number, selectedCurrency, "en-US", { maximumFractionDigits: 0, minimumFractionDigits: 0 })}
                        contentStyle={{
                          backgroundColor: "hsl(var(--popover))",
                          border: "1px solid hsl(var(--border))",
                          borderRadius: "var(--radius)",
                        }}
                      />
                      <Legend />
                      <Line
                        type="monotone"
                        dataKey="revenue"
                        stroke="hsl(var(--chart-1))"
                        strokeWidth={2}
                        activeDot={{ r: 8 }}
                        name={t("pages.financialSummary.totalRevenue")}
                      />
                      <Line
                        type="monotone"
                        dataKey="expenses"
                        stroke="hsl(var(--chart-2))"
                        strokeWidth={2}
                        name={t("pages.financialSummary.totalExpenses")}
                      />
                      <Line
                        type="monotone"
                        dataKey="savings"
                        stroke="hsl(var(--chart-3))"
                        strokeWidth={2}
                        name={t("pages.financialSummary.netSavings")}
                      />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}

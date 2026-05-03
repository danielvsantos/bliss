import { useState, useMemo, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { format, differenceInMonths } from "date-fns";
import {
  Card,
  CardContent,
  CardDescription,
  CardDivider,
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
  PieChart,
  Pie,
  Cell,
  ResponsiveContainer,
  Tooltip,
  Legend,
} from "recharts";
import { Button } from "@/components/ui/button";
import { formatCurrency } from "@/lib/utils";
import { ArrowLeft, Calendar as CalendarIcon, Check, ChevronsUpDown, PieChart as PieChartIcon } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useAnalytics } from "@/hooks/use-analytics";
import type { AnalyticsResponse, Country, Currency } from "@/types/api";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { getTenantMeta } from "@/utils/tenantMetaStorage";
import { useTenantSettings } from "@/hooks/use-tenant-settings";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Calendar } from "@/components/ui/calendar";
import { Label } from "@/components/ui/label";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { useUserPreferences, useCategories } from "@/hooks/use-metadata";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Legend as RechartsLegend,
} from "recharts";
import { ExpenseTransactionList } from "@/components/entities/expense-transaction-list";
import { translateCategoryType, translateCategoryGroup } from "@/lib/category-i18n";
import { MobileFilterDrawer } from "@/components/ui/mobile-filter-drawer";
import { useIsMobile } from "@/hooks/use-mobile";

const ALLOWED_TYPES = ['Essentials', 'Lifestyle', 'Growth'];

const CHART_COLORS = [
  "hsl(var(--chart-1))",
  "hsl(var(--chart-2))",
  "hsl(var(--chart-3))",
  "hsl(var(--chart-4))",
  "hsl(var(--chart-5))",
];

const processAnalyticsData = (
  analyticsData: AnalyticsResponse | undefined,
  selectedType: string,
  t: (key: string) => string
) => {
  if (!analyticsData?.data) {
    return { pieData: [], totalExpenses: 0, highestCategory: { name: 'N/A', value: 0 } };
  }

  const expenseGroups: { [key: string]: number } = {};

  for (const timeKey in analyticsData.data) {
    const periodData = analyticsData.data[timeKey];
    const typesToProcess = selectedType === 'All'
      ? Object.keys(periodData).filter(key => ALLOWED_TYPES.includes(key))
      : [selectedType];
    for (const typeKey of typesToProcess) {
      const expenseData = periodData[typeKey] || {};
      for (const groupKey in expenseData) {
        if (!expenseGroups[groupKey]) {
          expenseGroups[groupKey] = 0;
        }
        expenseGroups[groupKey] += expenseData[groupKey].debit;
      }
    }
  }

  const totalExpenses = Object.values(expenseGroups).reduce((sum, value) => sum + value, 0);

  const sortedData = Object.entries(expenseGroups)
    .map(([name, value]) => ({ name, value }))
    .sort((a, b) => b.value - a.value);

  const top5 = sortedData.slice(0, 5);
  const otherValue = sortedData.slice(5).reduce((sum, item) => sum + item.value, 0);

  const pieData = top5.map((item, index) => ({
    ...item,
    percentage: totalExpenses > 0 ? ((item.value / totalExpenses) * 100).toFixed(1) : "0.0",
    color: CHART_COLORS[index % CHART_COLORS.length],
  }));

  if (otherValue > 0) {
    pieData.push({
      name: t('common.other'),
      value: otherValue,
      percentage: totalExpenses > 0 ? ((otherValue / totalExpenses) * 100).toFixed(1) : "0.0",
      color: CHART_COLORS[5 % CHART_COLORS.length],
    });
  }

  const highestCategory = sortedData.length > 0 ? sortedData[0] : { name: 'N/A', value: 0 };

  return { pieData, totalExpenses, highestCategory };
};

export default function ExpenseTrackingPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const [activeTab, setActiveTab] = useState("categories");
  const { data: userPreferences } = useUserPreferences();
  const { data: categories } = useCategories();
  const { data: tenantSettings } = useTenantSettings();
  const tenantMeta = getTenantMeta();

  const availableCountries: Country[] = useMemo(() => tenantMeta?.countries || [], [tenantMeta?.countries]);
  const availableCurrencies: Currency[] = useMemo(() => tenantMeta?.currencies || [], [tenantMeta?.currencies]);

  const defaultYear = (() => {
    const years = tenantMeta?.transactionYears;
    return (years && years.length > 0) ? years[0] : new Date().getFullYear();
  })();
  const [startDate, setStartDate] = useState<Date | undefined>(() => new Date(defaultYear, 0, 1));
  const [endDate, setEndDate] = useState<Date | undefined>(() => new Date(defaultYear, 11, 31));

  const [selectedCountries, setSelectedCountries] = useState<string[]>([]);
  const [selectedCurrency, setSelectedCurrency] = useState<string>(availableCurrencies[0]?.id || 'USD');
  const [openCountries, setOpenCountries] = useState(false);
  const [selectedCategoryType, setSelectedCategoryType] = useState<string>('All');
  const [selectedGroupsForTrend, setSelectedGroupsForTrend] = useState<string[]>([]);
  const [openGroups, setOpenGroups] = useState(false);
  const [activeCategoryGroup, setActiveCategoryGroup] = useState<string | null>(null);

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

  const expenseCategoryTypes = useMemo(() => {
    if (!categories) return [];
    const expenseTypes = new Set<string>();
    categories.forEach(cat => {
      if (cat.type === 'Essentials' || cat.type === 'Lifestyle' || cat.type === 'Growth') {
        expenseTypes.add(cat.type);
      }
    });
    return Array.from(expenseTypes);
  }, [categories]);

  const analyticsFilters = useMemo(() => {
    const typesParam = selectedCategoryType === 'All' ? ALLOWED_TYPES : [selectedCategoryType];
    if (!startDate || !selectedCurrency || selectedCountries.length === 0) {
      return { view: 'month' as const, types: typesParam };
    }
    const filters: { view: 'month'; currency: string; countries: string[]; types: string[]; startMonth: string; endMonth?: string } = {
      view: 'month',
      currency: selectedCurrency,
      countries: selectedCountries,
      types: typesParam,
      startMonth: format(startDate, 'yyyy-MM'),
    };
    if (endDate) {
      filters.endMonth = format(endDate, 'yyyy-MM');
    } else {
      filters.endMonth = filters.startMonth;
    }
    return filters;
  }, [startDate, endDate, selectedCurrency, selectedCountries, selectedCategoryType]);

  const { data: analyticsData, isLoading, isError } = useAnalytics(analyticsFilters);
  const { pieData, totalExpenses, highestCategory } = useMemo(() => processAnalyticsData(analyticsData, selectedCategoryType, t), [analyticsData, selectedCategoryType, t]);

  const trendChartData = useMemo(() => {
    if (!analyticsData?.data || selectedGroupsForTrend.length === 0) return [];
    const trendData: { [key: string]: Record<string, number | string> } = {};
    const typesToMerge = selectedCategoryType === 'All' ? ALLOWED_TYPES : [selectedCategoryType];
    Object.keys(analyticsData.data).forEach(timeKey => {
      trendData[timeKey] = { name: timeKey };
      const periodData = analyticsData.data[timeKey];
      // Merge all relevant types into a single group→debit map
      const expenseData: Record<string, number> = {};
      for (const type of typesToMerge) {
        const typeData = periodData[type] || {};
        for (const group in typeData) {
          expenseData[group] = (expenseData[group] || 0) + (typeData[group]?.debit || 0);
        }
      }
      selectedGroupsForTrend.forEach(group => {
        trendData[timeKey][group] = expenseData[group] || 0;
      });
    });
    return Object.values(trendData).sort((a, b) => (a.name as string).localeCompare(b.name as string));
  }, [analyticsData, selectedGroupsForTrend, selectedCategoryType]);

  const monthsDifference = useMemo(() => {
    if (!startDate || !endDate) return 1;
    const diff = differenceInMonths(endDate, startDate) + 1;
    return diff > 0 ? diff : 1;
  }, [startDate, endDate]);

  const CustomTooltip = ({ active, payload }: { active?: boolean; payload?: Array<{ dataKey: string; value: number; color?: string }> }) => {
    if (active && payload && payload.length) {
      const data = payload[0].payload;
      return (
        <div
          className="px-4 py-3 text-sm"
          style={{
            backgroundColor: "hsl(var(--popover))",
            border: "1px solid hsl(var(--border))",
            borderRadius: "var(--radius)",
            boxShadow: "0 4px 12px rgba(58,53,66,0.08)",
          }}
        >
          <p className="font-semibold text-foreground">{translateCategoryGroup(t, data.name)}</p>
          <p className="text-negative">{formatCurrency(data.value, analyticsData?.currency)}</p>
          <p className="text-muted-foreground">{data.percentage}% of total</p>
        </div>
      );
    }
    return null;
  };

  const selectedDateLabel = startDate
    ? (endDate ? `${format(startDate, "LLL dd, y")} - ${format(endDate, "LLL dd, y")}` : format(startDate, "LLL dd, y"))
    : t('expenses.pickDate');

  return (
    <div className="container mx-auto py-6">
      <div className="flex flex-col space-y-8">
        <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-4">
          <div>
            <h2 className="text-3xl font-bold tracking-tight mb-2">{t("pages.expenses.title")}</h2>
            <p className="text-muted-foreground">
              {t("pages.expenses.description")}
            </p>
          </div>
          <MobileFilterDrawer>
          <div className="flex flex-wrap items-center gap-3">
            {/* Start date */}
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">{t("time.startMonth")}</Label>
              <Popover>
                <PopoverTrigger asChild>
                  <Button
                    variant="outline"
                    className={cn(
                      "w-[150px] pl-3 text-left font-normal h-9 text-sm",
                      !startDate && "text-muted-foreground"
                    )}
                  >
                    {startDate ? format(startDate, "MMM d, yyyy") : t("time.startMonth")}
                    <CalendarIcon className="ml-auto h-3.5 w-3.5 opacity-50" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0" align="start">
                  <Calendar
                    mode="single"
                    captionLayout="dropdown-buttons"
                    fromYear={2010}
                    toYear={new Date().getFullYear() + 1}
                    selected={startDate}
                    onSelect={setStartDate}
                    initialFocus
                  />
                </PopoverContent>
              </Popover>
            </div>

            {/* End date */}
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">{t("time.endMonth")}</Label>
              <Popover>
                <PopoverTrigger asChild>
                  <Button
                    variant="outline"
                    className={cn(
                      "w-[150px] pl-3 text-left font-normal h-9 text-sm",
                      !endDate && "text-muted-foreground"
                    )}
                  >
                    {endDate ? format(endDate, "MMM d, yyyy") : t("time.endMonth")}
                    <CalendarIcon className="ml-auto h-3.5 w-3.5 opacity-50" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0" align="start">
                  <Calendar
                    mode="single"
                    captionLayout="dropdown-buttons"
                    fromYear={2010}
                    toYear={new Date().getFullYear() + 1}
                    selected={endDate}
                    onSelect={setEndDate}
                    initialFocus
                  />
                </PopoverContent>
              </Popover>
            </div>

            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">{t("common.type")}</Label>
              <Select value={selectedCategoryType} onValueChange={setSelectedCategoryType}>
                <SelectTrigger className="w-[150px] h-9 text-sm">
                  <SelectValue placeholder={t("pages.expenses.selectCategoryType")} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="All">{t("common.all")}</SelectItem>
                  {expenseCategoryTypes.map(type => (
                    <SelectItem key={type} value={type}>{translateCategoryType(t, type)}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">{t("common.currency")}</Label>
              <Select value={selectedCurrency} onValueChange={setSelectedCurrency}>
                <SelectTrigger className="w-[120px] h-9 text-sm">
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
            </div>

            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">{t("common.country")}</Label>
              <Popover open={openCountries} onOpenChange={setOpenCountries}>
                <PopoverTrigger asChild>
                  <Button
                    variant="outline"
                    role="combobox"
                    aria-expanded={openCountries}
                    className="w-[180px] justify-between h-9 text-sm"
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
            </div>
          </div>
          </MobileFilterDrawer>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                {t("pages.expenses.metrics.totalExpenses")}
              </CardTitle>
            </CardHeader>
            <CardContent>
              {isLoading ? <Skeleton className="h-9 w-3/4" /> : (
                <div className="text-[2rem] font-semibold tracking-tight text-negative leading-tight">
                  {formatCurrency(totalExpenses, analyticsData?.currency)}
                </div>
              )}
              <p className="text-xs text-muted-foreground mt-1.5">
                <span className="font-medium">{selectedDateLabel}</span>
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                {t("pages.expenses.metrics.averageMonthly")}
              </CardTitle>
            </CardHeader>
            <CardContent>
              {isLoading ? <Skeleton className="h-9 w-3/4" /> : (
                <div className="text-[2rem] font-semibold tracking-tight text-negative leading-tight">
                  {formatCurrency(totalExpenses / monthsDifference, analyticsData?.currency)}
                </div>
              )}
              <p className="text-xs text-muted-foreground mt-1.5">
                <span className="font-medium">{selectedDateLabel}</span>
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                {t("pages.expenses.metrics.highestCategory")}
              </CardTitle>
            </CardHeader>
            <CardContent>
              {isLoading ? <Skeleton className="h-9 w-3/4" /> : (
                <>
                  <div className="text-[2rem] font-semibold tracking-tight leading-tight">
                    {translateCategoryGroup(t, highestCategory.name)}
                  </div>
                  <p className="text-xs text-muted-foreground mt-1.5">
                    {formatCurrency(highestCategory.value, analyticsData?.currency)}
                  </p>
                </>
              )}
            </CardContent>
          </Card>
        </div>
        <Card>
          <CardHeader>
            <div className="flex justify-between items-center">
              <div>
                <CardTitle>{t("pages.expenses.breakdown.title")}</CardTitle>
                <CardDescription>
                  {t("pages.expenses.breakdown.description")}
                </CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardDivider />
          <CardContent>
            <Tabs
              defaultValue="categories"
              value={activeTab}
              onValueChange={setActiveTab}
              className="w-full"
            >
              <TabsList className="mb-6">
                <TabsTrigger value="categories">{t("pages.expenses.breakdown.tabs.byCategory")}</TabsTrigger>
                <TabsTrigger value="trends">{t("pages.expenses.breakdown.tabs.monthlyTrends")}</TabsTrigger>
                <TabsTrigger value="details">{t("pages.expenses.breakdown.tabs.detailedList")}</TabsTrigger>
              </TabsList>
              <TabsContent value="categories">
                {isLoading ? (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
                    <Skeleton className="h-[400px] w-full rounded-lg" />
                    <div className="space-y-4">
                      <Skeleton className="h-8 w-1/2 mb-4" />
                      {[...Array(5)].map((_, i) => <Skeleton key={i} className="h-10 w-full" />)}
                    </div>
                  </div>
                ) : isError ? (
                  <div className="text-center p-12 text-destructive">
                    <p>{t("notifications.error.generic")}</p>
                  </div>
                ) : pieData.length === 0 ? (
                  <div className="text-center p-12 text-muted-foreground">
                    <p>{t("notifications.info.noResults")}</p>
                  </div>
                ) : (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
                    <div className={isMobile ? "h-[280px]" : "h-[400px]"}>
                      <ResponsiveContainer width="100%" height="100%">
                        <PieChart>
                          <Pie
                            data={pieData}
                            cx="50%"
                            cy="50%"
                            innerRadius={isMobile ? 50 : 80}
                            outerRadius={isMobile ? 95 : 140}
                            paddingAngle={2}
                            dataKey="value"
                            label={isMobile ? false : ({ name, percentage }) => parseFloat(percentage) >= 5 ? `${translateCategoryGroup(t, name)}: ${percentage}%` : ''}
                            labelLine={false}
                            onClick={(data) => {
                              setActiveCategoryGroup(data.name);
                              setActiveTab('details');
                            }}
                          >
                            {pieData.map((entry, index) => (
                              <Cell
                                key={`cell-${index}`}
                                fill={entry.color}
                                className="cursor-pointer"
                              />
                            ))}
                          </Pie>
                          <Tooltip content={<CustomTooltip />} />
                          <Legend />
                        </PieChart>
                      </ResponsiveContainer>
                    </div>
                    <div>
                      <h3 className="text-lg font-semibold mb-4">{t("pages.expenses.breakdown.topCategories")}</h3>
                      <div className="space-y-2">
                        {pieData
                          .map((category, index) => (
                            <div
                              key={index}
                              className="p-2.5 rounded-lg hover:bg-muted/50 cursor-pointer transition-colors"
                              onClick={() => {
                                setActiveCategoryGroup(category.name);
                                setActiveTab('details');
                              }}
                            >
                              <div className="flex justify-between items-center mb-1.5">
                                <div className="flex items-center gap-2">
                                  <div
                                    className="w-3 h-3 rounded-full shrink-0"
                                    style={{ backgroundColor: category.color }}
                                  />
                                  <span className="text-sm font-medium">{translateCategoryGroup(t, category.name)}</span>
                                </div>
                                <div className="flex items-center gap-3">
                                  <span className="text-sm font-semibold text-negative tabular-nums">
                                    {formatCurrency(category.value, analyticsData?.currency)}
                                  </span>
                                  <span className="text-xs text-muted-foreground tabular-nums w-12 text-right">
                                    {category.percentage}%
                                  </span>
                                </div>
                              </div>
                              {/* Percentage bar */}
                              <div className="h-1 rounded-full bg-muted overflow-hidden">
                                <div
                                  className="h-full rounded-full transition-all duration-300"
                                  style={{
                                    width: `${category.percentage}%`,
                                    backgroundColor: category.color,
                                    opacity: 0.5,
                                  }}
                                />
                              </div>
                            </div>
                          ))}
                      </div>
                    </div>
                  </div>
                )}
              </TabsContent>
              <TabsContent value="trends">
                <div className="flex flex-col gap-6">
                  <div className="w-full md:w-1/3">
                    <Popover open={openGroups} onOpenChange={setOpenGroups}>
                      <PopoverTrigger asChild>
                        <Button
                          variant="outline"
                          role="combobox"
                          aria-expanded={openGroups}
                          className="w-full justify-between"
                        >
                          <span className="truncate">
                            {selectedGroupsForTrend.length > 0
                              ? `${selectedGroupsForTrend.length} ${t('common.select')}`
                              : t("common.select")}
                          </span>
                          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                        </Button>
                      </PopoverTrigger>
                      <PopoverContent className="w-[--radix-popover-trigger-width] p-0">
                        <Command>
                          <CommandInput placeholder={t("common.search")} />
                          <CommandEmpty>{t("notifications.info.noResults")}</CommandEmpty>
                          <CommandList>
                            <CommandGroup>
                              {pieData.map((group) => (
                                <CommandItem
                                  key={group.name}
                                  value={group.name}
                                  onSelect={() => {
                                    const newSelection = selectedGroupsForTrend.includes(group.name)
                                      ? selectedGroupsForTrend.filter((g) => g !== group.name)
                                      : [...selectedGroupsForTrend, group.name];
                                    setSelectedGroupsForTrend(newSelection);
                                  }}
                                >
                                  <Check
                                    className={cn(
                                      "mr-2 h-4 w-4",
                                      selectedGroupsForTrend.includes(group.name) ? "opacity-100" : "opacity-0"
                                    )}
                                  />
                                  {translateCategoryGroup(t, group.name)}
                                </CommandItem>
                              ))}
                            </CommandGroup>
                          </CommandList>
                        </Command>
                      </PopoverContent>
                    </Popover>
                  </div>
                  {trendChartData.length > 0 ? (
                    <div className="h-[400px] w-full">
                      <ResponsiveContainer width="100%" height="100%">
                        <LineChart
                          data={trendChartData}
                          margin={{ top: 20, right: 30, left: 20, bottom: 5 }}
                        >
                          <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                          <XAxis dataKey="name" />
                          <YAxis />
                          <Tooltip
                            formatter={(value: number) => formatCurrency(value, selectedCurrency)}
                            contentStyle={{
                              backgroundColor: "hsl(var(--popover))",
                              border: "1px solid hsl(var(--border))",
                              borderRadius: "var(--radius)",
                            }}
                          />
                          <RechartsLegend />
                          {selectedGroupsForTrend.map((group, index) => (
                            <Line
                              key={group}
                              type="monotone"
                              dataKey={group}
                              stroke={CHART_COLORS[index % CHART_COLORS.length]}
                              strokeWidth={2}
                            />
                          ))}
                        </LineChart>
                      </ResponsiveContainer>
                    </div>
                  ) : (
                    <div className="text-center p-12 text-muted-foreground">
                      <p>{t("notifications.info.empty")}</p>
                    </div>
                  )}
                </div>
              </TabsContent>
              <TabsContent value="details">
                {activeCategoryGroup && startDate && endDate && selectedCurrency ? (
                  <div className="flex flex-col gap-4">
                    <div className="flex items-center gap-2">
                      <Button variant="outline" size="sm" onClick={() => setActiveCategoryGroup(null)}>
                        <ArrowLeft className="h-4 w-4 mr-2" />
                        {t("common.back")}
                      </Button>
                      <h3 className="text-lg font-semibold">
                        {t("common.for")} {translateCategoryGroup(t, activeCategoryGroup)}
                      </h3>
                    </div>
                    <ExpenseTransactionList
                      dateRange={{ from: startDate, to: endDate }}
                      currency={selectedCurrency}
                      categoryGroup={activeCategoryGroup}
                    />
                  </div>
                ) : (
                  <div className="flex flex-col items-center justify-center py-16 px-4 text-center">
                    <div className="w-12 h-12 rounded-xl bg-muted flex items-center justify-center mb-4">
                      <PieChartIcon className="h-6 w-6 text-muted-foreground" />
                    </div>
                    <h3 className="text-base font-semibold text-foreground mb-1">
                      {t("pages.expenses.breakdown.details.emptyTitle")}
                    </h3>
                    <p className="text-sm text-muted-foreground max-w-sm mb-5">
                      {t("pages.expenses.breakdown.details.emptyDescription")}
                    </p>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setActiveTab('categories')}
                    >
                      {t("pages.expenses.breakdown.details.goToCategories")}
                    </Button>
                  </div>
                )}
              </TabsContent>
            </Tabs>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
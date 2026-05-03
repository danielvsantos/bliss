import { useState, useMemo } from "react";
import { useTranslation } from "react-i18next";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { usePortfolioItems } from "@/hooks/use-portfolio-items";
import type { PortfolioItem } from "@/types/api";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { differenceInDays } from "date-fns";
import { AlertCircle, Pencil, FileText } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ManualPriceForm } from "@/components/entities/manual-price-form";
import { DebtTermsForm } from "@/components/entities/debt-terms-form";
import { parseDecimal, getDisplayData } from "@/lib/portfolio-utils";
import { formatCurrency } from "@/lib/utils";

// ── Sort Chevron ───────────────────────────────────────────────────────────

function SortChevron({ dir }: { dir: "asc" | "desc" | "none" }) {
  return (
    <span className="inline-flex flex-col gap-px ml-1 align-middle" style={{ opacity: dir === "none" ? 0.38 : 1 }}>
      <svg width="8" height="5" viewBox="0 0 8 5" fill="none">
        <path d="M1 4L4 1L7 4" stroke={dir === "asc" ? "hsl(var(--foreground))" : "hsl(var(--muted-fg))"} strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <svg width="8" height="5" viewBox="0 0 8 5" fill="none">
        <path d="M1 1L4 4L7 1" stroke={dir === "desc" ? "hsl(var(--foreground))" : "hsl(var(--muted-fg))"} strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </span>
  );
}

// ── Urgency Logic ──────────────────────────────────────────────────────────

function getUrgency(daysSince: number, t: (key: string) => string) {
  if (daysSince >= 90) {
    return {
      label: t("manualUpdates.urgency.critical"),
      className: "bg-destructive/10 text-destructive border border-destructive/20",
    };
  }
  if (daysSince >= 60) {
    return {
      label: t("manualUpdates.urgency.warning"),
      className: "bg-warning/10 text-warning border border-warning/20",
    };
  }
  return {
    label: t("manualUpdates.urgency.stale"),
    className: "bg-brand-primary/10 text-brand-primary border border-brand-primary/20",
  };
}

// ── Types ──────────────────────────────────────────────────────────────────

type StaleSortKey = "name" | "value" | "days";
type SortDir = "asc" | "desc";

// ── Main Page ──────────────────────────────────────────────────────────────

export default function ManualUpdatesPage() {
  const { t } = useTranslation();
  const { data, isLoading, error, refetch } = usePortfolioItems({ includeManualValues: true });
  const assets = useMemo(() => data?.items ?? [], [data?.items]);
  const portfolioCurrency = data?.portfolioCurrency ?? "USD";

  const [selectedAsset, setSelectedAsset] = useState<PortfolioItem | null>(null);
  const [dialogType, setDialogType] = useState<"price" | "debt" | null>(null);

  // Sort state for stale assets
  const [staleSortKey, setStaleSortKey] = useState<StaleSortKey>("days");
  const [staleSortDir, setStaleSortDir] = useState<SortDir>("desc");

  const { assetsToUpdate, liabilities } = useMemo(() => {
    const toUpdate: (PortfolioItem & { daysSince: number })[] = [];
    const debts: PortfolioItem[] = [];

    assets.forEach((asset) => {
      if (asset.category?.type === "Debt") {
        debts.push(asset);
      }

      const hint = asset.category?.processingHint;
      const isManuallyPriced = hint === "MANUAL";
      const hasPositiveQuantity = parseDecimal(asset.quantity) > 0;

      if (isManuallyPriced && hasPositiveQuantity) {
        const lastManualUpdate = asset.manualValues?.[0];
        const needsInitialPrice = !lastManualUpdate;
        const daysSince = lastManualUpdate
          ? differenceInDays(new Date(), new Date(lastManualUpdate.date))
          : 999;
        const needsPriceRefresh = daysSince > 30;

        if (needsInitialPrice || needsPriceRefresh) {
          toUpdate.push({ ...asset, daysSince });
        }
      }
    });

    return { assetsToUpdate: toUpdate, liabilities: debts };
  }, [assets]);

  // Sorted stale assets
  const sortedStaleAssets = useMemo(() => {
    return [...assetsToUpdate].sort((a, b) => {
      let cmp = 0;
      if (staleSortKey === "name") cmp = a.symbol.localeCompare(b.symbol);
      else if (staleSortKey === "value") {
        cmp = parseDecimal(getDisplayData(a, portfolioCurrency).marketValue) -
              parseDecimal(getDisplayData(b, portfolioCurrency).marketValue);
      } else if (staleSortKey === "days") cmp = a.daysSince - b.daysSince;
      return staleSortDir === "asc" ? cmp : -cmp;
    });
  }, [assetsToUpdate, staleSortKey, staleSortDir, portfolioCurrency]);

  const handleStaleSort = (key: StaleSortKey) => {
    if (staleSortKey === key) {
      setStaleSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setStaleSortKey(key);
      setStaleSortDir("desc");
    }
  };

  const staleDirFor = (key: StaleSortKey): "asc" | "desc" | "none" =>
    staleSortKey === key ? staleSortDir : "none";

  const handleOpenDialog = (asset: PortfolioItem, type: "price" | "debt") => {
    setSelectedAsset(asset);
    setDialogType(type);
  };

  const closeDialog = (refetchNeeded = false) => {
    setDialogType(null);
    setSelectedAsset(null);
    if (refetchNeeded) refetch();
  };

  // ── Loading ──

  if (isLoading) {
    return (
      <div className="p-6 space-y-6">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-4 w-96" />
        <Skeleton className="h-64 w-full rounded-xl" />
        <Skeleton className="h-48 w-full rounded-xl" />
      </div>
    );
  }

  if (error) {
    return (
      <Alert variant="destructive" className="m-6">
        <AlertCircle className="h-4 w-4" />
        <AlertTitle>{t("common.error")}</AlertTitle>
        <AlertDescription>{t("manualUpdates.errorLoading")}</AlertDescription>
      </Alert>
    );
  }

  return (
    <>
      <div className="p-6 space-y-6">
        {/* ── Page Header ── */}
        <div className="flex items-start gap-3">
          <div className="flex items-center justify-center w-10 h-10 rounded-xl bg-negative/10 text-negative shrink-0 mt-0.5">
            <FileText className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">{t("manualUpdates.pageTitle")}</h1>
            <p className="text-sm text-muted-foreground mt-1">
              {t("manualUpdates.pageSubtitle")}
            </p>
          </div>
        </div>

        {/* ── Stale Assets Card ── */}
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center gap-2.5">
              <CardTitle className="text-base">{t("manualUpdates.stalePricesTitle")}</CardTitle>
              {assetsToUpdate.length > 0 && (
                <span className="inline-flex items-center justify-center min-w-[20px] h-5 rounded-full bg-destructive text-destructive-foreground text-[0.625rem] font-bold px-1.5">
                  {assetsToUpdate.length}
                </span>
              )}
            </div>
            <CardDescription>
              {t("manualUpdates.stalePricesDesc")}
            </CardDescription>
          </CardHeader>
          <CardContent className="pt-0">
            {sortedStaleAssets.length > 0 ? (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow className="bg-accent/40">
                      <TableHead
                        className="cursor-pointer select-none"
                        onClick={() => handleStaleSort("name")}
                      >
                        <span className="inline-flex items-center">
                          {t("manualUpdates.asset")}
                          <SortChevron dir={staleDirFor("name")} />
                        </span>
                      </TableHead>
                      <TableHead
                        className="text-right cursor-pointer select-none"
                        onClick={() => handleStaleSort("value")}
                      >
                        <span className="inline-flex items-center">
                          {t("manualUpdates.value")}
                          <SortChevron dir={staleDirFor("value")} />
                        </span>
                      </TableHead>
                      <TableHead
                        className="text-center cursor-pointer select-none hidden sm:table-cell"
                        onClick={() => handleStaleSort("days")}
                      >
                        <span className="inline-flex items-center">
                          {t("manualUpdates.status")}
                          <SortChevron dir={staleDirFor("days")} />
                        </span>
                      </TableHead>
                      <TableHead className="text-right">{t("manualUpdates.action")}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {sortedStaleAssets.map((asset) => {
                      const urgency = getUrgency(asset.daysSince, t);
                      const marketValue = parseDecimal(getDisplayData(asset, portfolioCurrency).marketValue);
                      const lastManualUpdate = asset.manualValues?.[0]?.date;
                      const lastUpdateStr = lastManualUpdate
                        ? new Date(lastManualUpdate).toLocaleDateString()
                        : t("manualUpdates.never");

                      return (
                        <TableRow key={asset.id} className="hover:bg-accent/30">
                          {/* Asset info */}
                          <TableCell>
                            <div className="font-medium">{asset.symbol}</div>
                            <div className="flex items-center gap-1.5 mt-0.5 text-xs text-muted-foreground">
                              <span>{asset.category?.name}</span>
                              <span className="text-border-color">·</span>
                              <span>{t("manualUpdates.updatedOn", { date: lastUpdateStr })}</span>
                            </div>
                          </TableCell>

                          {/* Value */}
                          <TableCell className="text-right font-semibold tabular-nums">
                            {formatCurrency(marketValue, portfolioCurrency)}
                          </TableCell>

                          {/* Status badge */}
                          <TableCell className="text-center hidden sm:table-cell">
                            <Badge className={`${urgency.className} text-[0.6875rem] font-semibold`}>
                              {t("manualUpdates.dOld", { count: asset.daysSince })} · {urgency.label}
                            </Badge>
                          </TableCell>

                          {/* Action */}
                          <TableCell className="text-right">
                            <Button
                              size="sm"
                              className="h-8 gap-1.5 text-xs"
                              onClick={() => handleOpenDialog(asset, "price")}
                            >
                              <Pencil className="h-3.5 w-3.5" />
                              <span className="hidden sm:inline">{t("manualUpdates.updatePrice")}</span>
                            </Button>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground py-6 text-center">
                {t("manualUpdates.allUpToDate")}
              </p>
            )}
          </CardContent>
        </Card>

        {/* ── Liability Terms Card ── */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">{t("manualUpdates.liabilityTerms")}</CardTitle>
            <CardDescription>
              {t("manualUpdates.liabilityTermsDesc")}
            </CardDescription>
          </CardHeader>
          <CardContent className="pt-0">
            {liabilities.length > 0 ? (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow className="bg-accent/40">
                      <TableHead>{t("manualUpdates.debtName")}</TableHead>
                      <TableHead className="text-right">{t("manualUpdates.principalBalance")}</TableHead>
                      <TableHead className="text-right hidden sm:table-cell">{t("manualUpdates.interestRate")}</TableHead>
                      <TableHead className="hidden sm:table-cell">{t("manualUpdates.duration")}</TableHead>
                      <TableHead className="text-right">{t("common.actions")}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {liabilities.map((asset, idx) => {
                      const marketValue = Math.abs(parseDecimal(getDisplayData(asset, portfolioCurrency).marketValue));
                      const termMonths = asset.debtTerms?.termInMonths;
                      let durationStr = "—";
                      if (termMonths) {
                        const years = Math.floor(termMonths / 12);
                        const months = termMonths % 12;
                        durationStr = years > 0
                          ? `${years} ${t("manualUpdates.yr")}${months > 0 ? ` ${months} ${t("manualUpdates.mo")}` : ""}`
                          : `${months} ${t("manualUpdates.mo")}`;
                      }

                      return (
                        <TableRow
                          key={asset.id}
                          className={`hover:bg-accent/30 ${idx % 2 === 1 ? "bg-accent/20" : ""}`}
                        >
                          <TableCell className="font-medium">{asset.symbol}</TableCell>
                          <TableCell className="text-right font-semibold tabular-nums">
                            {formatCurrency(marketValue, portfolioCurrency)}
                          </TableCell>
                          <TableCell className="text-right tabular-nums text-muted-foreground hidden sm:table-cell">
                            {asset.debtTerms?.interestRate != null
                              ? `${asset.debtTerms.interestRate}%`
                              : <span className="text-muted-foreground">—</span>}
                          </TableCell>
                          <TableCell className="text-muted-foreground text-sm hidden sm:table-cell">
                            {durationStr}
                          </TableCell>
                          <TableCell className="text-right">
                            <Button
                              variant="outline"
                              size="sm"
                              className="h-8 gap-1.5 text-xs"
                              onClick={() => handleOpenDialog(asset, "debt")}
                            >
                              <Pencil className="h-3.5 w-3.5" />
                              <span className="hidden sm:inline">{asset.debtTerms ? t("manualUpdates.editTerms") : t("manualUpdates.addTerms")}</span>
                            </Button>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                  {liabilities.length > 1 && (
                    <tfoot>
                      <tr className="border-t">
                        <td className="px-4 py-3 text-xs font-semibold uppercase text-muted-foreground tracking-wider">
                          {t("manualUpdates.totalOutstanding")}
                        </td>
                        <td className="px-4 py-3 text-right font-bold tabular-nums text-negative">
                          {formatCurrency(
                            liabilities.reduce(
                              (sum, a) => sum + Math.abs(parseDecimal(getDisplayData(a, portfolioCurrency).marketValue)),
                              0
                            ),
                            portfolioCurrency
                          )}
                        </td>
                        <td className="hidden sm:table-cell" />
                        <td className="hidden sm:table-cell" />
                        <td />
                      </tr>
                    </tfoot>
                  )}
                </Table>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground py-6 text-center">
                {t("manualUpdates.noLiabilities")}
              </p>
            )}
          </CardContent>
        </Card>
      </div>

      {/* ── Dialog for Forms ── */}
      <Dialog open={dialogType !== null} onOpenChange={(isOpen) => !isOpen && closeDialog()}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {dialogType === "price" && `${t("manualUpdates.updatePriceDialog")} — ${selectedAsset?.symbol}`}
              {dialogType === "debt" && `${t("manualUpdates.debtTermsDialog")} — ${selectedAsset?.symbol}`}
            </DialogTitle>
          </DialogHeader>
          {dialogType === "price" && <ManualPriceForm asset={selectedAsset} onClose={closeDialog} />}
          {dialogType === "debt" && <DebtTermsForm asset={selectedAsset} onClose={closeDialog} />}
        </DialogContent>
      </Dialog>
    </>
  );
}

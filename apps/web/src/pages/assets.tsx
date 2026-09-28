import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { AlertCircle, Boxes, Search } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";

import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { MobileFilterDrawer } from "@/components/ui/mobile-filter-drawer";
import { IncomeTermsModal } from "@/components/income/income-terms-modal";
import { ManualValueModal } from "@/components/entities/manual-value-modal";
import { ManualPriceHistoryDialog } from "@/components/entities/manual-price-history-dialog";
import { DebtTermsModal } from "@/components/entities/debt-terms-modal";
import { AssetClassModal } from "@/components/entities/asset-class-modal";
import { DetachedTermsBanner } from "@/components/manage-assets/detached-terms-banner";
import { AssetStatusChips } from "@/components/manage-assets/asset-status-chips";
import { AssetActionsMenu } from "@/components/manage-assets/asset-actions-menu";
import { useIsMobile } from "@/hooks/use-mobile";
import { MANAGE_ASSETS_QUERY_KEY, useManageAssets, useManagedAsset } from "@/hooks/use-manage-assets";
import { isAssetModal } from "@/lib/manage-assets";
import { formatCurrency } from "@/lib/utils";
import { ASSET_CLASSES, type AssetClass } from "@/types/equity-analysis";
import {
  ASSET_STATUS_FILTERS,
  type AssetModal,
  type AssetStatusFilter,
  type ManageAssetsResponse,
  type ManagedAsset,
} from "@/types/manage-assets";

const ALL = "all";
const SEARCH_DEBOUNCE_MS = 300;

// ── Row pieces ─────────────────────────────────────────────────────────────

function AssetValue({ asset, currency, locale }: { asset: ManagedAsset; currency: string; locale: string }) {
  if (asset.currentValueInDisplay == null) return <span className="text-muted-foreground">—</span>;
  const negative = asset.currentValueInDisplay < 0;
  return (
    <span className={`font-semibold tabular-nums ${negative ? "text-negative" : ""}`}>
      {formatCurrency(asset.currentValueInDisplay, currency, locale)}
    </span>
  );
}

function AssetMeta({ asset }: { asset: ManagedAsset }) {
  return (
    <div className="flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground min-w-0">
      {asset.displayName !== asset.symbol && <span className="truncate">{asset.displayName}</span>}
      {asset.displayName !== asset.symbol && <span className="text-border-color">·</span>}
      <span>{asset.categoryName}</span>
      {asset.accountName && (
        <>
          <span className="text-border-color">·</span>
          <span className="truncate">{asset.accountName}</span>
        </>
      )}
    </div>
  );
}

function AssetClassBadge({ asset }: { asset: ManagedAsset }) {
  const { t } = useTranslation();
  if (asset.categoryType === "Debt") return null;
  return (
    <Badge className="bg-brand-primary/10 text-brand-primary border border-brand-primary/20 text-[0.6875rem] font-medium whitespace-nowrap">
      {t(`equityAnalysis.assetClasses.${asset.assetClass}`)}
    </Badge>
  );
}

// ── Main Page ──────────────────────────────────────────────────────────────

/**
 * Manage Assets (#81) — every portfolio item in one server-filtered,
 * paginated list, with separate modals for income terms, manual price
 * (+ history), debt terms and asset class. Modals are driven by
 * `?item=<id>&modal=<name>` so other pages can deep-link into them.
 */
export default function ManageAssetsPage() {
  const { t, i18n } = useTranslation();
  const locale = i18n.language || "en-US";
  const isMobile = useIsMobile();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();

  // ── Filters ──
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [type, setType] = useState<string>(ALL);
  const [accountId, setAccountId] = useState<string>(ALL);
  const [assetClass, setAssetClass] = useState<string>(ALL);
  const [status, setStatus] = useState<AssetStatusFilter | null>(null);
  const [includeClosed, setIncludeClosed] = useState(false);

  useEffect(() => {
    const id = setTimeout(() => setSearch(searchInput), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [searchInput]);

  const filters = useMemo(
    () => ({
      search,
      type: type === ALL ? undefined : type,
      accountId: accountId === ALL ? undefined : Number(accountId),
      assetClass: assetClass === ALL ? undefined : (assetClass as AssetClass),
      status: status ?? undefined,
      includeClosed,
    }),
    [search, type, accountId, assetClass, status, includeClosed],
  );

  const { data, isLoading, isError, fetchNextPage, hasNextPage, isFetchingNextPage } = useManageAssets(filters);
  const pages = data?.pages;
  const rows = useMemo(() => pages?.flatMap((p) => p.items) ?? [], [pages]);
  const firstPage = pages?.[0];
  const portfolioCurrency = firstPage?.portfolioCurrency ?? "USD";
  const total = firstPage?.totals.count ?? 0;

  // Keep the last filter options while a new filter combination loads.
  const [facets, setFacets] = useState<ManageAssetsResponse["facets"]>();
  useEffect(() => {
    if (firstPage?.facets) setFacets(firstPage.facets);
  }, [firstPage?.facets]);

  const activeFilterCount =
    (type !== ALL ? 1 : 0) + (accountId !== ALL ? 1 : 0) + (assetClass !== ALL ? 1 : 0) + (includeClosed ? 1 : 0);

  const clearFilters = () => {
    setSearchInput("");
    setSearch("");
    setType(ALL);
    setAccountId(ALL);
    setAssetClass(ALL);
    setStatus(null);
    setIncludeClosed(false);
  };

  // ── Modals (URL-driven) ──
  const itemParam = searchParams.get("item");
  const modalParam = searchParams.get("modal");
  const itemId = itemParam && /^\d+$/.test(itemParam) ? Number(itemParam) : null;
  const modal: AssetModal | null = isAssetModal(modalParam) ? modalParam : null;
  const { asset: modalAsset } = useManagedAsset(modal ? itemId : null, rows);

  const openModal = (asset: ManagedAsset, m: AssetModal) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set("item", String(asset.id));
      next.set("modal", m);
      return next;
    });
  };

  const closeModal = () => {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete("item");
        next.delete("modal");
        return next;
      },
      { replace: true },
    );
    queryClient.invalidateQueries({ queryKey: [MANAGE_ASSETS_QUERY_KEY] });
  };

  const modalProps = (m: AssetModal) => ({
    open: modal === m && modalAsset != null,
    onOpenChange: (isOpen: boolean) => {
      if (!isOpen) closeModal();
    },
  });

  // ── Filter controls ──
  const filterControls = (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 lg:items-end">
      <div className="space-y-1.5 min-w-0">
        <Label htmlFor="filter-type" className="text-xs text-muted-foreground">{t("manageAssets.filters.type")}</Label>
        <Select value={type} onValueChange={setType}>
          <SelectTrigger id="filter-type" aria-label={t("manageAssets.filters.type")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>{t("manageAssets.filters.allTypes")}</SelectItem>
            {facets?.groups.map((g) => (
              <SelectItem key={g.group} value={g.group}>{`${g.group} (${g.count})`}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-1.5 min-w-0">
        <Label htmlFor="filter-account" className="text-xs text-muted-foreground">{t("manageAssets.filters.account")}</Label>
        <Select value={accountId} onValueChange={setAccountId}>
          <SelectTrigger id="filter-account" aria-label={t("manageAssets.filters.account")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>{t("manageAssets.filters.allAccounts")}</SelectItem>
            {facets?.accounts.map((a) => (
              <SelectItem key={a.id} value={String(a.id)}>{a.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-1.5 min-w-0">
        <Label htmlFor="filter-asset-class" className="text-xs text-muted-foreground">{t("manageAssets.filters.assetClass")}</Label>
        <Select value={assetClass} onValueChange={setAssetClass}>
          <SelectTrigger id="filter-asset-class" aria-label={t("manageAssets.filters.assetClass")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>{t("manageAssets.filters.allAssetClasses")}</SelectItem>
            {ASSET_CLASSES.map((c) => (
              <SelectItem key={c} value={c}>{t(`equityAnalysis.assetClasses.${c}`)}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="flex items-center gap-2 h-10">
        <Switch id="include-closed" checked={includeClosed} onCheckedChange={setIncludeClosed} />
        <Label htmlFor="include-closed" className="text-sm">{t("manageAssets.filters.includeClosed")}</Label>
      </div>
    </div>
  );

  const statusChips = (
    <div className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1" role="group" aria-label={t("manageAssets.status.label")}>
      {ASSET_STATUS_FILTERS.map((s) => {
        const active = status === s;
        return (
          <button
            key={s}
            type="button"
            aria-pressed={active}
            onClick={() => setStatus(active ? null : s)}
            className={`shrink-0 rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
              active
                ? "border-brand-primary bg-brand-primary text-white"
                : "border-gray-200 bg-white text-brand-deep hover:bg-accent/40 dark:bg-transparent"
            }`}
            data-testid={`status-filter-${s}`}
          >
            {t(`manageAssets.status.${s}`)}
          </button>
        );
      })}
    </div>
  );

  // ── List ──
  let list: JSX.Element;
  if (isLoading) {
    list = (
      <div className="space-y-2" data-testid="assets-loading">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-14 w-full rounded-lg" />
        ))}
      </div>
    );
  } else if (isError) {
    list = (
      <Alert variant="destructive">
        <AlertCircle className="h-4 w-4" />
        <AlertTitle>{t("common.error")}</AlertTitle>
        <AlertDescription>{t("manageAssets.loadFailed")}</AlertDescription>
      </Alert>
    );
  } else if (rows.length === 0) {
    list = (
      <div className="py-10 text-center space-y-3">
        <p className="text-sm text-muted-foreground">{t("manageAssets.empty")}</p>
        {(activeFilterCount > 0 || status || search) && (
          <Button variant="outline" size="sm" onClick={clearFilters}>{t("manageAssets.filters.clear")}</Button>
        )}
      </div>
    );
  } else if (isMobile) {
    list = (
      <ul className="space-y-2" data-testid="assets-cards">
        {rows.map((asset) => (
          <li key={asset.id} className="rounded-lg border border-gray-200 p-3 space-y-2" data-testid={`asset-card-${asset.id}`}>
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0 flex-1">
                <p className="font-medium text-brand-deep break-words">{asset.symbol}</p>
                <AssetMeta asset={asset} />
              </div>
              <div className="flex items-center gap-1 shrink-0">
                <AssetValue asset={asset} currency={portfolioCurrency} locale={locale} />
                <AssetActionsMenu asset={asset} onOpen={(m) => openModal(asset, m)} />
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-1">
              <AssetClassBadge asset={asset} />
              <AssetStatusChips asset={asset} />
            </div>
          </li>
        ))}
      </ul>
    );
  } else {
    list = (
      <div className="overflow-x-auto">
        <Table data-testid="assets-table">
          <TableHeader>
            <TableRow className="bg-accent/40">
              <TableHead>{t("manualUpdates.asset")}</TableHead>
              <TableHead>{t("manageAssets.columns.assetClass")}</TableHead>
              <TableHead>{t("manualUpdates.status")}</TableHead>
              <TableHead className="text-right">{t("manualUpdates.value")}</TableHead>
              <TableHead className="w-12 text-right"><span className="sr-only">{t("common.actions")}</span></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((asset) => (
              <TableRow key={asset.id} className="hover:bg-accent/30" data-testid={`asset-row-${asset.id}`}>
                <TableCell className="max-w-[18rem]">
                  <div className="font-medium">{asset.symbol}</div>
                  <AssetMeta asset={asset} />
                </TableCell>
                <TableCell><AssetClassBadge asset={asset} /></TableCell>
                <TableCell><AssetStatusChips asset={asset} /></TableCell>
                <TableCell className="text-right">
                  <AssetValue asset={asset} currency={portfolioCurrency} locale={locale} />
                </TableCell>
                <TableCell className="text-right">
                  <AssetActionsMenu asset={asset} onOpen={(m) => openModal(asset, m)} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    );
  }

  const assetRef = modalAsset ? { id: modalAsset.id, symbol: modalAsset.symbol, currency: modalAsset.currency } : null;

  return (
    <>
      <div className="p-4 sm:p-6 space-y-4 sm:space-y-6 max-w-full overflow-x-hidden">
        {/* ── Page Header ── */}
        <div className="flex items-start gap-3">
          <div className="flex items-center justify-center w-10 h-10 rounded-xl bg-brand-primary/10 text-brand-primary shrink-0 mt-0.5">
            <Boxes className="h-5 w-5" />
          </div>
          <div className="min-w-0">
            <h1 className="text-2xl font-semibold tracking-tight">{t("manageAssets.title")}</h1>
            <p className="text-sm text-muted-foreground mt-1">{t("manageAssets.subtitle")}</p>
          </div>
        </div>

        <DetachedTermsBanner count={firstPage?.detachedTermsCount ?? 0} />

        <Card>
          <CardContent className="p-4 sm:p-6 space-y-4">
            <div className="flex flex-col gap-3">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
                <Input
                  type="search"
                  value={searchInput}
                  onChange={(e) => setSearchInput(e.target.value)}
                  placeholder={t("manageAssets.searchPlaceholder")}
                  aria-label={t("manageAssets.searchPlaceholder")}
                  className="pl-9"
                />
              </div>
              <MobileFilterDrawer activeFilterCount={activeFilterCount}>{filterControls}</MobileFilterDrawer>
              {statusChips}
            </div>

            {!isLoading && !isError && (
              <p className="text-xs text-muted-foreground" data-testid="assets-count">
                {t("manageAssets.count", { count: total })}
              </p>
            )}

            {list}

            {hasNextPage && (
              <div className="flex justify-center pt-2">
                <Button variant="outline" onClick={() => fetchNextPage()} disabled={isFetchingNextPage}>
                  {isFetchingNextPage ? t("manageAssets.loadingMore") : t("manageAssets.loadMore")}
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* ── Modals: each loads its own data ── */}
      <IncomeTermsModal
        {...modalProps("income")}
        mode="asset"
        assetId={modal === "income" ? modalAsset?.id ?? null : null}
        assetLabel={modalAsset?.symbol}
        currentValue={modalAsset?.currentValue != null ? Number(modalAsset.currentValue) : undefined}
        // #83: pre-ticks "apply to all holdings" when the symbol is held in more
        // than one account (the modal checks the server-side siblings; cash excluded).
        defaultApplyToSymbol
      />
      <ManualValueModal asset={assetRef} {...modalProps("price")} />
      <ManualPriceHistoryDialog asset={modal === "history" ? assetRef : null} {...modalProps("history")} />
      <DebtTermsModal asset={assetRef} {...modalProps("debt")} />
      <AssetClassModal asset={assetRef} {...modalProps("assetClass")} />
    </>
  );
}

import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronsUpDown, Check, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { cn, formatCurrency } from "@/lib/utils";
import { translateCategoryGroup } from "@/lib/category-i18n";
import { filterHoldingOptions, type HoldingOption } from "@/lib/portfolio-holding";

// Below Tailwind's `sm` breakpoint the picker opens as a full-width bottom sheet.
const SMALL_SCREEN_QUERY = "(max-width: 639px)";

function useIsSmallScreen() {
  const get = () => typeof window !== "undefined" && typeof window.matchMedia === "function"
    && window.matchMedia(SMALL_SCREEN_QUERY).matches;
  const [small, setSmall] = useState(get);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const mql = window.matchMedia(SMALL_SCREEN_QUERY);
    const onChange = () => setSmall(mql.matches);
    mql.addEventListener?.("change", onChange);
    return () => mql.removeEventListener?.("change", onChange);
  }, []);
  return small;
}

export interface HoldingPickerProps {
  /** Every selectable holding, closed ones included (the picker hides them by default). */
  options: HoldingOption[];
  /** The current selection (may be closed — shown even while the toggle is off). */
  selected: HoldingOption | null;
  currency: string;
  onSelect: (key: string) => void;
  onClear: () => void;
}

/**
 * Searchable holding picker for the Portfolio performance chart (#131).
 * Our own filter (`filterHoldingOptions`) runs instead of cmdk's scoring so the
 * same logic applies on both layouts and stays cheap with ~1,000 options;
 * cmdk still provides ↑/↓/Enter/Esc and the listbox semantics.
 */
export function HoldingPicker({ options, selected, currency, onSelect, onClear }: HoldingPickerProps) {
  const { t } = useTranslation();
  const isSmall = useIsSmallScreen();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  // Not persisted: off on every page load (PRD req. 3).
  const [showClosed, setShowClosed] = useState(false);

  const filtered = useMemo(
    () => filterHoldingOptions(options, query, {
      includeClosed: showClosed,
      translateName: (o) => translateCategoryGroup(t, o.group),
    }),
    [options, query, showClosed, t],
  );

  const { openGroups, closed } = useMemo(() => {
    const groups = new Map<string, HoldingOption[]>();
    const closedOptions: HoldingOption[] = [];
    for (const o of filtered) {
      if (o.isClosed) { closedOptions.push(o); continue; }
      const list = groups.get(o.group);
      if (list) list.push(o);
      else groups.set(o.group, [o]);
    }
    return { openGroups: Array.from(groups.entries()), closed: closedOptions };
  }, [filtered]);

  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (!next) setQuery("");
  };

  const choose = (key: string) => {
    onSelect(key);
    handleOpenChange(false);
  };

  const renderItem = (o: HoldingOption) => (
    <CommandItem
      key={o.key}
      value={o.key}
      onSelect={() => choose(o.key)}
      className="flex items-center gap-2"
      data-testid={`holding-option-${o.key}`}
    >
      <Check className={cn("h-3.5 w-3.5 shrink-0", selected?.key === o.key ? "opacity-100" : "opacity-0")} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate font-medium">{o.symbol}</span>
          {o.isClosed && (
            <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
              {t("portfolio.closedBadge")}
            </span>
          )}
        </div>
        <div className="truncate text-xs text-muted-foreground">{o.name}</div>
      </div>
      <span className={cn("shrink-0 text-xs tabular-nums", o.isDebt ? "text-negative" : "text-muted-foreground")}>
        {formatCurrency(o.value, currency)}
      </span>
    </CommandItem>
  );

  const list = (
    <Command shouldFilter={false} className="rounded-lg">
      <CommandInput
        value={query}
        onValueChange={setQuery}
        placeholder={t("portfolio.searchHoldings")}
        aria-label={t("portfolio.searchHoldings")}
      />
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <Switch
          id="holding-picker-show-closed"
          checked={showClosed}
          onCheckedChange={setShowClosed}
        />
        <Label htmlFor="holding-picker-show-closed" className="text-xs text-muted-foreground">
          {t("portfolio.showClosedPositionsToggle")}
        </Label>
      </div>
      <CommandList
        className={isSmall ? "max-h-[60vh]" : "max-h-[320px]"}
        onWheel={(e) => e.nativeEvent.stopImmediatePropagation()}
      >
        <CommandEmpty>{t("portfolio.noHoldingsFound")}</CommandEmpty>
        {openGroups.map(([group, groupOptions]) => (
          <CommandGroup key={group} heading={translateCategoryGroup(t, group)}>
            {groupOptions.map(renderItem)}
          </CommandGroup>
        ))}
        {closed.length > 0 && (
          <CommandGroup heading={t("portfolio.closedPositionsGroup")}>
            {closed.map(renderItem)}
          </CommandGroup>
        )}
      </CommandList>
    </Command>
  );

  const trigger = (
    <Button
      variant="outline"
      role="combobox"
      aria-expanded={open}
      aria-label={t("portfolio.holdingPickerLabel")}
      className="h-7 w-full sm:w-44 justify-between px-2 text-xs font-normal"
      onClick={isSmall ? () => handleOpenChange(true) : undefined}
      data-testid="holding-picker-trigger"
    >
      <span className={cn("truncate", !selected && "text-muted-foreground")}>
        {selected ? selected.symbol : t("portfolio.allHoldings")}
      </span>
      <ChevronsUpDown className="ml-1 h-3.5 w-3.5 shrink-0 opacity-50" />
    </Button>
  );

  return (
    <div className="flex w-full items-center gap-1 sm:w-auto">
      {isSmall ? (
        <>
          {trigger}
          <Sheet open={open} onOpenChange={handleOpenChange}>
            <SheetContent side="bottom" className="w-full p-0 pt-10">
              <SheetHeader className="sr-only">
                <SheetTitle>{t("portfolio.holdingPickerLabel")}</SheetTitle>
              </SheetHeader>
              {list}
            </SheetContent>
          </Sheet>
        </>
      ) : (
        <Popover open={open} onOpenChange={handleOpenChange}>
          <PopoverTrigger asChild>{trigger}</PopoverTrigger>
          <PopoverContent className="w-80 p-0" align="start">
            {list}
          </PopoverContent>
        </Popover>
      )}
      {selected && (
        <Button
          variant="ghost"
          size="sm"
          className="h-7 w-7 shrink-0 p-0 text-muted-foreground hover:text-brand-deep"
          aria-label={t("portfolio.clearHolding")}
          title={t("portfolio.clearHolding")}
          onClick={onClear}
          data-testid="holding-picker-clear"
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      )}
    </div>
  );
}

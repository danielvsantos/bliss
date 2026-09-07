import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { Building2, Loader2, Plus, Trash2, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/use-auth";
import { useBanks, useMetadata } from "@/hooks/use-metadata";
import { getTenantMeta, updateTenantMetaFromAPI } from "@/utils/tenantMetaStorage";
import api from "@/lib/api";

const MAX_BANKS = 5;
const MAX_ACCOUNTS_PER_BANK = 3;

interface AccountRow {
  id: string;
  currencyCode: string;
  countryCode: string;
}

interface SelectedBank {
  /** Stable client key — bank id for known banks, "custom:<name>" for typed ones. */
  key: string;
  name: string;
  accounts: AccountRow[];
}

interface OnboardingAccountSetupProps {
  /** Currency codes the user picked in onboarding step 1. */
  selectedCurrencies: string[];
  /** Tenant primary country — the default for every scaffolded account, and the
   *  only country used when the user picked a single country in step 1. */
  countryId: string;
  /** Called once bank/account scaffolding succeeds (or is skipped entirely). */
  onComplete: () => void;
}

/** bank name → obviously-fake, validation-passing account-number slug. */
function slugifyBankName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
  return slug.length >= 2 ? slug : "bank";
}

let rowSeq = 0;
const nextRowId = () => `row-${Date.now()}-${rowSeq++}`;

interface RowDefaults {
  currencyCode: string;
  countryCode: string;
}
const newRow = (d: RowDefaults): AccountRow => ({ id: nextRowId(), ...d });

export function OnboardingAccountSetup({
  selectedCurrencies,
  countryId,
  onComplete,
}: OnboardingAccountSetupProps) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const { data: allBanks = [] } = useBanks();
  const { data: metadata } = useMetadata();

  const [selectedBanks, setSelectedBanks] = useState<SelectedBank[]>([]);
  const [newBankName, setNewBankName] = useState("");
  const [showNewBankInput, setShowNewBankInput] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Currency options for the per-account picker. Prefer step-1 selection; fall
  // back to the tenant's currencies (e.g. when the user navigated back and the
  // onboarding context lost its selection).
  const currencyOptions = useMemo(() => {
    const codes =
      selectedCurrencies.length > 0
        ? selectedCurrencies
        : (getTenantMeta()?.currencies || []).map((c) => c.id);
    const nameByCode = new Map(
      (metadata?.currencies || []).map((c) => [c.id, c.name]),
    );
    return codes.map((code) => ({ code, label: nameByCode.get(code) || code }));
  }, [selectedCurrencies, metadata]);

  const defaultCurrency = currencyOptions[0]?.code ?? "";

  // Country options = the countries the user picked in step 1 (persisted on the
  // tenant). A per-account country selector is only shown when there's more than
  // one — single-country users just see a read-only line.
  const countryOptions = useMemo(() => {
    const picked = getTenantMeta()?.countries || [];
    const nameById = new Map((metadata?.countries || []).map((c) => [c.id, c.name]));
    return picked.map((c) => ({ code: c.id, label: nameById.get(c.id) || c.name || c.id }));
  }, [metadata]);

  const defaultCountry = countryId || countryOptions[0]?.code || "";
  const multiCountry = countryOptions.length > 1;
  const countryLabel =
    countryOptions.find((c) => c.code === defaultCountry)?.label ||
    (metadata?.countries || []).find((c) => c.id === defaultCountry)?.name ||
    defaultCountry;

  const rowDefaults: RowDefaults = { currencyCode: defaultCurrency, countryCode: defaultCountry };

  const isBankSelected = (key: string) => selectedBanks.some((b) => b.key === key);

  const toggleBank = (key: string, name: string) => {
    setSelectedBanks((prev) => {
      const existing = prev.find((b) => b.key === key);
      if (existing) return prev.filter((b) => b.key !== key);
      if (prev.length >= MAX_BANKS) return prev;
      return [...prev, { key, name, accounts: [newRow(rowDefaults)] }];
    });
  };

  const addCustomBank = () => {
    const name = newBankName.trim();
    if (name.length < 2) return;
    const key = `custom:${name.toLowerCase()}`;
    if (isBankSelected(key) || selectedBanks.length >= MAX_BANKS) return;
    setSelectedBanks((prev) => [...prev, { key, name, accounts: [newRow(rowDefaults)] }]);
    setNewBankName("");
    setShowNewBankInput(false);
  };

  const addAccountRow = (bankKey: string) => {
    setSelectedBanks((prev) =>
      prev.map((b) =>
        b.key === bankKey && b.accounts.length < MAX_ACCOUNTS_PER_BANK
          ? { ...b, accounts: [...b.accounts, newRow(rowDefaults)] }
          : b,
      ),
    );
  };

  const removeAccountRow = (bankKey: string, rowId: string) => {
    setSelectedBanks((prev) =>
      prev
        .map((b) =>
          b.key === bankKey
            ? { ...b, accounts: b.accounts.filter((r) => r.id !== rowId) }
            : b,
        )
        // Removing the last row de-selects the bank entirely.
        .filter((b) => b.accounts.length > 0),
    );
  };

  const setRowField = (
    bankKey: string,
    rowId: string,
    patch: Partial<Pick<AccountRow, "currencyCode" | "countryCode">>,
  ) => {
    setSelectedBanks((prev) =>
      prev.map((b) =>
        b.key === bankKey
          ? {
              ...b,
              accounts: b.accounts.map((r) => (r.id === rowId ? { ...r, ...patch } : r)),
            }
          : b,
      ),
    );
  };

  const totalAccounts = selectedBanks.reduce((n, b) => n + b.accounts.length, 0);

  const handleContinue = async () => {
    if (selectedBanks.length === 0) {
      onComplete();
      return;
    }
    if (!user?.id) {
      toast({
        title: t("Error"),
        description: t("Could not identify your user. Please try again."),
        variant: "destructive",
      });
      return;
    }

    setIsSubmitting(true);
    try {
      for (const selected of selectedBanks) {
        const bank = await api.createBank({ name: selected.name });
        const slug = slugifyBankName(selected.name);
        await Promise.all(
          selected.accounts.map((row, index) =>
            api.createAccount({
              name: selected.name.slice(0, 50),
              accountNumber: `${slug}-acc-${index + 1}`,
              bankId: bank.id,
              currencyCode: row.currencyCode,
              countryId: row.countryCode || defaultCountry,
              ownerIds: [user.id],
            }),
          ),
        );
      }

      const tenantId = user?.tenant?.id || user?.tenantId || getTenantMeta()?.id;
      if (tenantId) await updateTenantMetaFromAPI(tenantId);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["metadata"] }),
        queryClient.invalidateQueries({ queryKey: ["metadata", "accounts"] }),
        queryClient.invalidateQueries({ queryKey: ["banks"] }),
        queryClient.invalidateQueries({ queryKey: ["account-list"] }),
      ]);

      onComplete();
    } catch (error) {
      toast({
        title: t("Error"),
        description:
          (error as Error).message ||
          t("Could not set up your accounts. Please try again."),
        variant: "destructive",
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  const atBankCap = selectedBanks.length >= MAX_BANKS;

  return (
    <div className="space-y-4">
      {/* Bank grid */}
      <div>
        <label className="text-sm font-medium mb-2 block">
          {t("Select your banks")}
        </label>
        <div className="grid grid-cols-3 sm:grid-cols-4 gap-2 max-h-44 overflow-y-auto pr-1">
          {allBanks.map((bank) => {
            const selected = isBankSelected(String(bank.id));
            return (
              <button
                key={bank.id}
                type="button"
                onClick={() => toggleBank(String(bank.id), bank.name)}
                disabled={!selected && atBankCap}
                className={`flex flex-col items-center justify-center p-3 rounded-lg border text-xs transition-all disabled:opacity-40 disabled:cursor-not-allowed ${
                  selected
                    ? "border-brand-primary bg-brand-primary/10 ring-1 ring-brand-primary/30"
                    : "border-border hover:bg-accent"
                }`}
              >
                <Building2 className="h-5 w-5 mb-1 text-muted-foreground" />
                <span className="truncate w-full text-center font-medium">
                  {bank.name}
                </span>
              </button>
            );
          })}
        </div>

        {!showNewBankInput ? (
          <button
            type="button"
            onClick={() => setShowNewBankInput(true)}
            disabled={atBankCap}
            className="mt-2 flex items-center gap-2 text-sm text-brand-primary hover:text-brand-primary/80 transition-colors disabled:opacity-40"
          >
            <Plus className="h-4 w-4" />
            {t("Add a different bank")}
          </button>
        ) : (
          <div className="mt-2 flex gap-2">
            <input
              autoFocus
              value={newBankName}
              onChange={(e) => setNewBankName(e.target.value)}
              placeholder={t("Bank name")}
              className="flex-1 px-3 py-2 rounded-lg border border-border bg-background text-sm focus:outline-none focus:ring-1 focus:ring-brand-primary"
              onKeyDown={(e) => {
                if (e.key === "Enter") addCustomBank();
              }}
            />
            <Button
              type="button"
              size="sm"
              onClick={addCustomBank}
              disabled={newBankName.trim().length < 2}
            >
              {t("Add")}
            </Button>
          </div>
        )}

        {atBankCap && (
          <p className="mt-1.5 text-xs text-muted-foreground">
            {t("You can add up to {{count}} banks here — you can add more later.", {
              count: MAX_BANKS,
            })}
          </p>
        )}
      </div>

      {/* Per-bank account rows */}
      {selectedBanks.length > 0 && (
        <div className="space-y-3">
          {selectedBanks.map((bank) => (
            <div key={bank.key} className="rounded-lg border p-3 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-sm font-semibold">{bank.name}</span>
                <button
                  type="button"
                  onClick={() => toggleBank(bank.key, bank.name)}
                  className="text-muted-foreground hover:text-foreground transition-colors"
                  aria-label={t("Remove bank")}
                >
                  <X className="h-4 w-4" />
                </button>
              </div>

              {bank.accounts.map((row, index) => (
                <div key={row.id} className="flex items-start gap-2">
                  <span className="text-xs text-muted-foreground w-14 shrink-0 pt-2">
                    {t("Account")} {index + 1}
                  </span>
                  {/* Selectors stack on mobile, sit side-by-side from sm: up. */}
                  <div className="flex min-w-0 flex-1 flex-col gap-2 sm:flex-row">
                    <Select
                      value={row.currencyCode}
                      onValueChange={(value) =>
                        setRowField(bank.key, row.id, { currencyCode: value })
                      }
                    >
                      <SelectTrigger className="h-8 w-full min-w-0 sm:flex-1">
                        <SelectValue placeholder={t("Currency")} />
                      </SelectTrigger>
                      <SelectContent>
                        {currencyOptions.map((c) => (
                          <SelectItem key={c.code} value={c.code}>
                            {c.label} ({c.code})
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {multiCountry && (
                      <Select
                        value={row.countryCode}
                        onValueChange={(value) =>
                          setRowField(bank.key, row.id, { countryCode: value })
                        }
                      >
                        <SelectTrigger className="h-8 w-full min-w-0 sm:flex-1">
                          <SelectValue placeholder={t("Country")} />
                        </SelectTrigger>
                        <SelectContent>
                          {countryOptions.map((c) => (
                            <SelectItem key={c.code} value={c.code}>
                              {c.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                  </div>
                  {bank.accounts.length > 1 && (
                    <button
                      type="button"
                      onClick={() => removeAccountRow(bank.key, row.id)}
                      className="shrink-0 pt-2 text-muted-foreground hover:text-destructive transition-colors"
                      aria-label={t("Remove account")}
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  )}
                </div>
              ))}

              {bank.accounts.length < MAX_ACCOUNTS_PER_BANK && (
                <button
                  type="button"
                  onClick={() => addAccountRow(bank.key)}
                  className="flex items-center gap-1.5 text-xs text-brand-primary hover:text-brand-primary/80 transition-colors"
                >
                  <Plus className="h-3.5 w-3.5" />
                  {t("Add account")}
                </button>
              )}
            </div>
          ))}

          <p className="text-xs text-muted-foreground">
            {multiCountry
              ? t("Pick the country for each account — it defaults to {{country}}.", {
                  country: countryLabel,
                })
              : t("Accounts will be created in {{country}}.", { country: countryLabel })}
          </p>
        </div>
      )}

      <div className="flex justify-end pt-2">
        <Button onClick={handleContinue} disabled={isSubmitting} className="gap-2">
          {isSubmitting ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : selectedBanks.length === 0 ? (
            t("Skip for now")
          ) : totalAccounts === 1 ? (
            t("Create 1 account")
          ) : (
            t("Create {{count}} accounts", { count: totalAccounts })
          )}
        </Button>
      </div>
    </div>
  );
}

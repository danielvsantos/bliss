import { useState, useEffect, useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate } from "react-router-dom";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/use-auth";
import { useMetadata } from "@/hooks/use-metadata";
import {
  getTenantMeta,
  setTenantMeta,
  updateTenantMetaFromAPI,
  pickTenantMetaFields,
} from "@/utils/tenantMetaStorage";
import api from "@/lib/api";
import type { TenantUpdateRequest, Country, Currency, Bank } from "@/types/api";

import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Slider } from "@/components/ui/slider";
import { Skeleton } from "@/components/ui/skeleton";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import {
  Save,
  Loader2,
  Link as LinkIcon,
  AlertTriangle,
  Sparkles,
  Trash2,
  Settings as SettingsIcon,
  Globe,
  Building,
  Users,
  ExternalLink,
  Plus,
  Lock,
  Wrench,
} from "lucide-react";
import { useTenantSettings, useUpdateTenantSettings } from "@/hooks/use-tenant-settings";

import { SectionLabel } from "@/components/ui/section-label";
import { CardDivider } from "@/components/ui/card-divider";
import { SettingsSelect } from "@/components/settings/settings-select";
import { MaintenanceTab } from "@/components/settings/maintenance-tab";
import {
  MultiSelectCombobox,
  type ComboboxOption,
} from "@/components/settings/multi-select-combobox";
import { SaveConfirmation } from "@/components/settings/save-confirmation";
import { ChangePasswordDialog } from "@/components/settings/change-password-dialog";

/* ─── Types ─────────────────────────────────────────── */

interface TenantSettingsData {
  name: string;
  plan: string;
  countries: string[];
  currencies: string[];
  bankIds: number[];
  plaidLinkedBankIds?: number[];
}

/* ─── Save Hook Helper ──────────────────────────────── */

function useSaveConfirmation() {
  const [saved, setSaved] = useState(false);
  const [triggerCount, setTriggerCount] = useState(0);

  const trigger = useCallback(() => {
    setTriggerCount((c) => c + 1);
    setSaved(true);
  }, []);

  useEffect(() => {
    if (!saved) return;
    const timer = setTimeout(() => setSaved(false), 2600);
    return () => clearTimeout(timer);
  }, [saved, triggerCount]);

  return { saved, trigger };
}

/* ─── Main Page ─────────────────────────────────────── */

export default function SettingsPage() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const { user, signOut } = useAuth();
  const navigate = useNavigate();

  const [activeTab, setActiveTab] = useState("general");
  const [settings, setSettings] = useState<TenantSettingsData | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [deleteConfirmText, setDeleteConfirmText] = useState("");
  const [isDeleting, setIsDeleting] = useState(false);
  const [changePasswordOpen, setChangePasswordOpen] = useState(false);

  // AI Classification thresholds
  const [aiAutoPromote, setAiAutoPromote] = useState<number>(95);
  const [aiReview, setAiReview] = useState<number>(70);
  const [portfolioCurrency, setPortfolioCurrency] = useState<string>("USD");
  const [plaidHistoryDays, setPlaidHistoryDays] = useState<number>(1);
  const { data: tenantSettings, isLoading: isLoadingTenantSettings } = useTenantSettings();
  const updateTenantSettings = useUpdateTenantSettings();

  // Save confirmation instances
  const generalSave = useSaveConfirmation();
  const countriesSave = useSaveConfirmation();
  const portfolioSave = useSaveConfirmation();
  const banksSave = useSaveConfirmation();
  const aiSave = useSaveConfirmation();

  // New bank form
  const [newBankName, setNewBankName] = useState("");
  const [isAddingBank, setIsAddingBank] = useState(false);

  useEffect(() => {
    if (tenantSettings) {
      setAiAutoPromote(Math.round(tenantSettings.autoPromoteThreshold * 100));
      setAiReview(Math.round(tenantSettings.reviewThreshold * 100));
      setPortfolioCurrency(tenantSettings.portfolioCurrency || "USD");
      setPlaidHistoryDays(tenantSettings.plaidHistoryDays ?? 1);
    }
  }, [tenantSettings]);

  const {
    data: metadata,
    isLoading: isReferenceDataLoading,
    error: referenceDataError,
  } = useMetadata();

  const availableCountries = useMemo(() => metadata?.countries ?? [], [metadata?.countries]);
  const availableCurrencies = useMemo(() => metadata?.currencies ?? [], [metadata?.currencies]);
  const availableBanks = useMemo(() => metadata?.banks ?? [], [metadata?.banks]);

  const syncStateFromMeta = (meta: { name: string; plan?: string; countries: Country[]; currencies: Currency[]; banks: Bank[]; plaidLinkedBankIds?: number[] } | null) => {
    if (meta) {
      setSettings({
        name: meta.name,
        plan: meta.plan ?? "FREE",
        countries: meta.countries?.map((c) => c.id) ?? [],
        currencies: meta.currencies?.map((c) => c.id) ?? [],
        bankIds: meta.banks?.map((b) => b.id) ?? [],
        plaidLinkedBankIds: meta.plaidLinkedBankIds ?? [],
      });
    }
  };

  useEffect(() => {
    const init = async () => {
      const meta = getTenantMeta();
      syncStateFromMeta(meta);
      if (user?.tenant?.id) {
        const freshMeta = await updateTenantMetaFromAPI(user.tenant.id);
        if (freshMeta) syncStateFromMeta(freshMeta);
      }
    };
    init();
  }, [user]);

  const handleSettingsChange = (field: keyof TenantSettingsData, value: TenantSettingsData[keyof TenantSettingsData]) => {
    setSettings((prev) => (prev ? { ...prev, [field]: value } : null));
  };

  const handleSaveChanges = async (onSuccess?: () => void) => {
    const tenantId = user?.tenant?.id;
    if (!settings || !tenantId) {
      toast({
        title: t("common.error"),
        description: t("pages.settings.error_saving_no_id"),
        variant: "destructive",
      });
      return;
    }

    setIsSubmitting(true);
    try {
      const updateData: TenantUpdateRequest = settings;
      const updatedTenant = await api.updateTenant(tenantId, updateData);
      setTenantMeta(pickTenantMetaFields(updatedTenant));
      setSettings({
        name: updatedTenant.name,
        plan: updatedTenant.plan ?? "FREE",
        countries: updatedTenant.countries.map((c) => c.id),
        currencies: updatedTenant.currencies.map((c) => c.id),
        bankIds: updatedTenant.banks.map((b) => b.id),
      });
      onSuccess?.();
    } catch (error) {
      console.error("Error saving tenant settings:", error);
      toast({
        title: t("common.error"),
        description:
          error instanceof Error ? error.message : t("pages.settings.error_saving_generic"),
        variant: "destructive",
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleSaveAISettings = () => {
    updateTenantSettings.mutate(
      {
        autoPromoteThreshold: aiAutoPromote / 100,
        reviewThreshold: aiReview / 100,
        plaidHistoryDays,
      },
      {
        onSuccess: () => aiSave.trigger(),
        onError: () => {
          toast({
            title: t("common.error"),
            description: "Failed to save AI settings.",
            variant: "destructive",
          });
        },
      },
    );
  };

  const handleDeleteAccount = async () => {
    const tenantId = user?.tenant?.id;
    if (!tenantId) return;

    setIsDeleting(true);
    try {
      await api.deleteTenant(tenantId);
      toast({
        title: "Account deleted",
        description: "Your account and all associated data have been permanently deleted.",
      });
      await signOut();
      navigate("/auth");
    } catch (error) {
      console.error("Error deleting account:", error);
      toast({
        title: t("common.error"),
        description: "Failed to delete account. Please try again or contact support.",
        variant: "destructive",
      });
      setIsDeleting(false);
    }
  };

  const handleAddBank = async () => {
    const trimmed = newBankName.trim();
    if (trimmed.length < 2 || trimmed.length > 100) return;

    setIsAddingBank(true);
    try {
      const newBank = await api.createBank({ name: trimmed });
      // Auto-select the new bank
      if (settings && !settings.bankIds.includes(newBank.id)) {
        handleSettingsChange("bankIds", [...settings.bankIds, newBank.id]);
      }
      setNewBankName("");
    } catch (error) {
      toast({
        title: t("common.error"),
        description: "Failed to add bank.",
        variant: "destructive",
      });
    } finally {
      setIsAddingBank(false);
    }
  };

  const deleteConfirmMatch = deleteConfirmText.trim().toLowerCase() === "delete my account";

  /* ─── Memoized combobox options ──────────────────── */

  const countryOptions: ComboboxOption[] = useMemo(
    () =>
      availableCountries.map((c: Country) => ({
        value: c.id,
        label: c.name,
        icon: c.emoji || "🌍",
      })),
    [availableCountries],
  );

  const currencyOptions: ComboboxOption[] = useMemo(
    () =>
      availableCurrencies.map((c: Currency) => ({
        value: c.id,
        label: `${c.id} — ${c.name}`,
        icon: c.symbol || c.id,
      })),
    [availableCurrencies],
  );

  const bankOptions: ComboboxOption[] = useMemo(
    () =>
      availableBanks.map((b: Bank) => ({
        value: String(b.id),
        label: b.name,
        icon: "🏦",
      })),
    [availableBanks],
  );

  /* ─── Loading / Error states ─────────────────────── */

  if (isReferenceDataLoading || !settings) {
    return (
      <div className="max-w-[880px] mx-auto py-7 px-7 space-y-6">
        <Skeleton className="h-12 w-64" />
        <Skeleton className="h-10 w-full max-w-lg" />
        <Skeleton className="h-64 w-full" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }

  if (referenceDataError) {
    return (
      <div className="flex items-center justify-center min-h-[400px] text-destructive">
        <p>{t("pages.settings.error_loading_reference_data")}</p>
      </div>
    );
  }

  /* ─── Render ─────────────────────────────────────── */

  return (
    <div className="max-w-[880px] mx-auto py-7 px-7 pb-20 flex flex-col gap-6 relative">
      {/* Page Header */}
      <div className="flex items-start gap-3.5">
        <div className="w-[42px] h-[42px] rounded-xl bg-brand-primary/10 flex items-center justify-center text-brand-primary shrink-0 mt-0.5">
          <SettingsIcon className="h-5 w-5" />
        </div>
        <div>
          <h2 className="text-[1.625rem] font-semibold text-foreground tracking-[-0.03em]">
            {t("pages.settings.title")}
          </h2>
          <p className="text-sm text-muted-foreground mt-1">
            {t("pages.settings.description")}
          </p>
        </div>
      </div>

      {/* Tab Navigation — Pill Segmented Control */}
      <div className="overflow-x-auto pb-0.5">
        <Tabs value={activeTab} onValueChange={setActiveTab}>
          <TabsList className="bg-muted border border-border rounded-[0.875rem] p-[3px] inline-flex gap-0.5 h-auto">
            <TabsTrigger
              value="general"
              className="rounded-[0.75rem] px-2 sm:px-4 py-2 text-xs sm:text-sm data-[state=active]:bg-primary data-[state=active]:text-primary-foreground data-[state=active]:shadow-sm"
            >
              <SettingsIcon className="h-3.5 w-3.5 sm:mr-1.5" />
              <span className="hidden sm:inline">{t("pages.settings.tabs.general")}</span>
            </TabsTrigger>
            <TabsTrigger
              value="countries-currencies"
              className="rounded-[0.75rem] px-2 sm:px-4 py-2 text-xs sm:text-sm data-[state=active]:bg-primary data-[state=active]:text-primary-foreground data-[state=active]:shadow-sm"
            >
              <Globe className="h-3.5 w-3.5 sm:mr-1.5" />
              <span className="hidden sm:inline">{t("pages.settings.tabs.countries_currencies")}</span>
            </TabsTrigger>
            <TabsTrigger
              value="banks"
              className="rounded-[0.75rem] px-2 sm:px-4 py-2 text-xs sm:text-sm data-[state=active]:bg-primary data-[state=active]:text-primary-foreground data-[state=active]:shadow-sm"
            >
              <Building className="h-3.5 w-3.5 sm:mr-1.5" />
              <span className="hidden sm:inline">{t("pages.settings.tabs.banks")}</span>
            </TabsTrigger>
            <TabsTrigger
              value="ai-classification"
              className="rounded-[0.75rem] px-2 sm:px-4 py-2 text-xs sm:text-sm data-[state=active]:bg-primary data-[state=active]:text-primary-foreground data-[state=active]:shadow-sm"
            >
              <Sparkles className="h-3.5 w-3.5 sm:mr-1.5" />
              <span className="hidden sm:inline">AI Classification</span>
            </TabsTrigger>
            {/* Maintenance tab — admin only. Non-admin users don't see it
                at all (server-side auth returns 403 if they find the URL,
                but hiding the entry point is the primary guard). */}
            {user?.role === 'admin' && (
              <TabsTrigger
                value="maintenance"
                className="rounded-[0.75rem] px-2 sm:px-4 py-2 text-xs sm:text-sm data-[state=active]:bg-primary data-[state=active]:text-primary-foreground data-[state=active]:shadow-sm"
              >
                <Wrench className="h-3.5 w-3.5 sm:mr-1.5" />
                <span className="hidden sm:inline">Maintenance</span>
              </TabsTrigger>
            )}
          </TabsList>

          {/* ═══════ GENERAL TAB ═══════ */}
          <TabsContent value="general" className="mt-6 space-y-5">
            {/* Workspace Details Card */}
            <Card className="overflow-hidden p-0 gap-0">
              <div className="px-7 pt-[22px] pb-[18px]">
                <h3 className="text-lg font-medium text-foreground tracking-[-0.01em]">
                  Workspace Details
                </h3>
                <p className="text-[0.8125rem] text-muted-foreground mt-1 leading-relaxed">
                  These settings apply to your entire bliss workspace.
                </p>
              </div>

              <CardDivider />

              <div className="px-7 py-7">
                <div className="flex flex-col gap-5">
                  <SectionLabel>Identity</SectionLabel>

                  <div className="space-y-1.5">
                    <Label htmlFor="tenant-name">Workspace Name</Label>
                    <Input
                      id="tenant-name"
                      value={settings.name}
                      onChange={(e) => handleSettingsChange("name", e.target.value)}
                      className="bg-input-background"
                    />
                    <p className="text-xs text-muted-foreground">
                      {t("pages.settings.general.tenant_name_description")}
                    </p>
                  </div>

                  <div className="flex items-center justify-between">
                    <div>
                      <Label>{t("pages.settings.general.user_management_label")}</Label>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        {t("pages.settings.general.user_management_description")}
                      </p>
                    </div>
                    <Link to="/settings/users">
                      <Button size="sm" variant="outline" className="gap-1.5">
                        <Users className="h-3.5 w-3.5" />
                        {t("pages.settings.general.user_management_button")}
                        <ExternalLink className="h-3 w-3 opacity-50" />
                      </Button>
                    </Link>
                  </div>

                  <div className="flex items-center justify-between">
                    <div>
                      <Label>Password</Label>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        Update your account password
                      </p>
                    </div>
                    <Button size="sm" variant="outline" className="gap-1.5" onClick={() => setChangePasswordOpen(true)}>
                      <Lock className="h-3.5 w-3.5" />
                      Change Password
                    </Button>
                  </div>
                </div>
              </div>

              <CardDivider />

              <div className="px-7 py-4 flex items-center justify-between">
                <SaveConfirmation visible={generalSave.saved} />
                <div className="ml-auto">
                  <Button onClick={() => handleSaveChanges(() => generalSave.trigger())} disabled={isSubmitting}>
                    {isSubmitting ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : (
                      <Save className="mr-2 h-4 w-4" />
                    )}
                    {t("common.save_changes")}
                  </Button>
                </div>
              </div>
            </Card>

            {/* Danger Zone Card */}
            <Card className="overflow-hidden p-0 gap-0 border-destructive/30" style={{
              boxShadow: "0 1px 2px rgba(229,152,155,0.06), 0 4px 16px rgba(229,152,155,0.10), 0 12px 40px rgba(229,152,155,0.08), inset 0 1px 0 rgba(255,255,255,0.90)",
            }}>
              <div className="px-7 pt-[18px] pb-[14px]">
                <div className="flex items-center gap-2">
                  <AlertTriangle className="h-4 w-4 text-destructive" />
                  <h3 className="text-lg font-medium text-destructive tracking-[-0.01em]">
                    Danger Zone
                  </h3>
                </div>
              </div>

              <CardDivider variant="destructive" />

              <div className="px-7 py-5 flex items-center justify-between gap-6 flex-wrap">
                <div className="flex-1 min-w-[260px]">
                  <p className="text-[0.9375rem] font-medium text-foreground leading-snug">
                    Delete Workspace
                  </p>
                  <p className="text-[0.8125rem] text-muted-foreground mt-1 leading-relaxed max-w-[420px]">
                    Permanently delete this workspace, all users, and all financial
                    data. This action cannot be undone.
                  </p>
                </div>

                <div className="flex flex-col gap-3 items-end">
                  <Input
                    placeholder="delete my account"
                    value={deleteConfirmText}
                    onChange={(e) => setDeleteConfirmText(e.target.value)}
                    className="max-w-[240px] text-sm"
                  />
                  <AlertDialog>
                    <AlertDialogTrigger asChild>
                      <Button
                        variant="outline"
                        disabled={!deleteConfirmMatch || isDeleting}
                        className="border-destructive text-destructive bg-transparent hover:bg-destructive/10 gap-1.5"
                      >
                        {isDeleting ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <Trash2 className="h-4 w-4" />
                        )}
                        Delete Account
                      </Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>Are you absolutely sure?</AlertDialogTitle>
                        <AlertDialogDescription>
                          This will permanently delete your account, all users, transactions,
                          accounts, imports, and AI data. This action cannot be undone.
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction
                          onClick={handleDeleteAccount}
                          className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                        >
                          Yes, delete everything
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                </div>
              </div>
            </Card>
          </TabsContent>

          {/* ═══════ COUNTRIES & CURRENCIES TAB ═══════ */}
          <TabsContent value="countries-currencies" className="mt-6 space-y-5">
            <Card className="overflow-hidden p-0 gap-0">
              <div className="px-7 pt-[22px] pb-[18px]">
                <h3 className="text-lg font-medium text-foreground tracking-[-0.01em]">
                  Countries & Currencies
                </h3>
                <p className="text-[0.8125rem] text-muted-foreground mt-1 leading-relaxed">
                  Configure which countries and currencies are relevant to your financial activities.
                </p>
              </div>

              <CardDivider />

              <div className="px-7 py-7">
                <div className="flex flex-col gap-6">
                  <div>
                    <SectionLabel>Countries</SectionLabel>
                    <MultiSelectCombobox
                      label="Active Countries"
                      hint="Countries where you have financial activities."
                      selected={settings.countries}
                      onSelectionChange={(val) => handleSettingsChange("countries", val)}
                      options={countryOptions}
                      placeholder="Select countries..."
                      searchPlaceholder="Search countries..."
                    />
                  </div>

                  <div>
                    <SectionLabel>Currencies</SectionLabel>
                    <MultiSelectCombobox
                      label="Active Currencies"
                      hint="Currencies you use in your transactions."
                      selected={settings.currencies}
                      onSelectionChange={(val) => handleSettingsChange("currencies", val)}
                      options={currencyOptions}
                      placeholder="Select currencies..."
                      searchPlaceholder="Search currencies..."
                    />
                  </div>
                </div>
              </div>

              <CardDivider />

              <div className="px-7 py-4 flex items-center justify-between">
                <SaveConfirmation visible={countriesSave.saved} />
                <div className="ml-auto">
                  <Button onClick={() => handleSaveChanges(() => countriesSave.trigger())} disabled={isSubmitting}>
                    {isSubmitting ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : (
                      <Save className="mr-2 h-4 w-4" />
                    )}
                    {t("common.save_changes")}
                  </Button>
                </div>
              </div>
            </Card>

            {/* Portfolio Display Currency */}
            <Card className="overflow-hidden p-0 gap-0">
              <div className="px-7 pt-[22px] pb-[18px]">
                <h3 className="text-lg font-medium text-foreground tracking-[-0.01em]">
                  Portfolio Display Currency
                </h3>
                <p className="text-[0.8125rem] text-muted-foreground mt-1 leading-relaxed">
                  Choose the currency used to display your portfolio totals. Values are converted
                  automatically using daily exchange rates.
                </p>
              </div>

              <CardDivider />

              <div className="px-7 py-7">
                <div>
                  {isLoadingTenantSettings ? (
                    <Skeleton className="h-11 w-full" />
                  ) : (
                    <SettingsSelect
                      label="Display Currency"
                      hint="Used when displaying aggregated net worth and portfolio totals."
                      value={portfolioCurrency}
                      onValueChange={setPortfolioCurrency}
                      options={
                        settings.currencies.length > 0
                          ? settings.currencies.map((id) => {
                              const currency = availableCurrencies.find(
                                (c: Currency) => c.id === id,
                              );
                              return {
                                value: id,
                                label: currency
                                  ? `${currency.symbol || id} ${currency.name}`
                                  : id,
                              };
                            })
                          : [{ value: "USD", label: "No currencies configured" }]
                      }
                      disabled={settings.currencies.length === 0}
                    />
                  )}
                </div>
              </div>

              <CardDivider />

              <div className="px-7 py-4 flex items-center justify-between">
                <SaveConfirmation visible={portfolioSave.saved} />
                <div className="ml-auto">
                  <Button
                    onClick={() => {
                      updateTenantSettings.mutate(
                        { portfolioCurrency },
                        {
                          onSuccess: () => portfolioSave.trigger(),
                          onError: () => {
                            toast({
                              title: t("common.error"),
                              description: "Failed to update portfolio currency.",
                              variant: "destructive",
                            });
                          },
                        },
                      );
                    }}
                    disabled={
                      isLoadingTenantSettings ||
                      updateTenantSettings.isPending ||
                      portfolioCurrency === (tenantSettings?.portfolioCurrency || "USD")
                    }
                  >
                    {updateTenantSettings.isPending ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : (
                      <Save className="mr-2 h-4 w-4" />
                    )}
                    {t("common.save_changes")}
                  </Button>
                </div>
              </div>
            </Card>
          </TabsContent>

          {/* ═══════ BANKS TAB ═══════ */}
          <TabsContent value="banks" className="mt-6 space-y-5">
            <Card className="overflow-hidden p-0 gap-0">
              <div className="px-7 pt-[22px] pb-[18px]">
                <h3 className="text-lg font-medium text-foreground tracking-[-0.01em]">
                  {t("pages.settings.banks.title")}
                </h3>
                <p className="text-[0.8125rem] text-muted-foreground mt-1 leading-relaxed">
                  {t("pages.settings.banks.description")}
                </p>
              </div>

              <CardDivider />

              <div className="px-7 py-7">
                <div className="flex flex-col gap-6">
                  <MultiSelectCombobox
                    label="Your Banks"
                    hint="Banks you use in your financial activities."
                    selected={settings.bankIds.map(String)}
                    onSelectionChange={(val) =>
                      handleSettingsChange("bankIds", val.map(Number))
                    }
                    options={bankOptions}
                    placeholder="Select banks..."
                    searchPlaceholder="Search banks..."
                    renderPillExtra={(value) => {
                      const bankId = Number(value);
                      if (settings.plaidLinkedBankIds?.includes(bankId)) {
                        return (
                          <span title="Synced with Plaid" className="text-positive ml-0.5">
                            <LinkIcon className="h-3 w-3" />
                          </span>
                        );
                      }
                      return null;
                    }}
                  />

                  {/* Connected Accounts Summary */}
                  {(settings.plaidLinkedBankIds?.length ?? 0) > 0 && (
                    <div className="flex items-center gap-4 text-sm text-muted-foreground">
                      <div className="flex items-center gap-1.5">
                        <LinkIcon className="h-3.5 w-3.5 text-positive" />
                        <span>{settings.plaidLinkedBankIds?.length ?? 0} Plaid-connected</span>
                      </div>
                      <span className="text-border">|</span>
                      <div className="flex items-center gap-1.5">
                        <Building className="h-3.5 w-3.5" />
                        <span>
                          {settings.bankIds.length - (settings.plaidLinkedBankIds?.length ?? 0)}{" "}
                          manual
                        </span>
                      </div>
                      <Link
                        to="/accounts"
                        className="ml-auto text-brand-primary hover:underline flex items-center gap-1"
                      >
                        Manage accounts
                        <ExternalLink className="h-3 w-3" />
                      </Link>
                    </div>
                  )}

                  {/* Add Custom Bank */}
                  <div>
                    <SectionLabel>Add New Bank</SectionLabel>
                    <div className="flex gap-2">
                      <Input
                        placeholder="Bank name..."
                        value={newBankName}
                        onChange={(e) => setNewBankName(e.target.value)}
                        className="bg-input-background flex-1"
                        onKeyDown={(e) => {
                          if (e.key === "Enter") handleAddBank();
                        }}
                      />
                      <Button
                        variant="outline"
                        onClick={handleAddBank}
                        disabled={
                          isAddingBank ||
                          newBankName.trim().length < 2 ||
                          newBankName.trim().length > 100
                        }
                      >
                        {isAddingBank ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <Plus className="h-4 w-4" />
                        )}
                      </Button>
                    </div>
                    <p className="text-xs text-muted-foreground mt-1.5">
                      Can't find your bank? Add it here and it will be available for selection.
                    </p>
                  </div>
                </div>
              </div>

              <CardDivider />

              <div className="px-7 py-4 flex items-center justify-between">
                <SaveConfirmation visible={banksSave.saved} />
                <div className="ml-auto">
                  <Button onClick={() => handleSaveChanges(() => banksSave.trigger())} disabled={isSubmitting}>
                    {isSubmitting ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : (
                      <Save className="mr-2 h-4 w-4" />
                    )}
                    {t("common.save_changes")}
                  </Button>
                </div>
              </div>
            </Card>
          </TabsContent>

          {/* ═══════ AI CLASSIFICATION TAB ═══════ */}
          <TabsContent value="ai-classification" className="mt-6 space-y-5">
            <Card className="overflow-hidden p-0 gap-0">
              <div className="px-7 pt-[22px] pb-[18px]">
                <div className="flex items-center gap-2">
                  <Sparkles className="h-5 w-5 text-brand-primary" />
                  <h3 className="text-lg font-medium text-foreground tracking-[-0.01em]">
                    AI Classification
                  </h3>
                </div>
                <p className="text-[0.8125rem] text-muted-foreground mt-1 leading-relaxed">
                  Control how the AI handles transaction classification confidence scores.
                  These thresholds apply to all users in your workspace.
                </p>
              </div>

              <CardDivider />

              <div className="px-7 py-7">
                {isLoadingTenantSettings ? (
                  <div className="space-y-6">
                    <Skeleton className="h-16 w-full" />
                    <Skeleton className="h-16 w-full" />
                  </div>
                ) : (
                  <div className="flex flex-col gap-8">
                    <SectionLabel>Thresholds</SectionLabel>

                    {/* Auto-Promote Threshold */}
                    <div className="space-y-3">
                      <div className="flex items-center justify-between">
                        <Label className="text-base font-medium">Auto-Promote Threshold</Label>
                        <span className="text-2xl font-bold text-primary">{aiAutoPromote}%</span>
                      </div>
                      <Slider
                        min={50}
                        max={100}
                        step={1}
                        value={[aiAutoPromote]}
                        onValueChange={([v]) => setAiAutoPromote(v)}
                      />
                      <p className="text-sm text-muted-foreground">
                        Transactions classified at or above this confidence — by exact match, vector
                        similarity, or AI — are promoted automatically, skipping the review queue.
                      </p>
                    </div>

                    {/* Review Threshold */}
                    <div className="space-y-3">
                      <div className="flex items-center justify-between">
                        <Label className="text-base font-medium">Review Threshold</Label>
                        <span className="text-2xl font-bold text-primary">{aiReview}%</span>
                      </div>
                      <Slider
                        min={0}
                        max={100}
                        step={1}
                        value={[aiReview]}
                        onValueChange={([v]) => setAiReview(v)}
                      />
                      <p className="text-sm text-muted-foreground">
                        Minimum quality bar for AI classification. Below this threshold, vector
                        matches fall back to the LLM, and transactions are flagged as uncertain.
                      </p>
                    </div>

                    {/* Plaid History Window */}
                    <div className="space-y-3">
                      <div className="flex items-center justify-between">
                        <Label className="text-base font-medium">Plaid History Window</Label>
                        <span className="text-2xl font-bold text-primary">{plaidHistoryDays}d</span>
                      </div>
                      <Input
                        type="number"
                        min={1}
                        max={730}
                        value={plaidHistoryDays}
                        onChange={(e) =>
                          setPlaidHistoryDays(Math.max(1, parseInt(e.target.value) || 1))
                        }
                        className="w-28"
                      />
                      <p className="text-sm text-muted-foreground">
                        Number of days of transaction history fetched when connecting a new bank
                        and enforced as a date cutoff on every subsequent resync.
                      </p>
                    </div>

                    {/* Validation warning */}
                    {aiReview >= aiAutoPromote && (
                      <div className="flex items-center gap-2 p-3 rounded-md bg-warning/10 text-warning border border-warning/20 text-sm">
                        <AlertTriangle className="h-4 w-4 flex-shrink-0" />
                        <span>
                          Review threshold ({aiReview}%) should be lower than the auto-promote
                          threshold ({aiAutoPromote}%).
                        </span>
                      </div>
                    )}

                    {/* Classification pipeline explanation */}
                    <div className="mt-2">
                      <SectionLabel>Classification Pipeline</SectionLabel>
                      <div className="text-sm text-muted-foreground space-y-1.5">
                        <p>Transactions are classified through a 4-tier waterfall:</p>
                        <ol className="list-decimal list-inside space-y-1 ml-1">
                          <li>
                            <span className="font-medium text-foreground">Exact Match</span> —
                            instant lookup from confirmed transactions
                          </li>
                          <li>
                            <span className="font-medium text-foreground">Vector Match</span> —
                            cosine similarity against your embeddings
                          </li>
                          <li>
                            <span className="font-medium text-foreground">Global Vector</span> —
                            cross-tenant embeddings (discounted)
                          </li>
                          <li>
                            <span className="font-medium text-foreground">LLM</span> — Gemini
                            classification as final fallback
                          </li>
                        </ol>
                      </div>
                    </div>
                  </div>
                )}
              </div>

              <CardDivider />

              <div className="px-7 py-4 flex items-center justify-between">
                <SaveConfirmation visible={aiSave.saved} />
                <div className="ml-auto">
                  <Button
                    onClick={handleSaveAISettings}
                    disabled={
                      isLoadingTenantSettings ||
                      updateTenantSettings.isPending ||
                      aiReview >= aiAutoPromote
                    }
                  >
                    {updateTenantSettings.isPending ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : (
                      <Save className="mr-2 h-4 w-4" />
                    )}
                    {t("common.save_changes")}
                  </Button>
                </div>
              </div>
            </Card>
          </TabsContent>

          {/* ═══════ MAINTENANCE TAB (admin only) ═══════ */}
          {user?.role === 'admin' && (
            <TabsContent value="maintenance" className="mt-6 space-y-5">
              <MaintenanceTab />
            </TabsContent>
          )}
        </Tabs>
      </div>

      <ChangePasswordDialog open={changePasswordOpen} onOpenChange={setChangePasswordOpen} />
    </div>
  );
}

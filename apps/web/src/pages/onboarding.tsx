import { useState, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { motion, AnimatePresence } from "framer-motion";
import { TypeAnimation } from "react-type-animation";
import { useToast } from "@/hooks/use-toast";
import { useOnboarding } from "@/hooks/use-onboarding";
import api from "@/lib/api";
import type { TenantUpdateRequest } from "@/types/api";
import { updateTenantMetaFromAPI, getTenantMeta } from "@/utils/tenantMetaStorage";
import { useAuth } from "@/hooks/use-auth";
import { useMetadata } from "@/hooks/use-metadata";
import { useBanks } from "@/hooks/use-metadata";
import { useCompleteOnboardingStep } from "@/hooks/use-onboarding-progress";
import { PlaidConnect } from "@/components/plaid-connect";
import { AccountForm } from "@/components/entities/account-form";
import { useQueryClient } from "@tanstack/react-query";

import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  ArrowRight,
  ArrowLeft,
  X,
  Loader2,
  Building2,
  FileSpreadsheet,
  Wallet,
  Plus,
} from "lucide-react";

const containerVariants = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: { staggerChildren: 0.1, duration: 0.3 },
  },
  exit: { opacity: 0, transition: { duration: 0.3 } },
};

const itemVariants = {
  hidden: { y: 20, opacity: 0 },
  visible: { y: 0, opacity: 1, transition: { duration: 0.3 } },
};

export default function OnboardingPage() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const navigate = useNavigate();
  const { user } = useAuth();
  const { currentStep, setCurrentStep, preferences, setCountries, setCurrencies } = useOnboarding();
  const { data: metadata } = useMetadata();
  const completeStep = useCompleteOnboardingStep();

  const queryClient = useQueryClient();
  const { data: allBanks = [] } = useBanks();

  const [isLoading, setIsLoading] = useState(false);
  const [welcomeAnimDone, setWelcomeAnimDone] = useState(false);
  const [connectAnimDone, setConnectAnimDone] = useState(false);
  const [connectMethod, setConnectMethod] = useState<"csv" | null>(null);
  const [selectedBank, setSelectedBank] = useState<{ id: number; name: string } | null>(null);
  const [bankLinked, setBankLinked] = useState(false);
  const [isLinkingBank, setIsLinkingBank] = useState(false);
  const [newBankName, setNewBankName] = useState("");
  const [showNewBankInput, setShowNewBankInput] = useState(false);

  // Country & currency selection (both multi-select)
  const [selectedCountries, setSelectedCountries] = useState<string[]>([]);
  const [selectedCurrencies, setSelectedCurrencies] = useState<string[]>([]);

  const countries = useMemo(
    () => metadata?.countries?.map((c) => ({ id: c.id, name: c.name, emoji: c.emoji || "🌐" })) || [],
    [metadata]
  );

  const currencies = useMemo(
    () => metadata?.currencies?.map((c) => ({ id: c.id, name: c.name, symbol: c.symbol || "¤" })) || [],
    [metadata]
  );

  const toggleCountry = (id: string) => {
    setSelectedCountries((prev) =>
      prev.includes(id) ? prev.filter((c) => c !== id) : [...prev, id]
    );
  };

  const toggleCurrency = (id: string) => {
    setSelectedCurrencies((prev) =>
      prev.includes(id) ? prev.filter((c) => c !== id) : [...prev, id]
    );
  };

  const getTenantId = () => {
    let tenantId = user?.tenant?.id || user?.tenantId;
    if (!tenantId) {
      const tenantMeta = getTenantMeta();
      tenantId = tenantMeta?.id;
    }
    return tenantId;
  };

  // Step 1: Save profile (country + currencies) then advance
  const saveProfileAndContinue = async () => {
    setIsLoading(true);
    try {
      const tenantId = getTenantId();
      if (!tenantId) throw new Error(t("No tenant found"));

      const tenantMeta = getTenantMeta();
      const name = tenantMeta?.name;
      const plan = tenantMeta?.plan;
      if (!name || !plan) throw new Error(t("Tenant name or plan missing. Please contact support."));

      // Build payload — countries as array, currencies as array
      const payload: TenantUpdateRequest = { name, plan };
      if (selectedCountries.length > 0) payload.countries = selectedCountries;
      if (selectedCurrencies.length > 0) payload.currencies = selectedCurrencies;

      await api.updateTenant(tenantId, payload);
      await updateTenantMetaFromAPI(tenantId);

      // Update onboarding context
      setCountries(selectedCountries);
      setCurrencies(selectedCurrencies);

      // Mark step1 complete on server
      completeStep.mutate({ step: "step1_profile" });

      setCurrentStep("connect");
    } catch (error) {
      toast({
        title: t("Error"),
        description: (error as Error).message || t("Could not save your preferences. Please try again."),
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  };

  // Complete onboarding and redirect
  const finishOnboarding = async (redirectTo: string) => {
    try {
      await api.completeOnboardingStep("setupComplete");
      navigate(redirectTo);
    } catch {
      // Even if the API call fails, still navigate
      navigate(redirectTo);
    }
  };

  // Link a bank to the tenant, then refresh tenant meta so AccountForm sees it
  const linkBankAndContinue = async (bankName: string) => {
    setIsLinkingBank(true);
    try {
      const bank = await api.createBank({ name: bankName });
      const tenantId = getTenantId();
      if (tenantId) await updateTenantMetaFromAPI(tenantId);
      await queryClient.invalidateQueries({ queryKey: ["banks"] });
      setSelectedBank({ id: bank.id, name: bank.name });
      setBankLinked(true);
    } catch (error) {
      toast({
        title: t("Error"),
        description: (error as Error).message || t("Could not add bank. Please try again."),
        variant: "destructive",
      });
    } finally {
      setIsLinkingBank(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-gradient-to-br from-brand-primary/10 to-black/50 backdrop-blur-sm flex items-center justify-center p-4 z-50 overflow-y-auto">
      <Card className="w-full max-w-xl mx-auto shadow-xl" style={{ background: 'hsl(var(--card))', backdropFilter: 'none', WebkitBackdropFilter: 'none' }}>
        <CardContent className="p-6 md:p-8">
          <AnimatePresence mode="wait">
            {/* ═══════════════════════════════════════════════ */}
            {/* Step 1: Welcome + Profile                      */}
            {/* ═══════════════════════════════════════════════ */}
            {currentStep === "welcome" && (
              <motion.div
                key="welcome"
                className="space-y-6"
                variants={containerVariants}
                initial="hidden"
                animate="visible"
                exit="exit"
              >
                <motion.div className="text-center mb-4" variants={itemVariants}>
                  <h2 className="text-3xl font-bold mb-2">
                    {t("Welcome to")} <span className="text-brand-primary">bliss</span>
                  </h2>
                  <div className="min-h-8">
                    <TypeAnimation
                      sequence={[
                        t("Let's personalize your experience"),
                        () => setWelcomeAnimDone(true),
                      ]}
                      speed={30}
                      style={{ fontFamily: "Urbanist", display: "inline-block" }}
                      cursor={false}
                    />
                  </div>
                </motion.div>

                {welcomeAnimDone && (
                  <>
                    {/* Country picker (multi-select) */}
                    <motion.div variants={itemVariants}>
                      <label className="text-sm font-medium mb-2 block">
                        {t("Your countries")}
                      </label>
                      <div className="grid grid-cols-4 sm:grid-cols-5 gap-2 max-h-40 overflow-y-auto pr-1">
                        {countries.map((c) => (
                          <button
                            key={c.id}
                            onClick={() => toggleCountry(c.id)}
                            className={`flex flex-col items-center p-2 rounded-lg border text-xs transition-all ${
                              selectedCountries.includes(c.id)
                                ? "border-brand-primary bg-brand-primary/10 ring-1 ring-brand-primary/30"
                                : "border-border hover:bg-accent"
                            }`}
                          >
                            <span className="text-xl mb-1">{c.emoji}</span>
                            <span className="truncate w-full text-center">{c.name}</span>
                          </button>
                        ))}
                      </div>
                    </motion.div>

                    {/* Currency picker */}
                    <motion.div variants={itemVariants}>
                      <label className="text-sm font-medium mb-2 block">
                        {t("Your currencies")}
                      </label>
                      <div className="flex flex-wrap gap-2 max-h-32 overflow-y-auto pr-1">
                        {currencies.map((c) => (
                          <button
                            key={c.id}
                            onClick={() => toggleCurrency(c.id)}
                            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full border text-sm transition-all ${
                              selectedCurrencies.includes(c.id)
                                ? "border-brand-primary bg-brand-primary/10 text-brand-primary"
                                : "border-border hover:bg-accent"
                            }`}
                          >
                            <span>{c.symbol}</span>
                            <span>{c.id}</span>
                            {selectedCurrencies.includes(c.id) && (
                              <X className="h-3 w-3 ml-1" />
                            )}
                          </button>
                        ))}
                      </div>
                    </motion.div>

                    {/* Continue button */}
                    <motion.div className="flex justify-end pt-2" variants={itemVariants}>
                      <Button
                        onClick={saveProfileAndContinue}
                        className="gap-2 px-6 py-5 text-base rounded-xl"
                        size="lg"
                        disabled={isLoading}
                      >
                        {isLoading ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <>
                            {t("Continue")}
                            <ArrowRight className="h-4 w-4" />
                          </>
                        )}
                      </Button>
                    </motion.div>
                  </>
                )}
              </motion.div>
            )}

            {/* ═══════════════════════════════════════════════ */}
            {/* Step 2: Connect Account                        */}
            {/* ═══════════════════════════════════════════════ */}
            {currentStep === "connect" && (
              <motion.div
                key="connect"
                className="space-y-6"
                variants={containerVariants}
                initial="hidden"
                animate="visible"
                exit="exit"
              >
                <motion.div className="text-center mb-4" variants={itemVariants}>
                  <div className="mx-auto bg-brand-primary/10 text-brand-primary h-14 w-14 rounded-full flex items-center justify-center mb-4">
                    <Building2 className="h-7 w-7" />
                  </div>
                  <h2 className="text-2xl font-bold mb-2">
                    {t("Connect your accounts")}
                  </h2>
                  <div className="min-h-8">
                    <TypeAnimation
                      sequence={[
                        t("Link a bank, import a CSV, or add accounts manually"),
                        () => setConnectAnimDone(true),
                      ]}
                      speed={30}
                      style={{ fontFamily: "Urbanist", display: "inline-block" }}
                      cursor={false}
                    />
                  </div>
                </motion.div>

                {connectAnimDone && (
                  <motion.div className="space-y-3" variants={itemVariants}>
                    {/* Primary CTA: Plaid */}
                    <div className="rounded-xl border-2 border-brand-primary/30 bg-brand-primary/5 p-5">
                      <div className="flex items-start gap-4">
                        <div className="bg-brand-primary/10 text-brand-primary h-10 w-10 rounded-full flex items-center justify-center shrink-0 mt-0.5">
                          <Building2 className="h-5 w-5" />
                        </div>
                        <div className="flex-1">
                          <h3 className="font-semibold text-base mb-1">
                            {t("Connect your bank")}
                          </h3>
                          <p className="text-sm text-muted-foreground mb-3">
                            {t("Securely link your bank accounts via Plaid for automatic transaction sync.")}
                          </p>
                          <PlaidConnect
                            className="w-full rounded-lg"
                            onComplete={async () => {
                              completeStep.mutate({ step: "step2_connect", data: { method: "plaid" } });
                              completeStep.mutate({ step: "connectBank" });
                              await finishOnboarding("/");
                            }}
                          >
                            {t("Connect Bank Account")}
                          </PlaidConnect>
                        </div>
                      </div>
                    </div>

                    {/* Divider */}
                    <div className="flex items-center gap-3 py-1">
                      <div className="flex-1 border-t" />
                      <span className="text-xs text-muted-foreground uppercase tracking-wide">
                        {t("or")}
                      </span>
                      <div className="flex-1 border-t" />
                    </div>

                    {/* Import sheet option */}
                    <button
                      onClick={() => {
                        setConnectMethod("csv");
                        completeStep.mutate({ step: "step2_connect", data: { method: "csv" } });
                        setCurrentStep("create-account");
                      }}
                      className="flex items-center gap-4 p-4 rounded-xl border hover:bg-accent transition-colors w-full text-left"
                    >
                      <div className="bg-muted h-10 w-10 rounded-full flex items-center justify-center shrink-0">
                        <FileSpreadsheet className="h-5 w-5 text-muted-foreground" />
                      </div>
                      <div>
                        <h3 className="font-semibold text-sm">{t("Import a spreadsheet")}</h3>
                        <p className="text-xs text-muted-foreground">
                          {t("Upload a CSV or Excel file with your transactions.")}
                        </p>
                      </div>
                    </button>
                  </motion.div>
                )}
              </motion.div>
            )}

            {/* ═══════════════════════════════════════════════ */}
            {/* Step 3: Select Bank → Create Account            */}
            {/* ═══════════════════════════════════════════════ */}
            {currentStep === "create-account" && (
              <motion.div
                key="create-account"
                className="space-y-4"
                variants={containerVariants}
                initial="hidden"
                animate="visible"
                exit="exit"
              >
                {/* Header with back button */}
                <motion.div variants={itemVariants}>
                  <div className="flex items-center gap-3 mb-1">
                    <button
                      onClick={() => {
                        setSelectedBank(null);
                        setBankLinked(false);
                        setShowNewBankInput(false);
                        setCurrentStep("connect");
                      }}
                      className="text-muted-foreground hover:text-foreground transition-colors"
                    >
                      <ArrowLeft className="h-5 w-5" />
                    </button>
                    <div className="bg-brand-primary/10 text-brand-primary h-10 w-10 rounded-full flex items-center justify-center shrink-0">
                      <Wallet className="h-5 w-5" />
                    </div>
                    <div>
                      <h2 className="text-xl font-bold">
                        {bankLinked
                          ? t("Create your account")
                          : t("Choose your bank")}
                      </h2>
                      <p className="text-sm text-muted-foreground">
                        {bankLinked
                          ? t("Set up the account you'll import transactions into.")
                          : t("Select the bank for your first account.")}
                      </p>
                    </div>
                  </div>
                </motion.div>

                {/* Phase 1: Bank selection */}
                {!bankLinked && (
                  <motion.div variants={itemVariants} className="space-y-3">
                    <div className="grid grid-cols-3 sm:grid-cols-4 gap-2 max-h-48 overflow-y-auto pr-1">
                      {allBanks.map((bank) => (
                        <button
                          key={bank.id}
                          onClick={() => linkBankAndContinue(bank.name)}
                          disabled={isLinkingBank}
                          className="flex flex-col items-center justify-center p-3 rounded-lg border text-xs transition-all hover:bg-accent border-border"
                        >
                          <Building2 className="h-5 w-5 mb-1 text-muted-foreground" />
                          <span className="truncate w-full text-center font-medium">{bank.name}</span>
                        </button>
                      ))}
                    </div>

                    {/* Add custom bank */}
                    {!showNewBankInput ? (
                      <button
                        onClick={() => setShowNewBankInput(true)}
                        className="flex items-center gap-2 text-sm text-brand-primary hover:text-brand-primary/80 transition-colors"
                      >
                        <Plus className="h-4 w-4" />
                        {t("Add a different bank")}
                      </button>
                    ) : (
                      <div className="flex gap-2">
                        <input
                          autoFocus
                          value={newBankName}
                          onChange={(e) => setNewBankName(e.target.value)}
                          placeholder={t("Bank name")}
                          className="flex-1 px-3 py-2 rounded-lg border border-border bg-background text-sm focus:outline-none focus:ring-1 focus:ring-brand-primary"
                          onKeyDown={(e) => {
                            if (e.key === "Enter" && newBankName.trim().length >= 2) {
                              linkBankAndContinue(newBankName.trim());
                            }
                          }}
                        />
                        <Button
                          size="sm"
                          onClick={() => linkBankAndContinue(newBankName.trim())}
                          disabled={newBankName.trim().length < 2 || isLinkingBank}
                        >
                          {isLinkingBank ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            t("Add")
                          )}
                        </Button>
                      </div>
                    )}

                    {isLinkingBank && (
                      <div className="flex items-center justify-center gap-2 text-sm text-muted-foreground py-2">
                        <Loader2 className="h-4 w-4 animate-spin" />
                        {t("Setting up bank...")}
                      </div>
                    )}
                  </motion.div>
                )}

                {/* Phase 2: Account form (shown after bank is linked) */}
                {bankLinked && (
                  <motion.div
                    variants={itemVariants}
                    initial="hidden"
                    animate="visible"
                  >
                    <AccountForm
                      account={null}
                      onClose={async (refetchNeeded) => {
                        if (refetchNeeded) {
                          await finishOnboarding("/agents/import");
                        } else {
                          // User cancelled — go back to bank selection
                          setSelectedBank(null);
                          setBankLinked(false);
                        }
                      }}
                    />
                  </motion.div>
                )}
              </motion.div>
            )}
          </AnimatePresence>
        </CardContent>
      </Card>
    </div>
  );
}

import { useState, useEffect, useRef, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Loader2, CheckCircle2, BrainCircuit, AlertTriangle, Clock, Sparkles, X, Link2 } from "lucide-react";
import { format } from "date-fns";
import { useToast } from "@/hooks/use-toast";
import api from "@/lib/api";
import type { TenantUpdateRequest, SeedItem, Category } from "@/types/api";

interface AccountSelectionModalProps {
    isOpen: boolean;
    onClose: () => void;
    plaidItemId: string | null;
    onSuccess: () => void;
}

interface PlaidAccount {
    accountId: string;
    name: string;
    mask: string;
    type: string;
    subtype: string;
    currentBalance: number;
    isoCurrencyCode: string;
    isCurrencySupported: boolean;
}

interface LinkableAccount {
    id: number;
    name: string;
    mask: string;
    currencyCode: string;
}

type SyncPhase = 'setup' | 'syncing' | 'seed' | 'done';

interface SyncSummary {
    classified: number;
    pending: number;
    promoted: number;
    skipped: number;
    seedHeld?: number;
}

export function AccountSelectionModal({ isOpen, onClose, plaidItemId, onSuccess }: AccountSelectionModalProps) {
    const [accounts, setAccounts] = useState<PlaidAccount[]>([]);
    const [selectedIds, setSelectedIds] = useState<string[]>([]);
    const [isLoading, setIsLoading] = useState(false);
    const [isSyncing, setIsSyncing] = useState(false);
    const [syncPhase, setSyncPhase] = useState<SyncPhase>('setup');
    const [syncSummary, setSyncSummary] = useState<SyncSummary | null>(null);
    const [syncStep, setSyncStep] = useState(0); // 0=linked, 1=syncing, 2=classifying
    const [unsupportedCurrencies, setUnsupportedCurrencies] = useState<string[]>([]);
    const [tenantCurrencies, setTenantCurrencies] = useState<string[]>([]);
    const [tenantId, setTenantId] = useState<string>('');
    const [institutionCountry, setInstitutionCountry] = useState<string | null>(null);
    const [unsupportedCountry, setUnsupportedCountry] = useState<string | null>(null);
    const [unsupportedCountryId, setUnsupportedCountryId] = useState<string | null>(null);
    const [tenantCountries, setTenantCountries] = useState<{ id: string; iso2: string | null }[]>([]);
    const [earliestDate, setEarliestDate] = useState<string | null>(null);
    // ── Setup phase state (select + link + rename consolidated) ──
    const [accountMappings, setAccountMappings] = useState<Record<string, number | null>>({});
    const [accountNames, setAccountNames] = useState<Record<string, string>>({});
    const [linkableAccounts, setLinkableAccounts] = useState<LinkableAccount[]>([]);
    // ── Seed interview state ──
    const [seedData, setSeedData] = useState<SeedItem[]>([]);
    const [localCategories, setLocalCategories] = useState<Record<string, number>>({});
    const [localSeedTypes, setLocalSeedTypes] = useState<Record<string, string>>({});
    const [localSeedGroups, setLocalSeedGroups] = useState<Record<string, string>>({});
    const [excludedSeeds, setExcludedSeeds] = useState<Set<string>>(new Set());
    const [allCategories, setAllCategories] = useState<Category[]>([]);
    const [isConfirmingSeeds, setIsConfirmingSeeds] = useState(false);
    const seedConfirmedRef = useRef(false);
    const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
    const stableCountRef = useRef(0);
    const { t } = useTranslation();
    const { toast } = useToast();
    const navigate = useNavigate();
    const queryClient = useQueryClient();

    /** Flush all account-related caches so the Accounts page reflects new data */
    const invalidateAccountQueries = useCallback(() => {
        queryClient.invalidateQueries({ queryKey: ['account-list'] });
        queryClient.invalidateQueries({ queryKey: ['plaid-items'] });
        queryClient.invalidateQueries({ queryKey: ['metadata'] });
        queryClient.invalidateQueries({ queryKey: ['metadata', 'accounts'] });
    }, [queryClient]);

    useEffect(() => {
        if (isOpen && plaidItemId) {
            setSyncPhase('setup');
            setSyncSummary(null);
            setSyncStep(0);
            stableCountRef.current = 0;
            setUnsupportedCurrencies([]);
            setTenantCurrencies([]);
            setTenantId('');
            setInstitutionCountry(null);
            setUnsupportedCountry(null);
            setUnsupportedCountryId(null);
            setTenantCountries([]);
            setAccountMappings({});
            setAccountNames({});
            setLinkableAccounts([]);
            setEarliestDate(null);
            setSeedData([]);
            setLocalCategories({});
            setLocalSeedTypes({});
            setLocalSeedGroups({});
            setExcludedSeeds(new Set());
            setAllCategories([]);
            setIsConfirmingSeeds(false);
            seedConfirmedRef.current = false;
            fetchAccounts();
        }
        return () => {
            if (pollRef.current) clearInterval(pollRef.current);
        };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fetchAccounts is defined below the effect; safe because callbacks only run after render
    }, [isOpen, plaidItemId]);

    const fetchAccounts = async () => {
        if (!plaidItemId) return;
        setIsLoading(true);
        try {
            // Fetch Plaid accounts and manual accounts in parallel
            const [plaidData, existingData] = await Promise.all([
                api.getPlaidAccounts(plaidItemId),
                api.getAccounts(),
            ]);
            const plaidAccounts = plaidData.accounts;
            setAccounts(plaidAccounts);
            setSelectedIds(plaidAccounts.map(a => a.accountId));
            setUnsupportedCurrencies(plaidData.unsupportedCurrencies ?? []);
            setTenantCurrencies(plaidData.tenantCurrencies ?? []);
            setTenantId(plaidData.tenantId ?? '');
            setInstitutionCountry(plaidData.institutionCountry ?? null);
            setUnsupportedCountry(plaidData.unsupportedCountry ?? null);
            setUnsupportedCountryId(plaidData.unsupportedCountryId ?? null);
            setTenantCountries(plaidData.tenantCountries ?? []);

            // Manual accounts available for linking (no plaidAccountId)
            const manual = existingData.accounts
                .filter(a => !a.plaidAccountId)
                .map(a => ({ id: a.id, name: a.name, mask: a.accountNumber, currencyCode: a.currencyCode }));
            setLinkableAccounts(manual);

            // Initialize mappings (all create-new) and names (from Plaid)
            const initialMappings: Record<string, null> = {};
            const initialNames: Record<string, string> = {};
            for (const acc of plaidAccounts) {
                initialMappings[acc.accountId] = null;
                initialNames[acc.accountId] = acc.name;
            }
            setAccountMappings(initialMappings);
            setAccountNames(initialNames);
        } catch (error) {
            console.error("Failed to fetch Plaid accounts", error);
            toast({
                title: t('common.error'),
                description: t('accountSelection.loadFailed'),
                variant: "destructive",
            });
        } finally {
            setIsLoading(false);
        }
    };

    const toggleAccount = (id: string) => {
        setSelectedIds(prev =>
            prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]
        );
    };

    const pollSyncStatus = useCallback(() => {
        if (!plaidItemId) return;

        let prevSummary: SyncSummary | null = null;

        pollRef.current = setInterval(async () => {
            try {
                const data = await api.getPlaidTransactions({
                    plaidItemId,
                    promotionStatus: 'ALL',
                    limit: 1,
                });
                const summary = data.summary;
                setSyncSummary(summary);

                // Fetch PlaidItem (earliest date + seedReady flag)
                try {
                    const items = await api.getPlaidItems();
                    const thisItem = items.find(i => i.id === plaidItemId);
                    if (thisItem?.earliestTransactionDate) {
                        setEarliestDate(thisItem.earliestTransactionDate);
                    }

                    // ── Seed interview trigger ───────────────────────────────
                    if (thisItem?.seedReady && !seedConfirmedRef.current) {
                        if (pollRef.current) clearInterval(pollRef.current);
                        setSyncStep(2);
                        try {
                            const seeds = await api.getPlaidSeeds(plaidItemId!, 15);
                            if (seeds.length === 0) {
                                // All top descriptions already known — skip interview
                                setSyncPhase('done');
                                invalidateAccountQueries();
                            } else {
                                const initial: Record<string, number> = {};
                                const initialTypes: Record<string, string> = {};
                                const initialGroups: Record<string, string> = {};
                                for (const s of seeds) {
                                    if (s.suggestedCategoryId != null) {
                                        initial[s.normalizedDescription] = s.suggestedCategoryId;
                                        if (s.suggestedCategory) {
                                            initialTypes[s.normalizedDescription] = s.suggestedCategory.type;
                                            initialGroups[s.normalizedDescription] = s.suggestedCategory.group;
                                        }
                                    }
                                }
                                setLocalCategories(initial);
                                setLocalSeedTypes(initialTypes);
                                setLocalSeedGroups(initialGroups);
                                setSeedData(seeds);
                                try {
                                    const catData = await api.getCategories({ limit: 1000 });
                                    setAllCategories(catData.categories ?? []);
                                } catch { /* non-critical */ }
                                setSyncPhase('seed');
                            }
                        } catch (seedErr) {
                            console.error('Failed to fetch seeds:', seedErr);
                            setSyncPhase('done');
                            invalidateAccountQueries();
                        }
                        return;
                    }
                } catch { /* non-critical */ }

                // Step 1: Syncing (we have transactions coming in)
                const totalTx = summary.classified + summary.pending + summary.promoted + summary.skipped;
                if (totalTx > 0) {
                    setSyncStep(1);
                }

                // Step 2: Classifying (some are classified)
                if (summary.classified > 0) {
                    setSyncStep(2);
                }

                // Fallback done condition
                if (summary.pending === 0 && summary.classified > 0) {
                    if (prevSummary && prevSummary.classified === summary.classified && prevSummary.pending === 0) {
                        stableCountRef.current++;
                    } else {
                        stableCountRef.current = 0;
                    }

                    if (stableCountRef.current >= 3) {
                        if (pollRef.current) clearInterval(pollRef.current);
                        setSyncPhase('done');
                        invalidateAccountQueries();
                    }
                }

                prevSummary = summary;
            } catch (err) {
                console.error("Poll sync status failed:", err);
            }
        }, 3000);
    }, [plaidItemId, invalidateAccountQueries]);

    const handleSync = async () => {
        if (!plaidItemId || selectedIds.length === 0) return;
        setIsSyncing(true);
        try {
            // Auto-add any currencies from selected accounts that aren't in the tenant yet
            const selectedAccounts = accounts.filter(a => selectedIds.includes(a.accountId));
            const currenciesToAdd = [
                ...new Set(
                    selectedAccounts
                        .filter(a => !a.isCurrencySupported && a.isoCurrencyCode)
                        .map(a => a.isoCurrencyCode)
                ),
            ];
            const tenantUpdates: Partial<TenantUpdateRequest> = {};
            if (currenciesToAdd.length > 0) {
                tenantUpdates.currencies = [...tenantCurrencies, ...currenciesToAdd];
            }
            if (unsupportedCountryId) {
                tenantUpdates.countries = [...tenantCountries.map(tc => tc.id), unsupportedCountryId];
            }
            if (Object.keys(tenantUpdates).length > 0 && tenantId) {
                await api.updateTenant(tenantId, tenantUpdates);
            }

            // Build non-null mappings to send to backend
            const activeMappings: Record<string, number> = {};
            for (const [plaidAccId, localId] of Object.entries(accountMappings)) {
                if (localId != null && selectedIds.includes(plaidAccId)) {
                    activeMappings[plaidAccId] = localId;
                }
            }

            // Build custom names for create-new accounts
            const customNames: Record<string, string> = {};
            for (const id of selectedIds) {
                if (accountMappings[id] == null && accountNames[id]) {
                    const plaidAcc = accounts.find(a => a.accountId === id);
                    // Only send if name differs from Plaid's default
                    if (plaidAcc && accountNames[id] !== plaidAcc.name) {
                        customNames[id] = accountNames[id];
                    }
                }
            }

            await api.syncPlaidAccounts(
                plaidItemId,
                selectedIds,
                institutionCountry ?? undefined,
                Object.keys(activeMappings).length > 0 ? activeMappings : undefined,
                Object.keys(customNames).length > 0 ? customNames : undefined,
            );
            setSyncPhase('syncing');
            setSyncStep(0);
            onSuccess();
            pollSyncStatus();
        } catch (error) {
            console.error("Sync failed", error);
            toast({
                title: t('common.error'),
                description: t('accountSelection.linkFailed'),
                variant: "destructive",
            });
        } finally {
            setIsSyncing(false);
        }
    };

    const handleSeedConfirm = async () => {
        if (!plaidItemId) return;
        setIsConfirmingSeeds(true);
        try {
            const seeds = seedData
                .filter(s => !excludedSeeds.has(s.normalizedDescription) && localCategories[s.normalizedDescription] != null)
                .map(s => ({
                    description: s.description,
                    rawName: s.rawName,
                    confirmedCategoryId: localCategories[s.normalizedDescription],
                }));
            if (seeds.length > 0) {
                await api.confirmPlaidSeeds(plaidItemId, seeds);
            }
            seedConfirmedRef.current = true;
            try {
                const fresh = await api.getPlaidTransactions({ plaidItemId, promotionStatus: 'ALL', limit: 1 });
                setSyncSummary(fresh.summary);
            } catch { /* non-critical */ }
            setSyncPhase('done');
            invalidateAccountQueries();
        } catch (err) {
            console.error('Seed confirmation failed:', err);
            toast({ title: t('common.error'), description: t('accountSelection.seedSaveFailed'), variant: 'destructive' });
        } finally {
            setIsConfirmingSeeds(false);
        }
    };

    const handleSeedSkip = async () => {
        try {
            if (plaidItemId) {
                await api.confirmPlaidSeeds(plaidItemId, []);
            }
        } catch (err) {
            console.error('Seed skip-release failed:', err);
        }
        seedConfirmedRef.current = true;
        try {
            const fresh = await api.getPlaidTransactions({ plaidItemId, promotionStatus: 'ALL', limit: 1 });
            setSyncSummary(fresh.summary);
        } catch { /* non-critical */ }
        setSyncPhase('done');
        invalidateAccountQueries();
    };

    const handleClose = () => {
        if (syncPhase === 'syncing' || syncPhase === 'seed') return;
        if (pollRef.current) clearInterval(pollRef.current);
        invalidateAccountQueries();
        onClose();
    };

    const handleReview = () => {
        if (pollRef.current) clearInterval(pollRef.current);
        invalidateAccountQueries();
        onClose();
        navigate(`/agents/review?source=plaid&plaidItemId=${plaidItemId}`);
    };

    // ── Sync Progress Steps ──
    const syncSteps = [
        { label: t('accountSelection.accountsLinked'), done: syncStep >= 0 },
        { label: t('accountSelection.syncingTransactions'), done: syncStep >= 2, active: syncStep === 1 },
        { label: t('accountSelection.aiClassifying'), done: syncPhase === 'done', active: syncStep === 2 && syncPhase !== 'done' },
    ];

    return (
        <Dialog open={isOpen} onOpenChange={handleClose}>
            <DialogContent className="sm:max-w-[600px] overflow-hidden">
                <DialogHeader>
                    <DialogTitle>
                        {syncPhase === 'setup' && t('accountSelection.setupTitle')}
                        {syncPhase === 'syncing' && t('accountSelection.syncingTitle')}
                        {syncPhase === 'seed' && (
                            <span className="flex items-center gap-2">
                                <Sparkles className="h-4 w-4 text-brand-primary" />
                                {t('accountSelection.quickClassify')}
                            </span>
                        )}
                        {syncPhase === 'done' && t('accountSelection.syncComplete')}
                    </DialogTitle>
                    <DialogDescription>
                        {syncPhase === 'setup' && t('accountSelection.setupDescription')}
                        {syncPhase === 'syncing' && t('accountSelection.syncingDescription')}
                        {syncPhase === 'seed' && t('accountSelection.seedDescription')}
                        {syncPhase === 'done' && t('accountSelection.doneDescription')}
                    </DialogDescription>
                </DialogHeader>

                {/* ── Setup Phase (select + link + rename consolidated) ── */}
                {syncPhase === 'setup' && (
                    <>
                        {isLoading ? (
                            <div className="flex justify-center p-8">
                                <Loader2 className="h-8 w-8 animate-spin" />
                            </div>
                        ) : (
                            <div className="py-4 space-y-4">
                                {unsupportedCurrencies.length > 0 && (
                                    <Alert>
                                        <AlertTriangle className="h-4 w-4" />
                                        <AlertTitle>{t('accountSelection.newCurrenciesDetected')}</AlertTitle>
                                        <AlertDescription>
                                            {t('accountSelection.currenciesUse')}{' '}
                                            <span className="font-medium">{unsupportedCurrencies.join(', ')}</span>
                                            {' '}{t('accountSelection.currenciesNotConfigured', { plurality: unsupportedCurrencies.length === 1 ? 'is' : 'are' })}
                                        </AlertDescription>
                                    </Alert>
                                )}
                                {unsupportedCountry && (
                                    <Alert>
                                        <AlertTriangle className="h-4 w-4" />
                                        <AlertTitle>{t('accountSelection.newCountryDetected')}</AlertTitle>
                                        <AlertDescription>
                                            {t('accountSelection.bankOperatesIn')}{' '}
                                            <span className="font-medium">{unsupportedCountry}</span>
                                            {' '}{t('accountSelection.countryNotConfigured')}
                                        </AlertDescription>
                                    </Alert>
                                )}
                                <div className="space-y-3 max-h-[50vh] overflow-y-auto">
                                    {accounts.map(account => {
                                        const isSelected = selectedIds.includes(account.accountId);
                                        const linkedId = accountMappings[account.accountId];
                                        const compatibleAccounts = linkableAccounts.filter(
                                            ma => ma.currencyCode === account.isoCurrencyCode
                                        );
                                        return (
                                            <div
                                                key={account.accountId}
                                                className={`p-3 border rounded-md space-y-2 transition-opacity ${!isSelected ? 'opacity-50' : ''}`}
                                            >
                                                {/* Top row: checkbox + account info */}
                                                <div className="flex items-center space-x-3">
                                                    <Checkbox
                                                        id={account.accountId}
                                                        checked={isSelected}
                                                        onCheckedChange={() => toggleAccount(account.accountId)}
                                                    />
                                                    <div className="flex-1">
                                                        <Label htmlFor={account.accountId} className="font-medium cursor-pointer">
                                                            {account.name} <span className="text-muted-foreground text-xs">({account.mask})</span>
                                                        </Label>
                                                        <p className="text-sm text-muted-foreground capitalize flex items-center gap-2">
                                                            {account.subtype || account.type} &bull; {account.isoCurrencyCode} {account.currentBalance}
                                                            {!account.isCurrencySupported && (
                                                                <Badge variant="outline" className="text-xs py-0 h-4">
                                                                    <AlertTriangle className="h-2.5 w-2.5 mr-1" />
                                                                    {t('accountSelection.notConfigured')}
                                                                </Badge>
                                                            )}
                                                        </p>
                                                    </div>
                                                </div>

                                                {/* Link + name controls (only when selected) */}
                                                {isSelected && (
                                                    <div className="pl-7 space-y-2">
                                                        {compatibleAccounts.length > 0 && (
                                                            <Select
                                                                value={linkedId != null ? linkedId.toString() : '__new__'}
                                                                onValueChange={(val) =>
                                                                    setAccountMappings(prev => ({
                                                                        ...prev,
                                                                        [account.accountId]: val === '__new__' ? null : parseInt(val, 10),
                                                                    }))
                                                                }
                                                            >
                                                                <SelectTrigger className="h-8 text-sm">
                                                                    <SelectValue />
                                                                </SelectTrigger>
                                                                <SelectContent>
                                                                    <SelectItem value="__new__">{t('accountSelection.createNewAccount')}</SelectItem>
                                                                    {compatibleAccounts.map(ma => (
                                                                        <SelectItem key={ma.id} value={ma.id.toString()}>
                                                                            <span className="flex items-center gap-1.5">
                                                                                <Link2 className="h-3 w-3 text-brand-primary" />
                                                                                {ma.name} {ma.mask && `(${ma.mask})`}
                                                                            </span>
                                                                        </SelectItem>
                                                                    ))}
                                                                </SelectContent>
                                                            </Select>
                                                        )}
                                                        {linkedId == null ? (
                                                            <Input
                                                                value={accountNames[account.accountId] ?? account.name}
                                                                onChange={e => setAccountNames(prev => ({
                                                                    ...prev,
                                                                    [account.accountId]: e.target.value,
                                                                }))}
                                                                placeholder={t('accountSelection.accountNamePlaceholder')}
                                                                className="h-8 text-sm"
                                                            />
                                                        ) : (
                                                            <p className="text-xs text-muted-foreground italic">
                                                                {t('accountSelection.existingAccountKept')}
                                                            </p>
                                                        )}
                                                    </div>
                                                )}
                                            </div>
                                        );
                                    })}
                                    {accounts.length === 0 && (
                                        <p className="text-center text-muted-foreground">{t('accountSelection.noAccountsFound')}</p>
                                    )}
                                </div>
                            </div>
                        )}
                        <p className="text-xs text-muted-foreground">
                            <span className="inline-flex items-center gap-1">
                                <Clock className="h-3 w-3" />
                                {t('accountSelection.syncHistoryNote')}
                            </span>
                        </p>
                        <DialogFooter>
                            <Button variant="outline" onClick={handleClose} disabled={isSyncing}>{t('common.cancel')}</Button>
                            <Button onClick={handleSync} disabled={isSyncing || selectedIds.length === 0}>
                                {isSyncing && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                                {t('accountSelection.syncAccounts', { count: selectedIds.length })}
                            </Button>
                        </DialogFooter>
                    </>
                )}

                {/* ── Syncing Phase ── */}
                {syncPhase === 'syncing' && (
                    <div className="py-6 space-y-6">
                        <div className="space-y-4">
                            {syncSteps.map((step, i) => (
                                <div key={i} className="flex items-center gap-3">
                                    {step.done ? (
                                        <CheckCircle2 className="h-5 w-5 text-positive flex-shrink-0" />
                                    ) : step.active ? (
                                        <Loader2 className="h-5 w-5 animate-spin text-primary flex-shrink-0" />
                                    ) : (
                                        <div className="h-5 w-5 rounded-full border-2 border-muted flex-shrink-0" />
                                    )}
                                    <span className={`text-sm ${step.done ? 'text-foreground font-medium' : step.active ? 'text-primary font-medium' : 'text-muted-foreground'}`}>
                                        {step.label}
                                        {step.active && '...'}
                                    </span>
                                </div>
                            ))}
                        </div>

                        <p className="text-sm text-muted-foreground text-center max-w-sm mx-auto mt-1">
                            {t('accountSelection.importingTransactions')}{earliestDate && (
                                <> {t('accountSelection.importingFrom')} <span className="font-medium text-foreground">{format(new Date(earliestDate), 'MMM d, yyyy')}</span></>
                            )}. {t('accountSelection.fullHistoryNote')}
                        </p>

                        {syncSummary && (
                            <div className="bg-muted rounded-lg p-3 text-xs text-muted-foreground space-y-1">
                                <div className="flex justify-between">
                                    <span>{t('accountSelection.promoted')}</span>
                                    <span className="font-medium text-positive">{syncSummary.promoted}</span>
                                </div>
                                <div className="flex justify-between">
                                    <span>{t('accountSelection.pendingReview')}</span>
                                    <span className="font-medium text-foreground">{syncSummary.classified + (syncSummary.seedHeld ?? 0)}</span>
                                </div>
                                <div className="flex justify-between">
                                    <span>{t('accountSelection.processing')}</span>
                                    <span className="font-medium text-foreground">{syncSummary.pending}</span>
                                </div>
                            </div>
                        )}

                        <p className="text-xs text-muted-foreground text-center">
                            {t('accountSelection.doNotClose')}
                        </p>
                    </div>
                )}

                {/* ── Seed Interview Phase ── */}
                {syncPhase === 'seed' && (() => {
                    const typeSet = new Set<string>();
                    const groupsByType: Record<string, string[]> = {};
                    const catsByTypeGroup: Record<string, Record<string, Category[]>> = {};
                    for (const cat of allCategories) {
                        const t = cat.type;
                        const g = cat.group ?? 'Other';
                        typeSet.add(t);
                        if (!catsByTypeGroup[t]) catsByTypeGroup[t] = {};
                        if (!catsByTypeGroup[t][g]) catsByTypeGroup[t][g] = [];
                        catsByTypeGroup[t][g].push(cat);
                    }
                    for (const t of typeSet) {
                        groupsByType[t] = Object.keys(catsByTypeGroup[t] ?? {}).sort();
                    }
                    const sortedTypes = Array.from(typeSet).sort();

                    return (
                        <div className="py-4 space-y-4 min-w-0">
                            <div className="space-y-2 max-h-[50vh] overflow-y-auto overflow-x-hidden pr-1 min-w-0">
                                {seedData.map((seed) => {
                                    const isExcluded = excludedSeeds.has(seed.normalizedDescription);
                                    return (
                                    <div
                                        key={seed.normalizedDescription}
                                        className={`flex flex-col gap-2 p-3 border rounded-md bg-background transition-opacity overflow-hidden ${isExcluded ? 'opacity-40' : ''}`}
                                    >
                                        <div className="flex items-center gap-3 min-w-0">
                                            <div className="flex-1 min-w-0">
                                                <p className={`text-sm font-medium truncate ${isExcluded ? 'line-through text-muted-foreground' : ''}`}>{seed.description}</p>
                                                <p className="text-xs text-muted-foreground">{seed.count}× transaction{seed.count !== 1 ? 's' : ''}</p>
                                            </div>

                                            {!isExcluded && (
                                                <div className="flex-shrink-0">
                                                    <Badge
                                                        variant="outline"
                                                        className="text-xs bg-brand-primary/10 text-brand-primary border-brand-primary/20 whitespace-nowrap"
                                                    >
                                                        {seed.classificationSource === 'VECTOR_MATCH_GLOBAL' ? 'Global' : seed.classificationSource === 'VECTOR_MATCH' ? 'Match' : 'AI'}{seed.aiConfidence != null ? ` ${Math.round(seed.aiConfidence * 100)}%` : ''}
                                                    </Badge>
                                                </div>
                                            )}

                                            <button
                                                type="button"
                                                onClick={() => setExcludedSeeds(prev => {
                                                    const next = new Set(prev);
                                                    if (next.has(seed.normalizedDescription)) {
                                                        next.delete(seed.normalizedDescription);
                                                    } else {
                                                        next.add(seed.normalizedDescription);
                                                    }
                                                    return next;
                                                })}
                                                className="flex-shrink-0 p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
                                                title={isExcluded ? 'Restore' : 'Skip this merchant'}
                                            >
                                                <X className="h-3.5 w-3.5" />
                                            </button>
                                        </div>

                                        <div className="flex items-center gap-1.5">
                                            <Select
                                                disabled={isExcluded}
                                                value={localSeedTypes[seed.normalizedDescription] ?? ''}
                                                onValueChange={(val) => {
                                                    const key = seed.normalizedDescription;
                                                    setLocalSeedTypes(prev => ({ ...prev, [key]: val }));
                                                    setLocalSeedGroups(prev => { const next = { ...prev }; delete next[key]; return next; });
                                                    setLocalCategories(prev => { const next = { ...prev }; delete next[key]; return next; });
                                                }}
                                            >
                                                <SelectTrigger className="h-7 text-[11px] flex-1 min-w-0 px-2">
                                                    <SelectValue placeholder={t('common.type')} />
                                                </SelectTrigger>
                                                <SelectContent className="max-h-60 overflow-auto">
                                                    {sortedTypes.map(t => (
                                                        <SelectItem key={t} value={t} className="text-xs">{t}</SelectItem>
                                                    ))}
                                                </SelectContent>
                                            </Select>

                                            <Select
                                                disabled={isExcluded || !localSeedTypes[seed.normalizedDescription]}
                                                value={localSeedGroups[seed.normalizedDescription] ?? ''}
                                                onValueChange={(val) => {
                                                    const key = seed.normalizedDescription;
                                                    setLocalSeedGroups(prev => ({ ...prev, [key]: val }));
                                                    setLocalCategories(prev => { const next = { ...prev }; delete next[key]; return next; });
                                                }}
                                            >
                                                <SelectTrigger className="h-7 text-[11px] flex-1 min-w-0 px-2">
                                                    <SelectValue placeholder={t('categoryForm.group')} />
                                                </SelectTrigger>
                                                <SelectContent className="max-h-60 overflow-auto">
                                                    {(groupsByType[localSeedTypes[seed.normalizedDescription]] ?? []).map(g => (
                                                        <SelectItem key={g} value={g} className="text-xs">{g}</SelectItem>
                                                    ))}
                                                </SelectContent>
                                            </Select>

                                            <Select
                                                disabled={isExcluded || !localSeedGroups[seed.normalizedDescription]}
                                                value={localCategories[seed.normalizedDescription]?.toString() ?? ''}
                                                onValueChange={(val) =>
                                                    setLocalCategories(prev => ({
                                                        ...prev,
                                                        [seed.normalizedDescription]: parseInt(val, 10),
                                                    }))
                                                }
                                            >
                                                <SelectTrigger className="h-7 text-[11px] flex-1 min-w-0 px-2">
                                                    <SelectValue placeholder={t('charts.category')} />
                                                </SelectTrigger>
                                                <SelectContent className="max-h-60 overflow-auto">
                                                    {(catsByTypeGroup[localSeedTypes[seed.normalizedDescription]]?.[localSeedGroups[seed.normalizedDescription]] ?? []).map(cat => (
                                                        <SelectItem key={cat.id} value={cat.id.toString()} className="text-xs">
                                                            {cat.icon ? `${cat.icon} ` : ''}{cat.name}
                                                        </SelectItem>
                                                    ))}
                                                </SelectContent>
                                            </Select>
                                        </div>
                                    </div>
                                    );
                                })}
                            </div>

                            <DialogFooter>
                                <Button variant="ghost" onClick={handleSeedSkip} disabled={isConfirmingSeeds}>
                                    {t('accountSelection.skipForNow')}
                                </Button>
                                <Button onClick={handleSeedConfirm} disabled={isConfirmingSeeds}>
                                    {isConfirmingSeeds && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                                    {t('accountSelection.confirmContinue')}
                                </Button>
                            </DialogFooter>
                        </div>
                    );
                })()}

                {/* ── Done Phase ── */}
                {syncPhase === 'done' && (
                    <div className="py-6 space-y-6">
                        <div className="space-y-4">
                            {syncSteps.map((step, i) => (
                                <div key={i} className="flex items-center gap-3">
                                    <CheckCircle2 className="h-5 w-5 text-positive flex-shrink-0" />
                                    <span className="text-sm font-medium">{step.label}</span>
                                </div>
                            ))}
                        </div>

                        {syncSummary && (
                            <div className="bg-positive/5 border border-positive/20 rounded-lg p-4 text-sm space-y-2">
                                <p className="font-semibold text-positive mb-1">{t('accountSelection.syncComplete')}</p>
                                {earliestDate && (
                                    <div className="flex justify-between text-muted-foreground">
                                        <span>{t('accountSelection.historyRange')}</span>
                                        <span className="font-medium text-foreground">{format(new Date(earliestDate), 'MMM d, yyyy')} → Today</span>
                                    </div>
                                )}
                                <div className="flex justify-between">
                                    <span className="text-positive">{t('accountSelection.promoted')}</span>
                                    <span className="font-semibold text-positive">{syncSummary.promoted}</span>
                                </div>
                                <div className="flex justify-between">
                                    <span>{t('accountSelection.readyForReview')}</span>
                                    <span className="font-semibold">{syncSummary.classified}</span>
                                </div>
                                {syncSummary.skipped > 0 && (
                                    <div className="flex justify-between text-muted-foreground">
                                        <span>{t('accountSelection.skippedDuplicates')}</span>
                                        <span>{syncSummary.skipped}</span>
                                    </div>
                                )}
                            </div>
                        )}

                        <div className="rounded-lg border border-brand-primary/20 bg-brand-primary/5 p-3 flex gap-2.5 items-start">
                            <div className="mt-0.5 shrink-0">
                                <Clock className="h-4 w-4 text-brand-primary" />
                            </div>
                            <div className="space-y-0.5">
                                <p className="text-sm font-medium text-foreground">
                                    {t('accountSelection.fullHistorySyncing')}
                                </p>
                                <p className="text-xs text-muted-foreground leading-relaxed">
                                    {earliestDate && (
                                        <>{t('accountSelection.currentlySyncedFrom')} <span className="font-medium text-foreground">{format(new Date(earliestDate), 'MMM d, yyyy')}</span>. </>
                                    )}
                                    {t('accountSelection.fullHistoryDetail')}
                                </p>
                            </div>
                        </div>

                        <DialogFooter className="sm:justify-between">
                            <Button variant="outline" onClick={handleClose}>{t('ui.close')}</Button>
                            <Button onClick={handleReview}>
                                <BrainCircuit className="h-4 w-4 mr-2" />
                                {t('accountSelection.reviewTransactions')}
                            </Button>
                        </DialogFooter>
                    </div>
                )}
            </DialogContent>
        </Dialog>
    );
}

import { useState, useCallback, useEffect } from 'react';
import { usePlaidLink } from 'react-plaid-link';
import { useTranslation } from 'react-i18next';
import { Button } from "@/components/ui/button";
import { Loader2, Plus, RefreshCw } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import api from '@/lib/api';
import { AccountSelectionModal } from './account-selection-modal';

interface PlaidConnectProps {
    onSuccess?: (public_token?: string, metadata?: Record<string, unknown>) => Promise<void> | void;
    /** Fires after the AccountSelectionModal closes (i.e., after full sync flow completes) */
    onComplete?: () => void;
    variant?: "default" | "outline" | "secondary" | "ghost" | "link";
    className?: string;
    children?: React.ReactNode;
    /** When provided, PlaidLink opens in update mode for re-authentication */
    plaidItemId?: string;
}

export function PlaidConnect({ onSuccess, onComplete, variant = "default", className, children, plaidItemId }: PlaidConnectProps) {
    const { t } = useTranslation();
    const [token, setToken] = useState<string | null>(null);
    const [isInitializing, setIsInitializing] = useState(false);
    const [showModal, setShowModal] = useState(false);
    const [createdPlaidItemId, setCreatedPlaidItemId] = useState<string | null>(null);
    const { toast } = useToast();

    const isUpdateMode = !!plaidItemId;

    const initializeLink = useCallback(async () => {
        setIsInitializing(true);
        try {
            // Pass plaidItemId for update mode (re-auth), or undefined for new connection
            const data = await api.createLinkToken(plaidItemId);
            setToken(data.link_token);
        } catch (error) {
            console.error("Failed to create link token", error);
            // Fail silently on init, user will define behavior when button is disabled or loading
        } finally {
            setIsInitializing(false);
        }
    }, [plaidItemId]);

    useEffect(() => {
        initializeLink();
    }, [initializeLink]);

    const onPlaidSuccess = useCallback(async (public_token: string, metadata: Record<string, unknown>) => {
        if (isUpdateMode) {
            // In update mode, no token exchange is needed — Plaid just re-authenticates
            // Reset the item status to ACTIVE
            try {
                await api.updatePlaidItem(plaidItemId!, { status: 'ACTIVE' });
                toast({
                    title: t('plaidConnect.success'),
                    description: t('plaidConnect.bankReauthenticated'),
                });
            } catch (error) {
                console.error("Failed to reset item status after re-auth", error);
                toast({
                    title: t('common.error'),
                    description: t('plaidConnect.reauthFailed'),
                    variant: "destructive",
                });
            }
            if (onSuccess) {
                await onSuccess(public_token, metadata);
            }
            return;
        }

        if (onSuccess) {
            await onSuccess(public_token, metadata);
            return;
        }

        // Default Behavior: Internal Exchange
        try {
            const { plaidItemId: newPlaidItemId } = await api.exchangePublicToken(public_token, metadata);
            setCreatedPlaidItemId(newPlaidItemId);
            setShowModal(true);
        } catch (error) {
            console.error("Exchange failed", error);
            toast({
                title: t('common.error'),
                description: t('plaidConnect.connectFailed'),
                variant: "destructive",
            });
        }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- t changes reference on every render; translations are stable within a session
    }, [toast, onSuccess, isUpdateMode, plaidItemId]);

    const onExit = useCallback((_error: unknown, _metadata: Record<string, unknown>) => {
    }, []);

    const onEvent = useCallback((_eventName: string, _metadata: Record<string, unknown>) => {
    }, []);

    const config: Parameters<typeof usePlaidLink>[0] = {
        token,
        onSuccess: onPlaidSuccess,
        onExit,
        onEvent,
    };

    const { open, ready } = usePlaidLink(config);

    // Default button content
    const defaultContent = isUpdateMode ? t('plaidConnect.reconnect') : t('plaidConnect.connectBank');
    const Icon = isUpdateMode ? RefreshCw : Plus;

    return (
        <>
            <Button
                type="button"
                onClick={() => open()}
                disabled={!ready || isInitializing}
                variant={variant}
                className={className}
            >
                {isInitializing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Icon className="mr-2 h-4 w-4" />}
                {children || defaultContent}
            </Button>

            <AccountSelectionModal
                isOpen={showModal}
                onClose={() => {
                    setShowModal(false);
                    if (onComplete) onComplete();
                }}
                plaidItemId={createdPlaidItemId}
                onSuccess={() => {
                    // Don't close the modal — it stays open for sync progress
                    if (onSuccess) onSuccess();
                }}
            />
        </>
    );
}

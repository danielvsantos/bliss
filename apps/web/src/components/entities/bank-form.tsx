import { useState, useCallback, useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { useToast } from '@/hooks/use-toast';
import { useTranslation } from 'react-i18next';
import api from '@/lib/api';
import { useQueryClient } from '@tanstack/react-query';
import { usePlaidLink, PlaidLinkOptions, PlaidLinkOnSuccess } from 'react-plaid-link';
import { Loader2 } from 'lucide-react';
import { AccountSelectionModal } from '../account-selection-modal';

// Form schema
const bankSchema = z.object({
    name: z.string().min(2, { message: 'Bank name must be at least 2 characters' }),
});

type BankFormValues = z.infer<typeof bankSchema>;

interface BankFormProps {
    onClose: (refetchNeeded?: boolean) => void;
}

export function BankForm({ onClose }: BankFormProps) {
    const { t } = useTranslation();
    const { toast } = useToast();
    const queryClient = useQueryClient();
    const [isSubmitting, setIsSubmitting] = useState(false);

    // Plaid State
    const [token, setToken] = useState<string | null>(null);
    const [showAccountSelection, setShowAccountSelection] = useState(false);
    const [createdPlaidItemId, setCreatedPlaidItemId] = useState<string | null>(null);

    // Initialize form
    const form = useForm<BankFormValues>({
        resolver: zodResolver(bankSchema),
        defaultValues: {
            name: '',
        },
    });

    const watchedName = form.watch('name');

    // Fetch Link Token on mount
    useEffect(() => {
        const createToken = async () => {
            try {
                const data = await api.createLinkToken();
                setToken(data.link_token);
            } catch (error) {
                console.error('Error creating link token:', error);
                toast({
                    title: 'Error',
                    description: 'Failed to initialize Plaid connection',
                    variant: 'destructive',
                });
            }
        };
        createToken();
    }, [toast]);

    // Handle Manual Save
    const onSaveManual = async (values: BankFormValues) => {
        setIsSubmitting(true);
        try {
            await api.createBank({ name: values.name });
            toast({
                title: 'Bank Created',
                description: 'Bank created successfully.',
            });
            await queryClient.invalidateQueries({ queryKey: ['banks'] }); // Assuming we query banks
            await queryClient.invalidateQueries({ queryKey: ['userPreferences'] }); // Tenant meta often here
            onClose(true);
        } catch (error) {
            console.error('Error creating bank:', error);
            toast({
                title: 'Error',
                description: 'Failed to create bank',
                variant: 'destructive',
            });
        } finally {
            setIsSubmitting(false);
        }
    };

    // Handle Plaid Success
    const onSuccess = useCallback<PlaidLinkOnSuccess>(async (public_token, metadata) => {
        setIsSubmitting(true);
        try {
            // Use the name from the input if provided, otherwise Plaid's
            const bankName = form.getValues('name') || metadata.institution?.name;

            const { plaidItemId } = await api.exchangePublicToken(public_token, metadata, bankName);

            setCreatedPlaidItemId(plaidItemId);
            setShowAccountSelection(true);
            // Don't close yet, wait for Account Selection
        } catch (error) {
            console.error('Error exchanging token:', error);
            toast({
                title: 'Connection Failed',
                description: 'Failed to connect bank account.',
                variant: 'destructive',
            });
            setIsSubmitting(false);
        }
    }, [form, toast]);

    const config: PlaidLinkOptions = {
        token,
        onSuccess,
    };

    const { open, ready } = usePlaidLink(config);

    const handleConnectPlaid = (e: React.MouseEvent) => {
        e.preventDefault(); // Prevent form submit
        if (ready) {
            open();
        }
    };

    // If Account Selection is active, show that instead
    if (showAccountSelection && createdPlaidItemId) {
        return (
            <AccountSelectionModal
                plaidItemId={createdPlaidItemId}
                onClose={() => {
                    onClose(true);
                }}
            />
        );
    }

    return (
        <Form {...form}>
            <form onSubmit={form.handleSubmit(onSaveManual)} className="space-y-6 mt-4">

                <FormField
                    control={form.control}
                    name="name"
                    render={({ field }) => (
                        <FormItem>
                            <FormLabel>Bank Name</FormLabel>
                            <FormControl>
                                <Input placeholder="e.g. Chase, Bank of America" {...field} />
                            </FormControl>
                            <FormMessage />
                        </FormItem>
                    )}
                />

                <div className="flex flex-col gap-3 pt-4">
                    <div className="flex justify-between items-center w-full gap-4">
                        <Button
                            type="button"
                            variant="outline"
                            className="w-full"
                            disabled={isSubmitting || !watchedName} // Require name for manual save? Or allow generic?
                            // Actually manual save usually implies you set the name.
                            onClick={form.handleSubmit(onSaveManual)}
                        >
                            {isSubmitting ? <Loader2 className="animate-spin" /> : 'Save Manually'}
                        </Button>

                        <Button
                            type="button"
                            className="w-full bg-foreground text-background hover:bg-foreground/90"
                            disabled={!ready || isSubmitting}
                            onClick={handleConnectPlaid}
                        >
                            Connect with Plaid
                        </Button>
                    </div>
                    <Button type="button" variant="ghost" onClick={() => onClose()}>
                        Cancel
                    </Button>
                </div>
            </form>
        </Form>
    );
}

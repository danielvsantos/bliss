import { useState, useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
    DialogFooter,
} from "@/components/ui/dialog"
import { Loader2 } from 'lucide-react';

const bankNameSchema = z.object({
    name: z.string().min(2, { message: 'Bank name must be at least 2 characters' }),
});

type BankNameFormValues = z.infer<typeof bankNameSchema>;

interface BankNameModalProps {
    isOpen: boolean;
    onClose: () => void;
    defaultName: string;
    onConfirm: (name: string) => Promise<void>;
}

export function BankNameModal({ isOpen, onClose, defaultName, onConfirm }: BankNameModalProps) {
    const [isSubmitting, setIsSubmitting] = useState(false);

    const form = useForm<BankNameFormValues>({
        resolver: zodResolver(bankNameSchema),
        defaultValues: {
            name: defaultName,
        },
    });

    // Reset form when defaultName changes or modal opens
    useEffect(() => {
        if (isOpen) {
            form.reset({ name: defaultName });
        }
    }, [isOpen, defaultName, form]);

    const onSubmit = async (values: BankNameFormValues) => {
        setIsSubmitting(true);
        try {
            await onConfirm(values.name);
            onClose();
        } catch (error) {
            console.error(error);
            // Parent handles toast/error
        } finally {
            setIsSubmitting(false);
        }
    };

    return (
        <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
            <DialogContent className="sm:max-w-[425px]">
                <DialogHeader>
                    <DialogTitle>New Bank Detected</DialogTitle>
                    <DialogDescription>
                        We detected a new bank. Please confirm the name you'd like to use for it.
                    </DialogDescription>
                </DialogHeader>
                <Form {...form}>
                    <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
                        <FormField
                            control={form.control}
                            name="name"
                            render={({ field }) => (
                                <FormItem>
                                    <FormLabel>Bank Name</FormLabel>
                                    <FormControl>
                                        <Input {...field} />
                                    </FormControl>
                                    <FormMessage />
                                </FormItem>
                            )}
                        />
                        <DialogFooter>
                            <Button type="button" variant="outline" onClick={onClose} disabled={isSubmitting}>Cancel</Button>
                            <Button type="submit" disabled={isSubmitting}>
                                {isSubmitting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : 'Confirm & Connect'}
                            </Button>
                        </DialogFooter>
                    </form>
                </Form>
            </DialogContent>
        </Dialog>
    );
}

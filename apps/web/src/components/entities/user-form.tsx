import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { useToast } from '@/hooks/use-toast';
import { useTranslation } from 'react-i18next';
import api from '@/lib/api';
import type { UserCreateRequest, UserUpdateRequest } from '@/types/api';

interface User {
  id: string;
  email: string;
  createdAt: string;
  tenantId: string;
}

// Form schema
const userSchema = z.object({
  email: z.string().email({ message: 'Please enter a valid email address' }),
});

type UserFormValues = z.infer<typeof userSchema>;

interface UserFormProps {
  user: User | null;
  onClose: (refetchNeeded?: boolean) => void;
}

// Map form values to UserCreateRequest for API
const mapToUserCreateRequest = (values: UserFormValues): UserCreateRequest => ({
  email: values.email,
  password: '',
  // Add other fields as needed (name, profilePictureUrl, etc.)
});

// Map form values to UserUpdateRequest for API
const mapToUserUpdateRequest = (_values: UserFormValues): UserUpdateRequest => ({
  // Only include fields that are editable in the form
  // Add other fields as needed
});

export function UserForm({ user, onClose }: UserFormProps) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Initialize form with user data or empty values
  const form = useForm<UserFormValues>({
    resolver: zodResolver(userSchema),
    defaultValues: {
      email: user?.email || '',
    },
  });

  const onSubmit = async (values: UserFormValues) => {
    setIsSubmitting(true);
    
    try {
      if (user) {
        const apiValues = mapToUserUpdateRequest(values);
        await api.updateUser(user.id, apiValues);
        toast({
          title: t('userForm.userUpdated'),
          description: t('userForm.userUpdatedSuccess'),
        });
      } else {
        const apiValues = mapToUserCreateRequest(values);
        await api.createUser(apiValues);
        toast({
          title: t('userForm.userCreated'),
          description: t('userForm.userCreatedSuccess', { email: values.email }),
        });
      }
      
      onClose(true); // Close and trigger refetch
    } catch (error) {
      console.error('Error submitting form:', error);
      toast({
        title: t('common.error'),
        description: user
          ? t('userForm.updateError')
          : t('userForm.createError'),
        variant: 'destructive',
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4 mt-4">
        <FormField
          control={form.control}
          name="email"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t('userForm.email')}</FormLabel>
              <FormControl>
                <Input 
                  placeholder="user@example.com" 
                  type="email" 
                  {...field} 
                  disabled={!!user} // Disable editing email for existing users
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        {!user && (
          <p className="text-sm text-muted-foreground">
            An invitation will be sent to this email address. The user will need to set their password upon first login.
          </p>
        )}

        <div className="flex justify-end gap-3 pt-4">
          <Button type="button" variant="outline" onClick={() => onClose()}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" disabled={isSubmitting}>
            {isSubmitting ? t('common.saving') : user ? t('userForm.updateUser') : t('userForm.inviteUser')}
          </Button>
        </div>
      </form>
    </Form>
  );
}
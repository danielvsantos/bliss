import { useState, useMemo, useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage, FormDescription } from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useToast } from '@/hooks/use-toast';
import { useTranslation } from 'react-i18next';
import api from '@/lib/api';
import type { Category } from '@/types/api';
import { useQueryClient } from '@tanstack/react-query';
import { useCategories } from '@/hooks/use-metadata';

// ─── Constants ────────────────────────────────────────────────────────────────

// Canonical type list — mirrors ALLOWED_CATEGORY_TYPES in bliss-finance-api/lib/constants.js.
// Hardcoded here intentionally: these types are immutable system values, not derived from data.
const ALLOWED_CATEGORY_TYPES = [
  'Income',
  'Essentials',
  'Lifestyle',
  'Growth',
  'Ventures',
  'Investments',
  'Asset',
  'Debt',
  'Transfers',
] as const;

// ─── Schemas ──────────────────────────────────────────────────────────────────

// Rename mode: default categories — only name and icon can change.
const renameSchema = z.object({
  name: z.string().min(2, { message: 'Name must be at least 2 characters' }),
  icon: z.string().optional(),
});

// Full mode: custom categories — name, type, group, icon.
const fullSchema = z.object({
  name: z.string().min(2, { message: 'Name must be at least 2 characters' }),
  type: z.string().min(1, { message: 'Type is required' }),
  group: z.string().min(1, { message: 'Group is required' }),
  icon: z.string().optional(),
});

type RenameFormValues = z.infer<typeof renameSchema>;
type FullFormValues = z.infer<typeof fullSchema>;

// ─── Props ────────────────────────────────────────────────────────────────────

export type CategoryFormMode = 'create' | 'edit' | 'rename';

interface CategoryFormProps {
  /** Null when creating. Populated for edit/rename. */
  category: Category | null;
  /** 'rename' for default categories (name + icon only), 'edit'/'create' for custom (all fields). */
  mode: CategoryFormMode;
  /** Pre-select a type when opening the form via "Add to [Type]" contextual button. */
  presetType?: string;
  onClose: (refetchNeeded?: boolean) => void;
}

// ─── Rename mode form ─────────────────────────────────────────────────────────

function RenameCategoryForm({
  category,
  onClose,
}: {
  category: Category;
  onClose: (refetchNeeded?: boolean) => void;
}) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [isSubmitting, setIsSubmitting] = useState(false);

  const form = useForm<RenameFormValues>({
    resolver: zodResolver(renameSchema),
    defaultValues: {
      name: category.name,
      icon: category.icon ?? '',
    },
  });

  const onSubmit = async (values: RenameFormValues) => {
    setIsSubmitting(true);
    try {
      await api.updateCategory(category.id, {
        name: values.name,
        icon: values.icon,
        // Keep existing group and type unchanged for default categories
        group: category.group,
        type: category.type,
      });
      toast({
        title: t('categoryForm.categoryUpdated'),
        description: t('categoryForm.categoryUpdatedSuccess'),
      });
      await queryClient.invalidateQueries({ queryKey: ['categories'] });
      onClose(true);
    } catch {
      toast({
        title: t('common.error'),
        description: t('categoryForm.updateError'),
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
          name="name"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t('categoryForm.name')}</FormLabel>
              <FormControl>
                <Input {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="icon"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Icon</FormLabel>
              <FormControl>
                <Input placeholder="e.g. 🍔" {...field} />
              </FormControl>
              <FormDescription className="text-xs">
                Paste any emoji to use as the category icon.
              </FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />

        <div className="flex justify-end gap-3 pt-2">
          <Button type="button" variant="outline" onClick={() => onClose()}>
            {t('ui.cancel')}
          </Button>
          <Button type="submit" disabled={isSubmitting}>
            {isSubmitting ? t('common.saving') : t('ui.saveChanges')}
          </Button>
        </div>
      </form>
    </Form>
  );
}

// ─── Full mode form (create / edit custom category) ───────────────────────────

function FullCategoryForm({
  category,
  presetType,
  onClose,
}: {
  category: Category | null;
  presetType?: string;
  onClose: (refetchNeeded?: boolean) => void;
}) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [customGroup, setCustomGroup] = useState(false);

  // All existing categories — used to derive group options filtered by selected type
  const { data: allCategories = [] } = useCategories();

  const form = useForm<FullFormValues>({
    resolver: zodResolver(fullSchema),
    defaultValues: {
      name: category?.name ?? '',
      type: category?.type ?? presetType ?? '',
      group: category?.group ?? '',
      icon: category?.icon ?? '',
    },
  });

  const selectedType = form.watch('type');

  // When type changes, clear the group selection so the dropdown refreshes
  const prevType = useMemo(() => category?.type ?? presetType ?? '', [category, presetType]);
  useEffect(() => {
    if (selectedType && selectedType !== prevType) {
      form.setValue('group', '');
      setCustomGroup(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedType]);

  // Groups scoped to the currently selected type
  const groupOptions = useMemo(() => {
    if (!selectedType) return [];
    return Array.from(
      new Set(allCategories.filter((c) => c.type === selectedType).map((c) => c.group))
    ).sort();
  }, [allCategories, selectedType]);

  // Check if the category being edited has a custom group not in the scoped list
  const hasInitialCustomGroup =
    !!category?.group &&
    groupOptions.length > 0 &&
    !groupOptions.includes(category.group);

  useEffect(() => {
    if (hasInitialCustomGroup) setCustomGroup(true);
  }, [hasInitialCustomGroup]);

  const onSubmit = async (values: FullFormValues) => {
    setIsSubmitting(true);
    try {
      if (category) {
        await api.updateCategory(category.id, {
          name: values.name,
          type: values.type,
          group: values.group,
          icon: values.icon,
        });
        toast({
          title: t('categoryForm.categoryUpdated'),
          description: t('categoryForm.categoryUpdatedSuccess'),
        });
      } else {
        await api.createCategory({
          name: values.name,
          type: values.type,
          group: values.group,
          icon: values.icon,
        });
        toast({
          title: t('categoryForm.categoryCreated'),
          description: t('categoryForm.categoryCreatedSuccess', { name: values.name }),
        });
      }
      await queryClient.invalidateQueries({ queryKey: ['categories'] });
      onClose(true);
    } catch {
      toast({
        title: t('common.error'),
        description: category ? t('categoryForm.updateError') : t('categoryForm.createError'),
        variant: 'destructive',
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4 mt-4">
        {/* Name */}
        <FormField
          control={form.control}
          name="name"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t('categoryForm.name')}</FormLabel>
              <FormControl>
                <Input placeholder="e.g. Groceries, Salary, Rent" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        {/* Type — hardcoded canonical list, never derived from data */}
        <FormField
          control={form.control}
          name="type"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t('categoryForm.type')}</FormLabel>
              <Select onValueChange={field.onChange} value={field.value}>
                <FormControl>
                  <SelectTrigger>
                    <SelectValue placeholder="Select type" />
                  </SelectTrigger>
                </FormControl>
                <SelectContent>
                  {ALLOWED_CATEGORY_TYPES.map((type) => (
                    <SelectItem key={type} value={type}>
                      {type}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FormMessage />
            </FormItem>
          )}
        />

        {/* Group — filtered by selected type, or free-text for new group */}
        {customGroup ? (
          <FormField
            control={form.control}
            name="group"
            render={({ field }) => (
              <FormItem>
                <FormLabel>{t('categoryForm.group')}</FormLabel>
                <div className="flex gap-2">
                  <FormControl className="flex-grow">
                    <Input placeholder="Enter new group name" {...field} />
                  </FormControl>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => {
                      form.setValue('group', '');
                      setCustomGroup(false);
                    }}
                  >
                    {t('ui.cancel')}
                  </Button>
                </div>
                <FormMessage />
              </FormItem>
            )}
          />
        ) : (
          <FormField
            control={form.control}
            name="group"
            render={({ field }) => (
              <FormItem>
                <FormLabel>{t('categoryForm.group')}</FormLabel>
                <Select
                  onValueChange={(value) => {
                    if (value === '__create_new__') {
                      setCustomGroup(true);
                      form.setValue('group', '');
                    } else {
                      field.onChange(value);
                    }
                  }}
                  value={field.value}
                  disabled={!selectedType}
                >
                  <FormControl>
                    <SelectTrigger>
                      <SelectValue
                        placeholder={
                          selectedType ? 'Select group' : 'Select a type first'
                        }
                      />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    {groupOptions.map((group) => (
                      <SelectItem key={group} value={group}>
                        {group}
                      </SelectItem>
                    ))}
                    <SelectItem value="__create_new__">
                      + Create new group…
                    </SelectItem>
                  </SelectContent>
                </Select>
                <FormMessage />
              </FormItem>
            )}
          />
        )}

        {/* Icon — optional emoji */}
        <FormField
          control={form.control}
          name="icon"
          render={({ field }) => (
            <FormItem>
              <FormLabel>
                Icon{' '}
                <span className="text-muted-foreground font-normal text-xs">(optional)</span>
              </FormLabel>
              <FormControl>
                <Input placeholder="e.g. 🍔" {...field} />
              </FormControl>
              <FormDescription className="text-xs">
                Paste any emoji to use as the category icon.
              </FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />

        <div className="flex justify-end gap-3 pt-2">
          <Button type="button" variant="outline" onClick={() => onClose()}>
            {t('ui.cancel')}
          </Button>
          <Button type="submit" disabled={isSubmitting}>
            {isSubmitting
              ? t('common.saving')
              : category
              ? t('ui.saveChanges')
              : t('categoryForm.createCategory')}
          </Button>
        </div>
      </form>
    </Form>
  );
}

// ─── Public export — delegates to the correct sub-form based on mode ──────────

export function CategoryForm({ category, mode, presetType, onClose }: CategoryFormProps) {
  if (mode === 'rename' && category) {
    return <RenameCategoryForm category={category} onClose={onClose} />;
  }
  return (
    <FullCategoryForm category={category} presetType={presetType} onClose={onClose} />
  );
}

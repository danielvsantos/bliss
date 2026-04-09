import { useState, useMemo, useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator } from '@/components/ui/dropdown-menu';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { PlusIcon, SearchIcon, TagIcon, LockIcon, MoreHorizontalIcon } from 'lucide-react';
import { CategoryForm } from '@/components/entities/category-form';
import { useToast } from '@/hooks/use-toast';
import { useTranslation } from 'react-i18next';
import { translateCategoryName, translateCategoryGroup, translateCategoryType } from '@/lib/category-i18n';
import { api } from '@/lib/api';
import { metadataKeys } from '@/hooks/use-metadata';
import type { Category } from '@/types/api';

// ─── Constants ────────────────────────────────────────────────────────────────

// Canonical type list — mirrors ALLOWED_CATEGORY_TYPES in bliss-finance-api/lib/constants.js.
// Order here determines the accordion display order on the page.
const CATEGORY_TYPES = [
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

// Left-border design token per type — all use Bliss semantic tokens (never raw Tailwind colors).
const TYPE_BORDER: Record<string, string> = {
  'Income':       'border-l-positive',
  'Essentials':   'border-l-negative',
  'Lifestyle':    'border-l-warning',
  'Growth':       'border-l-brand-primary',
  'Ventures':     'border-l-dataviz-5',
  'Investments':  'border-l-brand-primary',
  'Asset':        'border-l-brand-deep',
  'Debt':         'border-l-destructive',
  'Transfers':    'border-l-muted-foreground',
};

// ─── processingHint → badge style ─────────────────────────────────────────────
// View-only badges that tell the user whether a category is backed by a live
// price API, has special system tracking, or is manually updated.
// processingHint is never editable by the user. Labels are translated via i18n.
const PROCESSING_HINT_STYLE: Record<string, string> = {
  API_STOCK:        'bg-positive/10 text-positive border-positive/20',
  API_CRYPTO:       'bg-positive/10 text-positive border-positive/20',
  AMORTIZING_LOAN:  'bg-brand-primary/10 text-brand-primary border-brand-primary/20',
  SIMPLE_LIABILITY: 'bg-brand-primary/10 text-brand-primary border-brand-primary/20',
  CASH:             'bg-brand-primary/10 text-brand-primary border-brand-primary/20',
  MANUAL:           'bg-muted text-muted-foreground border-border',
  TAX_DEDUCTIBLE:   'bg-warning/10 text-warning border-warning/20',
  DEBT:             'bg-brand-primary/10 text-brand-primary border-brand-primary/20',
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function isDefaultCategory(cat: Category): boolean {
  return cat.defaultCategoryCode != null;
}

function ProcessingHintBadge({ hint }: { hint: string }) {
  const { t } = useTranslation();
  const className = PROCESSING_HINT_STYLE[hint];
  if (!className) return null;
  return (
    <Badge
      variant="outline"
      className={`text-[10px] font-medium px-1.5 py-0 shrink-0 ${className}`}
    >
      {t(`defaultCategories.processingHints.${hint}`, hint)}
    </Badge>
  );
}

// ─── Category Row ─────────────────────────────────────────────────────────────

interface CategoryRowProps {
  category: Category;
  searchQuery: string;
  onRename: (cat: Category) => void;
  onEdit: (cat: Category) => void;
  onDelete: (cat: Category) => void;
}

function CategoryRow({ category, searchQuery, onRename, onEdit, onDelete }: CategoryRowProps) {
  const { t } = useTranslation();
  const isDefault = isDefaultCategory(category);
  const txCount = category._count?.transactions ?? 0;

  // Dim rows that don't match the current search (match both original and translated names)
  const q = searchQuery.toLowerCase();
  const matchesSearch =
    !searchQuery ||
    category.name.toLowerCase().includes(q) ||
    category.group.toLowerCase().includes(q) ||
    category.type.toLowerCase().includes(q) ||
    translateCategoryName(t, category).toLowerCase().includes(q) ||
    translateCategoryGroup(t, category.group).toLowerCase().includes(q) ||
    translateCategoryType(t, category.type).toLowerCase().includes(q);

  return (
    <div
      className={`flex items-center gap-3 px-4 py-2.5 rounded-md transition-opacity ${
        matchesSearch ? 'opacity-100' : 'opacity-30'
      }`}
    >
      {/* Emoji icon or fallback */}
      <span className="text-lg w-7 text-center shrink-0 leading-none">
        {category.icon ?? <TagIcon className="h-4 w-4 text-muted-foreground" />}
      </span>

      {/* Name + badges */}
      <div className="flex flex-1 items-center gap-2 min-w-0 flex-wrap">
        <span className="text-sm font-medium truncate">{translateCategoryName(t, category)}</span>

        {/* Default / system lock badge */}
        {isDefault && (
          <Tooltip>
            <TooltipTrigger asChild>
              {/* span wrapper required: Badge is not a forwardRef component, so
                  TooltipTrigger's asChild cannot attach a ref to it directly. */}
              <span>
                <Badge
                  variant="outline"
                  className="text-[10px] font-medium px-1.5 py-0 shrink-0 bg-brand-primary/10 text-brand-primary border-brand-primary/20 cursor-default gap-1"
                >
                  <LockIcon className="h-2.5 w-2.5" />
                  {t('categoriesPage.defaultBadge')}
                </Badge>
              </span>
            </TooltipTrigger>
            <TooltipContent side="top">
              <p className="text-xs max-w-[220px]">
                {t('categoriesPage.systemHint')}
              </p>
            </TooltipContent>
          </Tooltip>
        )}

        {/* Integration / processingHint badge — purely informational */}
        {category.processingHint && (
          <ProcessingHintBadge hint={category.processingHint} />
        )}
      </div>

      {/* Transaction count */}
      {txCount > 0 && (
        <span className="text-xs text-muted-foreground shrink-0 tabular-nums">
          {txCount} {txCount === 1 ? t('categoriesPage.transaction') : t('categoriesPage.transactions')}
        </span>
      )}

      {/* Context menu — modal={false} prevents pointer-events race condition
          when a DropdownMenuItem opens a Dialog (both manage body pointer-events). */}
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0">
            <MoreHorizontalIcon className="h-4 w-4" />
            <span className="sr-only">{t('categoriesPage.categoryOptions')}</span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {isDefault ? (
            // Default categories: rename only
            <DropdownMenuItem onClick={() => onRename(category)}>
              {t('ui.rename')}
            </DropdownMenuItem>
          ) : (
            // Custom categories: full edit + delete
            <>
              <DropdownMenuItem onClick={() => onEdit(category)}>
                {t('ui.edit')}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={() => onDelete(category)}
                className="text-destructive focus:text-destructive"
              >
                {t('ui.delete')}
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

// ─── Type Accordion Section ───────────────────────────────────────────────────

interface TypeSectionProps {
  type: string;
  categories: Category[];
  searchQuery: string;
  onRename: (cat: Category) => void;
  onEdit: (cat: Category) => void;
  onDelete: (cat: Category) => void;
  onAddToType: (type: string) => void;
}

function TypeSection({
  type,
  categories,
  searchQuery,
  onRename,
  onEdit,
  onDelete,
  onAddToType,
}: TypeSectionProps) {
  const { t } = useTranslation();
  const borderClass = TYPE_BORDER[type] ?? 'border-l-muted-foreground';

  // Group categories by their group field, sorted alphabetically
  const byGroup = useMemo(() => {
    const map = new Map<string, Category[]>();
    const sorted = [...categories].sort((a, b) => {
      if (a.group < b.group) return -1;
      if (a.group > b.group) return 1;
      return a.name.localeCompare(b.name);
    });
    for (const cat of sorted) {
      const existing = map.get(cat.group) ?? [];
      existing.push(cat);
      map.set(cat.group, existing);
    }
    return map;
  }, [categories]);

  // When searching, auto-open the section if it has any matches (original + translated)
  const sq = searchQuery.toLowerCase();
  const hasMatches =
    !searchQuery ||
    categories.some(
      (c) =>
        c.name.toLowerCase().includes(sq) ||
        c.group.toLowerCase().includes(sq) ||
        c.type.toLowerCase().includes(sq) ||
        translateCategoryName(t, c).toLowerCase().includes(sq) ||
        translateCategoryGroup(t, c.group).toLowerCase().includes(sq) ||
        translateCategoryType(t, c.type).toLowerCase().includes(sq)
    );

  if (!hasMatches && searchQuery) return null;

  return (
    <AccordionItem
      value={type}
      className={`rounded-lg border border-border bg-card border-l-4 ${borderClass} overflow-hidden`}
    >
      <AccordionTrigger className="px-5 py-3.5 hover:no-underline hover:bg-muted/40 transition-colors [&[data-state=open]]:bg-muted/20">
        <div className="flex items-center gap-3">
          <span className="font-semibold text-sm">{translateCategoryType(t, type)}</span>
          <Badge
            variant="secondary"
            className="text-[10px] font-medium px-1.5 py-0 bg-muted text-muted-foreground"
          >
            {categories.length}
          </Badge>
        </div>
      </AccordionTrigger>

      <AccordionContent className="pb-0">
        <div className="border-t border-border">
          {Array.from(byGroup.entries()).map(([group, groupCats]) => (
            <div key={group}>
              {/* Group subheading */}
              <div className="px-5 pt-3 pb-1">
                <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  {translateCategoryGroup(t, group)}
                </span>
              </div>

              {/* Category rows */}
              <div className="px-2 pb-1">
                {groupCats.map((cat) => (
                  <CategoryRow
                    key={cat.id}
                    category={cat}
                    searchQuery={searchQuery}
                    onRename={onRename}
                    onEdit={onEdit}
                    onDelete={onDelete}
                  />
                ))}
              </div>
            </div>
          ))}

          {/* Contextual add button */}
          <div className="px-4 py-3 border-t border-border/50">
            <Button
              variant="ghost"
              size="sm"
              className="text-muted-foreground hover:text-foreground gap-1.5 text-xs h-7"
              onClick={() => onAddToType(type)}
            >
              <PlusIcon className="h-3 w-3" />
              {t('categoriesPage.addTo', { type: translateCategoryType(t, type) })}
            </Button>
          </div>
        </div>
      </AccordionContent>
    </AccordionItem>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

type FormMode = 'create' | 'edit' | 'rename';

export default function CategoriesPage() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [searchQuery, setSearchQuery] = useState('');

  // Accordion open state — starts closed; expands to matching sections when searching
  const [openSections, setOpenSections] = useState<string[]>([]);

  // Form state
  const [showForm, setShowForm] = useState(false);
  const [formMode, setFormMode] = useState<FormMode>('create');
  const [selectedCategory, setSelectedCategory] = useState<Category | null>(null);
  const [presetType, setPresetType] = useState<string | undefined>(undefined);

  // Delete state
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [categoryToDelete, setCategoryToDelete] = useState<Category | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [mergeRequired, setMergeRequired] = useState(false);
  const [mergeTransactionCount, setMergeTransactionCount] = useState(0);
  const [mergeTargetId, setMergeTargetId] = useState<number | null>(null);

  // Fetch all categories
  const {
    data: categories = [],
    isLoading,
    error,
    refetch,
  } = useQuery({
    queryKey: ['categories'],
    queryFn: async () => {
      const res = await api.getCategories();
      return res.categories as Category[];
    },
  });

  // ── Derived data ──────────────────────────────────────────────────────────

  // All categories (default + custom) grouped by type.
  // Custom categories have no Default badge but live in the same accordion sections.
  const byType = useMemo(() => {
    const map = new Map<string, Category[]>();
    for (const cat of categories) {
      const list = map.get(cat.type) ?? [];
      list.push(cat);
      map.set(cat.type, list);
    }
    return map;
  }, [categories]);

  // When searching, expand sections that have matches; clear search → collapse all back
  useEffect(() => {
    if (!searchQuery) {
      setOpenSections([]);
    } else {
      const sq = searchQuery.toLowerCase();
      const matches = CATEGORY_TYPES.filter((type) => {
        const cats = byType.get(type) ?? [];
        return cats.some(
          (c) =>
            c.name.toLowerCase().includes(sq) ||
            c.group.toLowerCase().includes(sq) ||
            translateCategoryName(t, c).toLowerCase().includes(sq) ||
            translateCategoryGroup(t, c.group).toLowerCase().includes(sq)
        );
      });
      setOpenSections(matches);
    }
  }, [searchQuery, byType, t]);

  // ── Handlers ──────────────────────────────────────────────────────────────

  const openCreate = () => {
    setSelectedCategory(null);
    setPresetType(undefined);
    setFormMode('create');
    setShowForm(true);
  };

  const openAddToType = (type: string) => {
    setSelectedCategory(null);
    setPresetType(type);
    setFormMode('create');
    setShowForm(true);
  };

  const openRename = (cat: Category) => {
    setSelectedCategory(cat);
    setFormMode('rename');
    setShowForm(true);
  };

  const openEdit = (cat: Category) => {
    setSelectedCategory(cat);
    setFormMode('edit');
    setShowForm(true);
  };

  const openDelete = (cat: Category) => {
    setCategoryToDelete(cat);
    setMergeRequired(false);
    setMergeTransactionCount(0);
    setMergeTargetId(null);
    setShowDeleteConfirm(true);
  };

  const closeForm = async (refetchNeeded = false) => {
    setShowForm(false);
    if (refetchNeeded) {
      await queryClient.invalidateQueries({ queryKey: metadataKeys.all });
      await refetch();
    }
  };

  const handleDeleteCategory = async () => {
    if (!categoryToDelete) return;

    setIsDeleting(true);
    try {
      await api.deleteCategory(categoryToDelete.id, mergeTargetId ?? undefined);
      toast({
        title: t('notifications.success.deleted'),
        description: mergeTargetId
          ? t('categoriesPage.deletedAndReassigned', { name: categoryToDelete.name, count: mergeTransactionCount })
          : `${categoryToDelete.name} ${t('pages.categories.hasBeenRemoved')}`,
      });
      setShowDeleteConfirm(false);
      await queryClient.invalidateQueries({ queryKey: metadataKeys.all });
      await refetch();
    } catch (err) {
      // API returns requiresMerge when category has transactions
      const data = (err as { response?: { data?: { requiresMerge?: boolean; transactionCount?: number } } })?.response?.data;
      if (data?.requiresMerge) {
        setMergeRequired(true);
        setMergeTransactionCount(data.transactionCount || 0);
        return;
      }
      const errorMessage =
        err instanceof Error ? err.message : t('notifications.error.deleteCategory');
      toast({
        title: t('notifications.error.title'),
        description: errorMessage,
        variant: 'destructive',
      });
    } finally {
      setIsDeleting(false);
    }
  };

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="p-6 space-y-6">
      {/* Page header */}
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">{t('nav.categories')}</h1>
          <p className="text-muted-foreground">{t('pages.categories.subtitle')}</p>
        </div>
        <Button onClick={openCreate} className="flex items-center gap-1.5">
          <PlusIcon className="h-4 w-4" />
          <span>{t('pages.categories.addCategory')}</span>
        </Button>
      </div>

      <Separator />

      {/* Search bar */}
      <div className="relative max-w-sm">
        <SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          placeholder={`${t('common.search')}...`}
          className="pl-9"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
        />
      </div>

      {/* Loading skeleton */}
      {isLoading && (
        <div className="animate-pulse space-y-3">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="h-14 bg-muted rounded-lg" />
          ))}
        </div>
      )}

      {/* Error state */}
      {error && (
        <div className="bg-muted py-10 rounded-lg text-center">
          <h3 className="text-lg font-medium">{t('notifications.error.general')}</h3>
          <p className="text-muted-foreground mt-2">{t('notifications.error.network')}</p>
          <Button variant="outline" className="mt-4" onClick={() => refetch()}>
            {t('ui.retry')}
          </Button>
        </div>
      )}

      {/* Accordion — all categories (default + custom) grouped by type */}
      {!isLoading && !error && (
        <Accordion
          type="multiple"
          value={openSections}
          onValueChange={setOpenSections}
          className="space-y-2"
        >
          {CATEGORY_TYPES.map((type) => {
            const cats = byType.get(type) ?? [];
            if (cats.length === 0 && !searchQuery) return null;
            return (
              <TypeSection
                key={type}
                type={type}
                categories={cats}
                searchQuery={searchQuery}
                onRename={openRename}
                onEdit={openEdit}
                onDelete={openDelete}
                onAddToType={openAddToType}
              />
            );
          })}
        </Accordion>
      )}

      {/* ── Dialogs ────────────────────────────────────────────────────────── */}

      {/* Category form dialog (create / edit / rename) */}
      <Dialog open={showForm} onOpenChange={setShowForm}>
        <DialogContent className="sm:max-w-[440px]">
          <DialogHeader>
            <DialogTitle>
              {formMode === 'create'
                ? t('pages.categories.addCategory')
                : formMode === 'rename'
                ? t('pages.categories.renameCategory')
                : t('pages.categories.editCategory')}
            </DialogTitle>
            <DialogDescription>
              {formMode === 'rename'
                ? t('pages.categories.renameDescription')
                : formMode === 'create'
                ? t('pages.categories.addNewDescription')
                : t('pages.categories.updateDetails')}
            </DialogDescription>
          </DialogHeader>
          <CategoryForm
            category={selectedCategory}
            mode={formMode}
            presetType={presetType}
            onClose={closeForm}
          />
        </DialogContent>
      </Dialog>

      {/* Delete confirmation dialog */}
      <Dialog open={showDeleteConfirm} onOpenChange={setShowDeleteConfirm}>
        <DialogContent className="sm:max-w-[425px]">
          <DialogHeader>
            <DialogTitle>
              {mergeRequired ? t('categoriesPage.reassignAndDelete') : t('ui.dialog.deleteTitle', { entity: t('ui.entity.category') })}
            </DialogTitle>
            <DialogDescription>
              {mergeRequired
                ? t('categoriesPage.reassignMessage', { name: categoryToDelete?.name, count: mergeTransactionCount })
                : t('ui.dialog.deleteConfirmation', { name: categoryToDelete?.name })}
            </DialogDescription>
          </DialogHeader>
          {mergeRequired && (
            <div className="py-2">
              <Select
                value={mergeTargetId?.toString() ?? ''}
                onValueChange={(val) => setMergeTargetId(parseInt(val, 10))}
              >
                <SelectTrigger>
                  <SelectValue placeholder={t('categoriesPage.selectTargetCategory')} />
                </SelectTrigger>
                <SelectContent>
                  {categories
                    .filter((c) => c.id !== categoryToDelete?.id)
                    .map((c) => (
                      <SelectItem key={c.id} value={c.id.toString()}>
                        {c.name}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowDeleteConfirm(false)}>
              {t('ui.cancel')}
            </Button>
            <Button
              variant="destructive"
              onClick={handleDeleteCategory}
              disabled={isDeleting || (mergeRequired && !mergeTargetId)}
            >
              {isDeleting
                ? t('ui.deleting')
                : mergeRequired
                  ? t('categoriesPage.deleteAndReassign')
                  : t('ui.delete')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

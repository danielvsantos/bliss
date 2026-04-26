import type { TFunction } from 'i18next';

interface CategoryLike {
  name: string;
  defaultCategoryCode?: string | null;
  description?: string | null;
}

/**
 * Translate a system category name using its defaultCategoryCode as i18n key.
 * Custom categories (code = null) are returned as-is since users created them in their own language.
 */
export function translateCategoryName(t: TFunction, category: CategoryLike): string {
  if (category.defaultCategoryCode) {
    return t(`defaultCategories.names.${category.defaultCategoryCode}`, category.name);
  }
  return category.name;
}

/**
 * Translate a category group label (e.g. "Housing", "Dining Out").
 * Falls back to the raw group string if no translation key exists.
 */
export function translateCategoryGroup(t: TFunction, group: string): string {
  return t(`defaultCategories.groups.${group}`, group);
}

/**
 * Translate a category type label (e.g. "Income", "Essentials").
 * Falls back to the raw type string if no translation key exists.
 */
export function translateCategoryType(t: TFunction, type: string): string {
  return t(`defaultCategories.types.${type}`, type);
}

/**
 * Resolve the description for a category:
 *   1. Default categories: prefer the i18n key keyed by defaultCategoryCode.
 *   2. Custom categories (or default categories without an i18n description):
 *      fall back to the user-entered `description` column.
 *   3. Otherwise return an empty string.
 */
export function translateCategoryDescription(t: TFunction, category: CategoryLike): string {
  const fallback = category.description ?? '';
  if (category.defaultCategoryCode) {
    return t(`defaultCategories.descriptions.${category.defaultCategoryCode}`, fallback);
  }
  return fallback;
}

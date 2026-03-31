import { useState, useMemo } from "react";
import { Check, ChevronsUpDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import type { Category } from "@/types/api";

const TYPE_ORDER = [
  "Income",
  "Essentials",
  "Lifestyle",
  "Growth",
  "Ventures",
  "Investments",
  "Asset",
  "Debt",
  "Transfers",
];

interface CategoryComboboxProps {
  categories: Category[];
  value: number | undefined;
  onChange: (categoryId: number) => void;
}

export function CategoryCombobox({
  categories,
  value,
  onChange,
}: CategoryComboboxProps) {
  const [open, setOpen] = useState(false);

  const selectedCategory = useMemo(
    () => categories.find((c) => c.id === value),
    [categories, value]
  );

  // Group categories by type, ordered by TYPE_ORDER
  const groupedCategories = useMemo(() => {
    const groups = new Map<string, Category[]>();

    // Initialize groups in order
    TYPE_ORDER.forEach((type) => groups.set(type, []));

    // Fill groups
    categories.forEach((cat) => {
      const existing = groups.get(cat.type);
      if (existing) {
        existing.push(cat);
      } else {
        // Unknown type — append at end
        groups.set(cat.type, [cat]);
      }
    });

    // Sort categories within each group alphabetically
    groups.forEach((cats) => cats.sort((a, b) => a.name.localeCompare(b.name)));

    // Filter out empty groups
    return Array.from(groups.entries()).filter(([, cats]) => cats.length > 0);
  }, [categories]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className="h-11 w-full justify-between bg-input-background border-border rounded-xl text-[0.9375rem] font-normal px-3.5 hover:bg-input-background"
        >
          <span
            className={cn(
              "truncate",
              !selectedCategory && "text-muted-foreground"
            )}
          >
            {selectedCategory
              ? `${selectedCategory.icon ? selectedCategory.icon + " " : ""}${selectedCategory.name}`
              : "Search categories..."}
          </span>
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className="w-[var(--radix-popover-trigger-width)] p-0"
        align="start"
      >
        <Command className="rounded-lg overflow-visible">
          <CommandInput placeholder="Search categories..." />
          <CommandList
            style={{ maxHeight: 280, overscrollBehavior: 'contain' }}
          >
            <CommandEmpty>No categories found.</CommandEmpty>
            {groupedCategories.map(([type, cats]) => (
              <CommandGroup key={type} heading={type}>
                {cats.map((cat) => {
                  const isSelected = cat.id === value;
                  return (
                    <CommandItem
                      key={cat.id}
                      value={`${cat.name} ${cat.group} ${cat.type}`}
                      onSelect={() => {
                        onChange(cat.id);
                        setOpen(false);
                      }}
                    >
                      <Check
                        className={cn(
                          "mr-2 h-4 w-4",
                          isSelected ? "opacity-100" : "opacity-0"
                        )}
                      />
                      <span className="flex-1 flex items-center gap-2 min-w-0">
                        {cat.icon && (
                          <span className="text-base shrink-0">
                            {cat.icon}
                          </span>
                        )}
                        <span className="truncate">{cat.name}</span>
                      </span>
                      <span className="text-xs text-muted-foreground ml-2 shrink-0">
                        {cat.group}
                      </span>
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

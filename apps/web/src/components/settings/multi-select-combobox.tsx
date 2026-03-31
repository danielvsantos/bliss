import { useState } from "react";
import { Check, ChevronsUpDown, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
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

export interface ComboboxOption {
  value: string;
  label: string;
  icon?: string;
}

interface MultiSelectComboboxProps {
  label: string;
  hint?: string;
  selected: string[];
  onSelectionChange: (selected: string[]) => void;
  options: ComboboxOption[];
  placeholder?: string;
  searchPlaceholder?: string;
  maxHeight?: number;
  /** Render a custom element inside each selected pill (e.g. Plaid link icon) */
  renderPillExtra?: (value: string) => React.ReactNode;
}

export function MultiSelectCombobox({
  label,
  hint,
  selected,
  onSelectionChange,
  options,
  placeholder = "Select items...",
  searchPlaceholder = "Search...",
  maxHeight = 280,
  renderPillExtra,
}: MultiSelectComboboxProps) {
  const [open, setOpen] = useState(false);

  const toggleItem = (value: string) => {
    if (selected.includes(value)) {
      onSelectionChange(selected.filter((v) => v !== value));
    } else {
      onSelectionChange([...selected, value]);
    }
  };

  const removeItem = (value: string) => {
    onSelectionChange(selected.filter((v) => v !== value));
  };

  const selectedCount = selected.length;

  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-sm font-medium text-foreground tracking-[0.005em]">
        {label}
      </label>

      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            role="combobox"
            aria-expanded={open}
            className="h-11 w-full justify-between bg-input-background border-border rounded-xl text-[0.9375rem] font-normal px-3.5 hover:bg-input-background"
          >
            <span className={cn("truncate", selectedCount === 0 && "text-muted-foreground")}>
              {selectedCount > 0
                ? `${selectedCount} selected`
                : placeholder}
            </span>
            <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-[var(--radix-popover-trigger-width)] p-0" align="start">
          <Command>
            <CommandInput placeholder={searchPlaceholder} />
            <CommandList style={{ maxHeight }}>
              <CommandEmpty>No results found.</CommandEmpty>
              <CommandGroup>
                {options.map((option) => {
                  const isSelected = selected.includes(option.value);
                  return (
                    <CommandItem
                      key={option.value}
                      value={`${option.label} ${option.value}`}
                      onSelect={() => toggleItem(option.value)}
                    >
                      <div
                        className={cn(
                          "flex h-4 w-4 items-center justify-center rounded border border-border",
                          isSelected && "bg-primary border-primary",
                        )}
                      >
                        {isSelected && <Check className="h-3 w-3 text-primary-foreground" />}
                      </div>
                      {option.icon && <span className="text-base">{option.icon}</span>}
                      <span className="truncate">{option.label}</span>
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>

      {/* Selected pills */}
      {selectedCount > 0 && (
        <div className="flex flex-wrap gap-1.5 mt-1">
          {selected.map((value) => {
            const option = options.find((o) => o.value === value);
            if (!option) return null;
            return (
              <Badge
                key={value}
                variant="secondary"
                className="flex items-center gap-1 px-2.5 py-1 text-xs"
              >
                {option.icon && <span>{option.icon}</span>}
                <span>{option.label}</span>
                {renderPillExtra?.(value)}
                <button
                  type="button"
                  className="ml-1 rounded-full hover:text-destructive focus:outline-none"
                  onClick={() => removeItem(value)}
                >
                  <X className="h-3 w-3" />
                </button>
              </Badge>
            );
          })}
        </div>
      )}

      {hint && (
        <p className="text-xs text-muted-foreground leading-relaxed">{hint}</p>
      )}
    </div>
  );
}

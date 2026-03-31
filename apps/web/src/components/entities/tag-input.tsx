import { useState } from "react";
import { Check, ChevronsUpDown, Plus, X } from "lucide-react";
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
import { useTags, useCreateTag } from "@/hooks/use-tags";

interface TagInputProps {
  selectedTagIds: number[];
  onChange: (tagIds: number[]) => void;
}

export function TagInput({ selectedTagIds, onChange }: TagInputProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const { data: tags = [] } = useTags();
  const createTag = useCreateTag();

  const toggleTag = (tagId: number) => {
    if (selectedTagIds.includes(tagId)) {
      onChange(selectedTagIds.filter((id) => id !== tagId));
    } else {
      onChange([...selectedTagIds, tagId]);
    }
  };

  const removeTag = (tagId: number) => {
    onChange(selectedTagIds.filter((id) => id !== tagId));
  };

  const handleCreateTag = async () => {
    const trimmed = search.trim();
    if (!trimmed) return;

    try {
      const newTag = await createTag.mutateAsync({ name: trimmed });
      onChange([...selectedTagIds, newTag.id]);
      setSearch("");
    } catch {
      // Tag creation failed (e.g. duplicate name) — silently ignored
    }
  };

  const selectedCount = selectedTagIds.length;

  // Check if the current search term matches any existing tag exactly
  const exactMatch = tags.some(
    (t) => t.name.toLowerCase() === search.trim().toLowerCase()
  );

  return (
    <div className="flex flex-col gap-1.5">
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
                selectedCount === 0 && "text-muted-foreground"
              )}
            >
              {selectedCount > 0
                ? `${selectedCount} tag${selectedCount !== 1 ? "s" : ""} selected`
                : "Select tags..."}
            </span>
            <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          className="w-[var(--radix-popover-trigger-width)] p-0"
          align="start"
        >
          <Command shouldFilter={true} className="overflow-visible">
            <CommandInput
              placeholder="Search or create tags..."
              value={search}
              onValueChange={setSearch}
            />
            <CommandList style={{ maxHeight: 200, overscrollBehavior: 'contain' }}>
              <CommandEmpty>
                {search.trim() && !exactMatch ? (
                  <button
                    type="button"
                    className="flex w-full items-center gap-2 px-2 py-1.5 text-sm cursor-pointer hover:bg-accent rounded-sm"
                    onClick={handleCreateTag}
                    disabled={createTag.isPending}
                  >
                    <Plus className="h-4 w-4" />
                    <span>
                      Create &ldquo;{search.trim()}&rdquo;
                    </span>
                  </button>
                ) : (
                  "No tags found."
                )}
              </CommandEmpty>
              <CommandGroup>
                {tags.map((tag) => {
                  const isSelected = selectedTagIds.includes(tag.id);
                  return (
                    <CommandItem
                      key={tag.id}
                      value={tag.name}
                      onSelect={() => toggleTag(tag.id)}
                    >
                      <div
                        className={cn(
                          "flex h-4 w-4 items-center justify-center rounded border border-border shrink-0",
                          isSelected && "bg-primary border-primary"
                        )}
                      >
                        {isSelected && (
                          <Check className="h-3 w-3 text-primary-foreground" />
                        )}
                      </div>
                      {tag.emoji && (
                        <span className="text-base">{tag.emoji}</span>
                      )}
                      <span className="truncate">{tag.name}</span>
                    </CommandItem>
                  );
                })}
              </CommandGroup>
              {/* Show create option even when there are results but no exact match */}
              {search.trim() && !exactMatch && tags.length > 0 && (
                <CommandGroup>
                  <CommandItem
                    value={`create-${search.trim()}`}
                    onSelect={handleCreateTag}
                    disabled={createTag.isPending}
                  >
                    <Plus className="h-4 w-4" />
                    <span>
                      Create &ldquo;{search.trim()}&rdquo;
                    </span>
                  </CommandItem>
                </CommandGroup>
              )}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>

      {/* Selected tag pills */}
      {selectedCount > 0 && (
        <div className="flex flex-wrap gap-1.5 mt-1">
          {selectedTagIds.map((tagId) => {
            const tag = tags.find((t) => t.id === tagId);
            if (!tag) return null;
            return (
              <Badge
                key={tagId}
                variant="secondary"
                className="flex items-center gap-1 px-2.5 py-1 text-xs"
              >
                {tag.emoji && <span>{tag.emoji}</span>}
                <span>{tag.name}</span>
                <button
                  type="button"
                  className="ml-1 rounded-full hover:text-destructive focus:outline-none"
                  onClick={() => removeTag(tagId)}
                >
                  <X className="h-3 w-3" />
                </button>
              </Badge>
            );
          })}
        </div>
      )}
    </div>
  );
}

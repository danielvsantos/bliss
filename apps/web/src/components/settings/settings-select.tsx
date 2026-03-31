import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface SettingsSelectProps {
  label: string;
  hint?: string;
  value: string;
  onValueChange: (value: string) => void;
  options: { value: string; label: string }[];
  disabled?: boolean;
  placeholder?: string;
}

export function SettingsSelect({
  label,
  hint,
  value,
  onValueChange,
  options,
  disabled,
  placeholder,
}: SettingsSelectProps) {
  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-sm font-medium text-foreground tracking-[0.005em]">
        {label}
      </label>
      <Select value={value} onValueChange={onValueChange} disabled={disabled}>
        <SelectTrigger className="h-11 w-full bg-input-background border-border rounded-xl text-[0.9375rem] font-normal text-foreground px-3.5">
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <SelectContent>
          {options.map((o) => (
            <SelectItem key={o.value} value={o.value}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {hint && (
        <p className="text-xs text-muted-foreground leading-relaxed">{hint}</p>
      )}
    </div>
  );
}

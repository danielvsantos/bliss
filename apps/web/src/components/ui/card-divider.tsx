import { cn } from "@/lib/utils";

export function CardDivider({
  variant = "default",
  className,
}: {
  variant?: "default" | "destructive";
  className?: string;
}) {
  return (
    <div
      className={cn(
        "h-px w-full",
        variant === "destructive" ? "bg-destructive/25" : "bg-border",
        className,
      )}
    />
  );
}

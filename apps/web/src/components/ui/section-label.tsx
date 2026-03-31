import { cn } from "@/lib/utils";

export function SectionLabel({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "text-[0.6875rem] font-semibold tracking-[0.08em] uppercase text-muted-foreground mb-3",
        className,
      )}
    >
      {children}
    </div>
  );
}

import React, { ButtonHTMLAttributes, forwardRef } from "react";

type ButtonVariant = "primary" | "secondary" | "ghost" | "positive" | "negative";
type ButtonSize = "sm" | "md" | "lg";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  leftIcon?: React.ReactNode;
  rightIcon?: React.ReactNode;
  fullWidth?: boolean;
}

const variantStyles: Record<ButtonVariant, string> = {
  primary: [
    "bg-primary text-white",
    "border border-primary",
    "hover:bg-primary/90 hover:border-primary",
    "active:bg-primary/80 active:scale-[0.98]",
    "shadow-sm hover:shadow-md",
    "transition-all duration-150",
  ].join(" "),

  secondary: [
    "bg-transparent text-primary",
    "border border-border",
    "hover:bg-muted hover:border-border",
    "active:bg-accent active:scale-[0.98]",
    "transition-all duration-150",
  ].join(" "),

  ghost: [
    "bg-transparent text-brand-primary",
    "border border-transparent",
    "hover:bg-muted hover:text-primary",
    "active:bg-accent active:scale-[0.98]",
    "transition-all duration-150",
  ].join(" "),

  positive: [
    "bg-positive text-white",
    "border border-positive",
    "hover:bg-positive/90 hover:border-positive/90",
    "active:scale-[0.98]",
    "shadow-sm hover:shadow-md",
    "transition-all duration-150",
  ].join(" "),

  negative: [
    "bg-destructive/10 text-destructive",
    "border border-destructive/30",
    "hover:bg-destructive/20 hover:border-destructive/50",
    "active:scale-[0.98]",
    "transition-all duration-150",
  ].join(" "),
};

const sizeStyles: Record<ButtonSize, string> = {
  sm: "h-8 px-3 gap-1.5 rounded-lg text-[13px] tracking-[0.01em]",
  md: "h-10 px-5 gap-2 rounded-xl text-[15px] tracking-[0.015em]",
  lg: "h-12 px-6 gap-2.5 rounded-xl text-[16px] tracking-[0.015em]",
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      variant = "primary",
      size = "md",
      loading = false,
      leftIcon,
      rightIcon,
      fullWidth = false,
      className = "",
      children,
      disabled,
      ...props
    },
    ref
  ) => {
    const isDisabled = disabled || loading;

    return (
      <button
        ref={ref}
        disabled={isDisabled}
        className={[
          "inline-flex items-center justify-center",
          "font-medium select-none cursor-pointer",
          "focus-visible:outline-none",
          "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
          variantStyles[variant],
          sizeStyles[size],
          fullWidth ? "w-full" : "",
          isDisabled ? "opacity-40 pointer-events-none" : "",
          className,
        ]
          .filter(Boolean)
          .join(" ")}
        style={{ fontFamily: "'Urbanist', sans-serif", fontWeight: 500 }}
        {...props}
      >
        {loading ? (
          <SpinnerIcon size={size} />
        ) : (
          leftIcon && <span className="flex-shrink-0 flex items-center">{leftIcon}</span>
        )}
        {children && <span>{children}</span>}
        {!loading && rightIcon && (
          <span className="flex-shrink-0 flex items-center">{rightIcon}</span>
        )}
      </button>
    );
  }
);

Button.displayName = "Button";

function SpinnerIcon({ size }: { size: ButtonSize }) {
  const dim = size === "sm" ? 14 : size === "md" ? 16 : 18;
  return (
    <svg
      width={dim}
      height={dim}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.5}
      strokeLinecap="round"
      className="animate-spin"
    >
      <path d="M21 12a9 9 0 1 1-6.219-8.56" />
    </svg>
  );
}

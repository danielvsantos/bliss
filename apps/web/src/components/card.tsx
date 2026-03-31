import React, { HTMLAttributes, forwardRef } from "react";

interface CardProps extends HTMLAttributes<HTMLDivElement> {
  /** Removes the glass blur for performance-sensitive contexts */
  noBlur?: boolean;
  /** Adds a hover lift effect */
  interactive?: boolean;
}

/**
 * Bliss Card — Liquid Glass container
 *
 * Auto-Layout:
 *  - Direction: Vertical (flex-col)
 *  - Padding: 24px all sides
 *  - Gap: 16px between items
 *  - Distribution: Packed (justify-start)
 *  - Alignment: Top-Left (items-start)
 */
export const Card = forwardRef<HTMLDivElement, CardProps>(
  ({ noBlur = false, interactive = false, className = "", style, children, ...props }, ref) => {
    return (
      <div
        ref={ref}
        className={[
          "flex flex-col items-start justify-start",
          interactive
            ? "transition-all duration-200 hover:-translate-y-0.5 hover:shadow-[0_2px_4px_rgba(58,53,66,0.05),0_8px_24px_rgba(58,53,66,0.09),0_24px_56px_rgba(58,53,66,0.08),inset_0_1px_0_rgba(255,255,255,0.95)] cursor-pointer"
            : "",
          className,
        ]
          .filter(Boolean)
          .join(" ")}
        style={{
          fontFamily: "'Urbanist', sans-serif",
          background: noBlur ? "rgba(255,255,255,0.92)" : "rgba(255,255,255,0.68)",
          backdropFilter: noBlur ? "none" : "blur(20px) saturate(1.6)",
          WebkitBackdropFilter: noBlur ? "none" : "blur(20px) saturate(1.6)",
          border: "1px solid #E2E8F0",
          boxShadow: [
            "0 1px 2px rgba(58, 53, 66, 0.04)",
            "0 4px 12px rgba(58, 53, 66, 0.06)",
            "0 16px 40px rgba(58, 53, 66, 0.06)",
            "inset 0 1px 0 rgba(255, 255, 255, 0.9)",
          ].join(", "),
          borderRadius: "1rem",
          padding: "24px",
          gap: "16px",
          ...style,
        }}
        {...props}
      >
        {children}
      </div>
    );
  }
);

Card.displayName = "Card";

/* ── Sub-components ─────────────────────────────────── */

export function CardHeader({
  className = "",
  children,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={`flex flex-col items-start gap-1 w-full ${className}`}
      {...props}
    >
      {children}
    </div>
  );
}

export function CardTitle({
  className = "",
  children,
  ...props
}: HTMLAttributes<HTMLHeadingElement>) {
  return (
    <h3
      className={className}
      style={{
        fontFamily: "'Urbanist', sans-serif",
        fontSize: "1.0625rem",
        fontWeight: 600,
        color: "#1A1625",
        letterSpacing: "-0.01em",
        lineHeight: 1.3,
        margin: 0,
      }}
      {...props}
    >
      {children}
    </h3>
  );
}

export function CardDescription({
  className = "",
  children,
  ...props
}: HTMLAttributes<HTMLParagraphElement>) {
  return (
    <p
      className={className}
      style={{
        fontFamily: "'Urbanist', sans-serif",
        fontSize: "0.8125rem",
        fontWeight: 400,
        color: "#9A95A4",
        lineHeight: 1.55,
        margin: 0,
      }}
      {...props}
    >
      {children}
    </p>
  );
}

export function CardDivider({ className = "" }: { className?: string }) {
  return (
    <div
      className={`w-full ${className}`}
      style={{ height: 1, background: "#E2E8F0", flexShrink: 0 }}
    />
  );
}

export function CardFooter({
  className = "",
  children,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={`flex items-center w-full gap-2 pt-0 ${className}`}
      {...props}
    >
      {children}
    </div>
  );
}

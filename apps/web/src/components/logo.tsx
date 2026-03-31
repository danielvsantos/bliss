import React from "react";

interface LogoProps {
  size?: "sm" | "md" | "lg" | "xl";
  className?: string;
}

const sizeMap = {
  sm: { fontSize: "1.25rem", letterSpacing: "-0.03em", padding: "0.5rem 0.75rem" },
  md: { fontSize: "1.75rem", letterSpacing: "-0.04em", padding: "0.75rem 1rem" },
  lg: { fontSize: "2.5rem", letterSpacing: "-0.04em", padding: "1rem 1.25rem" },
  xl: { fontSize: "3.5rem", letterSpacing: "-0.05em", padding: "1.25rem 1.5rem" },
};

export function Logo({ size = "md", className = "" }: LogoProps) {
  const styles = sizeMap[size];

  return (
    <div
      className={`inline-flex items-center justify-center ${className}`}
      style={{ padding: styles.padding }}
    >
      <span
        style={{
          fontFamily: "'Urbanist', sans-serif",
          fontSize: styles.fontSize,
          fontWeight: 600,
          letterSpacing: styles.letterSpacing,
          color: "#6D657A",
          lineHeight: 1,
          userSelect: "none",
        }}
      >
        bliss
      </span>
    </div>
  );
}

export function LogoMark({ className = "" }: { className?: string }) {
  return (
    <div
      className={`inline-flex items-center justify-center w-9 h-9 rounded-xl ${className}`}
      style={{
        background: "#3A3542",
      }}
    >
      <span
        style={{
          fontFamily: "'Urbanist', sans-serif",
          fontSize: "1rem",
          fontWeight: 600,
          letterSpacing: "-0.03em",
          color: "#FFFFFF",
          lineHeight: 1,
          userSelect: "none",
        }}
      >
        b
      </span>
    </div>
  );
}

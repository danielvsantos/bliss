import React, { useState } from "react";

type AvatarStatus = "online" | "away" | "busy" | "offline";
type AvatarSize = "xs" | "sm" | "md" | "lg" | "xl";

interface AvatarProps {
  name?: string;
  size?: AvatarSize;
  status?: AvatarStatus;
  onClick?: () => void;
  className?: string;
}

const sizeDefs: Record<AvatarSize, { dim: number; fontSize: string; border: number; statusDot: number }> = {
  xs: { dim: 24, fontSize: "0.625rem",  border: 1.5, statusDot: 6  },
  sm: { dim: 30, fontSize: "0.6875rem", border: 1.5, statusDot: 7  },
  md: { dim: 36, fontSize: "0.8125rem", border: 2,   statusDot: 9  },
  lg: { dim: 44, fontSize: "1rem",      border: 2,   statusDot: 10 },
  xl: { dim: 56, fontSize: "1.125rem",  border: 2,   statusDot: 12 },
};

const statusColors: Record<AvatarStatus, string> = {
  online:  "#2E8B57",
  away:    "#F59E0B",
  busy:    "#E5989B",
  offline: "#C4BFD0",
};

function getInitials(name: string): string {
  return name
    .split(" ")
    .map((n) => n[0])
    .join("")
    .toUpperCase()
    .slice(0, 2);
}

export function Avatar({
  name = "Alex Morgan",
  size = "md",
  status,
  onClick,
  className = "",
}: AvatarProps) {
  const [hovered, setHovered] = useState(false);
  const { dim, fontSize, border, statusDot } = sizeDefs[size];
  const initials = getInitials(name);

  return (
    <div
      className={`relative inline-flex flex-shrink-0 ${className}`}
      style={{ width: dim, height: dim }}
    >
      <button
        onClick={onClick}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        aria-label={`User profile: ${name}`}
        style={{
          width: dim,
          height: dim,
          borderRadius: "50%",
          background: hovered
            ? "linear-gradient(145deg, #8078A0 0%, #3A3542 100%)"
            : "linear-gradient(145deg, #6D657A 0%, #3A3542 100%)",
          border: `${border}px solid rgba(255,255,255,0.25)`,
          boxShadow: hovered
            ? "0 2px 8px rgba(58,53,66,0.28), 0 0 0 3px rgba(109,101,122,0.15)"
            : "0 1px 4px rgba(58,53,66,0.18)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          cursor: onClick ? "pointer" : "default",
          transition: "all 0.18s ease",
          outline: "none",
          padding: 0,
          fontFamily: "'Urbanist', sans-serif",
        }}
      >
        <span
          style={{
            fontFamily: "'Urbanist', sans-serif",
            fontSize,
            fontWeight: 600,
            color: "#FFFFFF",
            letterSpacing: "0.025em",
            lineHeight: 1,
            userSelect: "none",
          }}
        >
          {initials}
        </span>
      </button>

      {status && (
        <span
          aria-label={status}
          style={{
            position: "absolute",
            bottom: 0,
            right: 0,
            width: statusDot,
            height: statusDot,
            borderRadius: "50%",
            background: statusColors[status],
            border: `${border}px solid #FAFAFA`,
            boxShadow: "0 1px 3px rgba(0,0,0,0.12)",
          }}
        />
      )}
    </div>
  );
}

/* ── Avatar Group ─────────────────────────────────── */
interface AvatarGroupProps {
  names: string[];
  max?: number;
  size?: AvatarSize;
}

export function AvatarGroup({ names, max = 4, size = "sm" }: AvatarGroupProps) {
  const visible = names.slice(0, max);
  const overflow = names.length - max;
  const { dim, fontSize, border } = sizeDefs[size];
  const offset = Math.round(dim * 0.35);

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "row",
        alignItems: "center",
      }}
    >
      {visible.map((name, i) => (
        <div
          key={name}
          style={{
            marginLeft: i === 0 ? 0 : -offset,
            zIndex: visible.length - i,
            borderRadius: "50%",
            border: `${border}px solid #FAFAFA`,
          }}
        >
          <Avatar name={name} size={size} />
        </div>
      ))}
      {overflow > 0 && (
        <div
          style={{
            marginLeft: -offset,
            width: dim,
            height: dim,
            borderRadius: "50%",
            background: "#EDE9F3",
            border: `${border}px solid #FAFAFA`,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 0,
          }}
        >
          <span
            style={{
              fontFamily: "'Urbanist', sans-serif",
              fontSize,
              fontWeight: 600,
              color: "#6D657A",
            }}
          >
            +{overflow}
          </span>
        </div>
      )}
    </div>
  );
}

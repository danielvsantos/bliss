import React, { useEffect, useRef } from "react";

/* ══════════════════════════════════════════════════════
   DIALOG  —  Liquid Glass modal with backdrop blur
   Uses a plain position:fixed overlay (no react-dom portal)
   so it works in any render environment without extra deps.
══════════════════════════════════════════════════════ */

export interface DialogProps {
  isOpen: boolean;
  onClose: () => void;
  children: React.ReactNode;
  /** Max width of the modal card in px (default: 488) */
  maxWidth?: number;
}

export function Dialog({ isOpen, onClose, children, maxWidth = 488 }: DialogProps) {
  const overlayRef = useRef<HTMLDivElement>(null);

  /* Lock body scroll while open */
  useEffect(() => {
    if (isOpen) {
      document.body.style.overflow = "hidden";
    }
    return () => {
      document.body.style.overflow = "";
    };
  }, [isOpen]);

  /* Escape key closes */
  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <>
      {/* Keyframe animations */}
      <style>{`
        @keyframes bliss-fade-in  { from { opacity: 0 } to { opacity: 1 } }
        @keyframes bliss-slide-up {
          from { opacity: 0; transform: translateY(14px) scale(0.98); }
          to   { opacity: 1; transform: translateY(0)   scale(1); }
        }
      `}</style>

      {/* ── Backdrop ── */}
      <div
        ref={overlayRef}
        role="presentation"
        onClick={(e) => {
          if (e.target === overlayRef.current) onClose();
        }}
        style={{
          position: "fixed",
          inset: 0,
          background: "rgba(18, 14, 28, 0.54)",
          backdropFilter: "blur(12px) saturate(1.4)",
          WebkitBackdropFilter: "blur(12px) saturate(1.4)",
          zIndex: 9000,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: "24px 16px",
          animation: "bliss-fade-in 0.18s ease",
        }}
      >
        {/* ── Modal card — Liquid Glass ── */}
        <div
          role="dialog"
          aria-modal="true"
          style={{
            width: "100%",
            maxWidth,
            background: "rgba(255,255,255,0.97)",
            backdropFilter: "blur(20px) saturate(1.8)",
            WebkitBackdropFilter: "blur(20px) saturate(1.8)",
            border: "1px solid #E2E8F0",
            boxShadow: [
              "0 1px 2px rgba(58,53,66,0.04)",
              "0 6px 20px rgba(58,53,66,0.10)",
              "0 24px 60px rgba(58,53,66,0.16)",
              "inset 0 1px 0 rgba(255,255,255,1)",
            ].join(", "),
            borderRadius: "1.25rem",
            overflow: "hidden",
            animation: "bliss-slide-up 0.22s cubic-bezier(0.22, 1, 0.36, 1)",
          }}
        >
          {children}
        </div>
      </div>
    </>
  );
}

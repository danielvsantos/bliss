import { useEffect, useState } from "react";

interface SaveConfirmationProps {
  visible: boolean;
}

export function SaveConfirmation({ visible }: SaveConfirmationProps) {
  const [show, setShow] = useState(false);

  useEffect(() => {
    if (visible) {
      setShow(true);
      const timer = setTimeout(() => setShow(false), 2500);
      return () => clearTimeout(timer);
    }
    setShow(false);
  }, [visible]);

  return (
    <div
      className="flex items-center gap-1.5 pointer-events-none"
      style={{ opacity: show ? 1 : 0, transition: "opacity 250ms ease-out" }}
    >
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
        <circle cx="7" cy="7" r="6" className="fill-positive/15" />
        <path
          d="M4.5 7l1.8 1.8L9.5 5"
          className="stroke-positive"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      <span className="text-[0.8125rem] font-medium text-positive">
        Changes saved
      </span>
    </div>
  );
}

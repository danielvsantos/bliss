import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Touch devices (#155): opening a dialog or sheet must not focus its first
 * field, which pops the on-screen keyboard over the form before the user has
 * chosen a field. Wraps an `onOpenAutoFocus` handler; fields with an explicit
 * `autoFocus` prop still focus.
 */
export function preventTouchAutoFocus(handler?: (event: Event) => void) {
  return (event: Event) => {
    handler?.(event);
    if (
      !event.defaultPrevented &&
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(pointer: coarse)").matches
    ) {
      event.preventDefault();
    }
  };
}

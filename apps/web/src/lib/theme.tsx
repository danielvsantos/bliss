import * as React from "react";
import { useEffect, useState } from "react";
import { ThemeProviderContext, type Theme } from "./theme-context";

type ThemeProviderProps = {
  children: React.ReactNode;
  defaultTheme?: Theme;
  storageKey?: string;
  forceLightMode?: boolean;
};

export function ThemeProvider({
  children,
  // Light unless a theme was stored. There is no theme switcher, and the
  // sign-in page stores "light", so in a browser everyone ends up on light.
  // An installed PWA starts with empty storage (#155): "system" would put it
  // in the unfinished dark theme whenever the phone is in dark mode.
  defaultTheme = "light",
  storageKey = "bliss-ui-theme",
  forceLightMode = false,
}: ThemeProviderProps) {
  const [theme, setTheme] = useState<Theme>(defaultTheme);

  // Load theme from localStorage once the component is mounted
  useEffect(() => {
    if (forceLightMode) {
      setTheme("light");
      return;
    }

    const storedTheme = localStorage.getItem(storageKey) as Theme;
    if (storedTheme) {
      setTheme(storedTheme);
    }
  }, [storageKey, forceLightMode]);

  useEffect(() => {
    const root = window.document.documentElement;
    root.classList.remove("light", "dark");

    if (forceLightMode) {
      root.classList.add("light");
      return;
    }

    if (theme === "system") {
      const systemTheme = window.matchMedia("(prefers-color-scheme: dark)")
        .matches
        ? "dark"
        : "light";
      root.classList.add(systemTheme);
      return;
    }

    root.classList.add(theme);
  }, [theme, forceLightMode]);

  const value = {
    theme: forceLightMode ? "light" : theme,
    setTheme: (theme: Theme) => {
      if (forceLightMode) return;
      localStorage.setItem(storageKey, theme);
      setTheme(theme);
    },
  };

  return (
    <ThemeProviderContext.Provider value={value}>
      {children}
    </ThemeProviderContext.Provider>
  );
}

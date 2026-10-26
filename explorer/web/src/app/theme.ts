/**
 * The theme choice. It lives in the browser storage of the viewer. The page applies it as a class on the root element,
 * which the Chakra colors read. With `system` the page follows the setting of the operating system.
 */
import { useCallback, useEffect, useState } from "react";
import type { ThemeChoice } from "../search/search-model";

const THEME_KEY = "zk-bridge-explorer.theme";

const readStoredTheme = (): ThemeChoice => {
  try {
    const stored = window.localStorage.getItem(THEME_KEY);
    return stored === "light" || stored === "dark" ? stored : "system";
  } catch {
    return "system";
  }
};

/**
 * Whether a choice shows the dark colors now.
 *
 * @param choice The choice.
 * @param systemPrefersDark Whether the operating system asks for dark colors.
 */
export const isDarkTheme = (choice: ThemeChoice, systemPrefersDark: boolean): boolean => {
  if (choice === "dark") return true;
  if (choice === "light") return false;
  return systemPrefersDark;
};

/** The theme choice and a setter. The setter stores the choice. */
export const useThemeChoice = (): { readonly theme: ThemeChoice; readonly setTheme: (next: ThemeChoice) => void } => {
  const [theme, setThemeState] = useState<ThemeChoice>(readStoredTheme);

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = (): void => {
      const dark = isDarkTheme(theme, media.matches);
      document.documentElement.classList.toggle("dark", dark);
      document.documentElement.classList.toggle("light", !dark);
      document.documentElement.style.colorScheme = dark ? "dark" : "light";
    };
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [theme]);

  const setTheme = useCallback((next: ThemeChoice): void => {
    setThemeState(next);
    try {
      window.localStorage.setItem(THEME_KEY, next);
    } catch {
      // The choice then lasts for this visit only.
    }
  }, []);

  return { theme, setTheme };
};

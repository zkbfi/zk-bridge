/**
 * The theme choice. It lives in the browser storage of the viewer. The page applies it as classes on the root element:
 * `theme-ember-light`, `theme-ember-dark` or `theme-mono` for the bridge screen's colours, and `light` or `dark`, which
 * the Chakra colors of the explorer views read. With `system` the page follows the setting of the operating system.
 */
import { useCallback, useEffect, useState } from "react";
import type { ThemeChoice } from "../search/search-model";

const THEME_KEY = "zk-bridge-explorer.theme";

/** The three themes the page draws: Ember on a light page, Ember on black, and Mono (high contrast). */
export type ResolvedTheme = "ember-light" | "ember-dark" | "mono";

const THEME_CLASSES: readonly string[] = ["theme-ember-light", "theme-ember-dark", "theme-mono"];

const readStoredTheme = (): ThemeChoice => {
  try {
    const stored = window.localStorage.getItem(THEME_KEY);
    return stored === "light" || stored === "dark" || stored === "mono" ? stored : "system";
  } catch {
    return "system";
  }
};

/**
 * Whether a choice shows the dark colors now. Mono is dark.
 *
 * @param choice The choice.
 * @param systemPrefersDark Whether the operating system asks for dark colors.
 */
export const isDarkTheme = (choice: ThemeChoice, systemPrefersDark: boolean): boolean => {
  if (choice === "dark" || choice === "mono") return true;
  if (choice === "light") return false;
  return systemPrefersDark;
};

/**
 * The theme a choice draws now.
 *
 * @param choice The choice.
 * @param systemPrefersDark Whether the operating system asks for dark colors.
 */
export const resolveTheme = (choice: ThemeChoice, systemPrefersDark: boolean): ResolvedTheme => {
  if (choice === "mono") return "mono";
  return isDarkTheme(choice, systemPrefersDark) ? "ember-dark" : "ember-light";
};

/** The theme choice and a setter. The setter stores the choice. */
export const useThemeChoice = (): { readonly theme: ThemeChoice; readonly setTheme: (next: ThemeChoice) => void } => {
  const [theme, setThemeState] = useState<ThemeChoice>(readStoredTheme);

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = (): void => {
      const dark = isDarkTheme(theme, media.matches);
      const root = document.documentElement;
      root.classList.toggle("dark", dark);
      root.classList.toggle("light", !dark);
      root.classList.remove(...THEME_CLASSES);
      root.classList.add(`theme-${resolveTheme(theme, media.matches)}`);
      root.style.colorScheme = dark ? "dark" : "light";
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

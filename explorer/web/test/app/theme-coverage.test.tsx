import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isDarkTheme, useThemeChoice } from "../../src/app/theme";

const KEY = "zk-bridge-explorer.theme";

beforeEach(() => {
  window.localStorage.clear();
  document.documentElement.className = "";
  document.documentElement.style.colorScheme = "";
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("isDarkTheme", () => {
  it("is true for dark and false for light, whatever the system asks", () => {
    expect(isDarkTheme("dark", false)).toBe(true);
    expect(isDarkTheme("light", true)).toBe(false);
  });

  it("follows the system for the system choice", () => {
    expect(isDarkTheme("system", true)).toBe(true);
    expect(isDarkTheme("system", false)).toBe(false);
  });
});

describe("useThemeChoice", () => {
  it("starts with the choice that the viewer stored: light and dark", () => {
    window.localStorage.setItem(KEY, "light");
    expect(renderHook(() => useThemeChoice()).result.current.theme).toBe("light");
    window.localStorage.setItem(KEY, "dark");
    expect(renderHook(() => useThemeChoice()).result.current.theme).toBe("dark");
  });

  it("starts with the system choice when the stored text is not a theme", () => {
    window.localStorage.setItem(KEY, "purple");
    expect(renderHook(() => useThemeChoice()).result.current.theme).toBe("system");
  });

  it("starts with the system choice when the browser refuses to read the storage", () => {
    const original = Object.getOwnPropertyDescriptor(window, "localStorage");
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      get: () => {
        throw new Error("blocked");
      },
    });
    try {
      expect(renderHook(() => useThemeChoice()).result.current.theme).toBe("system");
    } finally {
      if (original === undefined) Reflect.deleteProperty(window, "localStorage");
      else Object.defineProperty(window, "localStorage", original);
    }
  });

  it("marks the root element for the light colors and sets the color scheme", () => {
    window.localStorage.setItem(KEY, "light");
    renderHook(() => useThemeChoice());
    expect(document.documentElement).toHaveClass("light");
    expect(document.documentElement).not.toHaveClass("dark");
    expect(document.documentElement.style.colorScheme).toBe("light");
  });

  it("stores a new choice and applies it to the root element", () => {
    const { result } = renderHook(() => useThemeChoice());
    act(() => result.current.setTheme("dark"));
    expect(result.current.theme).toBe("dark");
    expect(window.localStorage.getItem(KEY)).toBe("dark");
    expect(document.documentElement).toHaveClass("dark");
    expect(document.documentElement).not.toHaveClass("light");
    expect(document.documentElement.style.colorScheme).toBe("dark");
  });

  it("keeps the new choice for this visit when the storage refuses the write", () => {
    const { result } = renderHook(() => useThemeChoice());
    const original = Object.getOwnPropertyDescriptor(window, "localStorage");
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      get: () => {
        throw new Error("full");
      },
    });
    try {
      act(() => result.current.setTheme("dark"));
    } finally {
      if (original === undefined) Reflect.deleteProperty(window, "localStorage");
      else Object.defineProperty(window, "localStorage", original);
    }
    expect(result.current.theme).toBe("dark");
    expect(document.documentElement).toHaveClass("dark");
  });

  it("follows the system while the choice is system, and stops listening on unmount", () => {
    let prefersDark = false;
    const listeners = new Set<() => void>();
    vi.spyOn(window, "matchMedia").mockImplementation(
      () =>
        ({
          get matches() {
            return prefersDark;
          },
          addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
          removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener),
        }) as unknown as MediaQueryList,
    );
    const { unmount } = renderHook(() => useThemeChoice());
    expect(document.documentElement).toHaveClass("light");
    expect(listeners.size).toBe(1);
    prefersDark = true;
    act(() => listeners.forEach((listener) => listener()));
    expect(document.documentElement).toHaveClass("dark");
    unmount();
    expect(listeners.size).toBe(0);
  });
});

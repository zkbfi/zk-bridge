import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { resolveTheme, useThemeChoice } from "../../src/app/theme";

beforeEach(() => {
  window.localStorage.clear();
  document.documentElement.className = "";
});

describe("resolveTheme", () => {
  it("follows the system with the two Ember themes, and keeps Mono whatever the system asks", () => {
    expect(resolveTheme("system", true)).toBe("ember-dark");
    expect(resolveTheme("system", false)).toBe("ember-light");
    expect(resolveTheme("dark", false)).toBe("ember-dark");
    expect(resolveTheme("light", true)).toBe("ember-light");
    expect(resolveTheme("mono", false)).toBe("mono");
    expect(resolveTheme("mono", true)).toBe("mono");
  });
});

describe("the mono choice", () => {
  it("is stored, survives a reload, and puts the theme class and Chakra's dark class on the page", () => {
    const first = renderHook(() => useThemeChoice());
    act(() => first.result.current.setTheme("mono"));
    expect(document.documentElement.classList.contains("theme-mono")).toBe(true);
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(renderHook(() => useThemeChoice()).result.current.theme).toBe("mono");
  });

  it("starts on System when nothing is stored", () => {
    expect(renderHook(() => useThemeChoice()).result.current.theme).toBe("system");
  });
});

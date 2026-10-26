import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useActions } from "../../src/app/actions-context";
import { useServices } from "../../src/app/services";

describe("the context hooks", () => {
  it("useActions throws a clear message outside a provider", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(() => renderHook(() => useActions())).toThrow("useActions needs an ActionsContext provider above it.");
  });

  it("useServices throws a clear message outside a provider", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(() => renderHook(() => useServices())).toThrow("useServices needs a ServicesProvider above it.");
  });
});

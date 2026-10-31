import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

afterEach(() => cleanup());

// Some jsdom builds ship no working localStorage. A small in-memory one keeps the tests honest about storage.
const hasWorkingStorage = (): boolean => {
  try {
    return typeof window.localStorage?.getItem === "function";
  } catch {
    return false;
  }
};
if (!hasWorkingStorage()) {
  const data = new Map<string, string>();
  const memory: Storage = {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (key) => data.get(key) ?? null,
    key: (index) => Array.from(data.keys())[index] ?? null,
    removeItem: (key) => void data.delete(key),
    setItem: (key, value) => void data.set(key, String(value)),
  };
  Object.defineProperty(window, "localStorage", { value: memory, configurable: true });
}

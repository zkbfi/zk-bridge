import "@testing-library/jest-dom/vitest";
import { cleanup, configure } from "@testing-library/react";
import { afterEach } from "vitest";

afterEach(() => cleanup());

// The default wait of findBy and waitFor is 1 s. A full run with coverage on a busy machine renders a screen in more than
// that, and tests then fail only under load. 10 s keeps a real failure fast to see and a slow render from failing.
configure({ asyncUtilTimeout: 10_000 });

// jsdom has no layout engine. These stubs keep Chakra and the palette from failing on missing browser functions.
if (typeof window.matchMedia !== "function") {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
}
if (typeof Element.prototype.scrollIntoView !== "function") {
  Element.prototype.scrollIntoView = () => undefined;
}
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
if (typeof window.ResizeObserver === "undefined") {
  window.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;
}

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
window.scrollTo = () => undefined;

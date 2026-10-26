import { afterEach, describe, expect, it, vi } from "vitest";
import { browserStorage, clearRecent, loadRecent, RECENT_STORAGE_KEY, rememberRecent, type RecentStorage } from "../../src/search/recent-items";
import { viewResults } from "../../src/search/search-model";

const [first] = viewResults("eth-pls");
const throwing: RecentStorage = {
  getItem: () => {
    throw new Error("blocked");
  },
  setItem: () => {
    throw new Error("full");
  },
};

afterEach(() => vi.restoreAllMocks());

describe("recent items without a usable storage", () => {
  it("gives an empty list for no storage, a storage that throws, and a value that is not a list", () => {
    expect(loadRecent(null)).toEqual([]);
    expect(loadRecent(throwing)).toEqual([]);
    expect(loadRecent({ getItem: () => '{"a":1}', setItem: () => undefined })).toEqual([]);
    expect(loadRecent({ getItem: () => null, setItem: () => undefined })).toEqual([]);
  });

  it("refuses a stored row whose jump is missing or of an unknown type", () => {
    const row = { ...first!, jump: { type: "other" } };
    const noJump = { ...first!, jump: null };
    const noKeywords = { ...first!, keywords: "x" };
    for (const bad of [row, noJump, noKeywords, { ...first!, title: 5 }, { ...first!, subtitle: 5 }, { ...first!, kind: 5 }]) {
      expect(loadRecent({ getItem: () => JSON.stringify([bad]), setItem: () => undefined })).toEqual([]);
    }
    expect(loadRecent({ getItem: () => JSON.stringify([first!]), setItem: () => undefined })).toEqual([first]);
  });

  it("returns the new list even when the storage refuses the write or does not exist", () => {
    expect(rememberRecent(throwing, first!)).toEqual([first]);
    expect(rememberRecent(null, first!)).toEqual([first]);
  });

  it("writes an empty list when cleared, and does not fail on a storage that throws or is missing", () => {
    const written: [string, string][] = [];
    clearRecent({ getItem: () => null, setItem: (key, value) => void written.push([key, value]) });
    expect(written).toEqual([[RECENT_STORAGE_KEY, "[]"]]);
    expect(() => clearRecent(throwing)).not.toThrow();
    expect(() => clearRecent(null)).not.toThrow();
  });
});

describe("browserStorage", () => {
  it("gives the local storage of the window", () => {
    expect(browserStorage()).toBe(window.localStorage);
  });

  it("gives null when the browser refuses access", () => {
    vi.spyOn(window, "localStorage", "get").mockImplementation(() => {
      throw new DOMException("denied", "SecurityError");
    });
    expect(browserStorage()).toBeNull();
  });
});

describe("browserStorage, a window with no storage object", () => {
  it("gives null when the window has no local storage at all", () => {
    vi.spyOn(window, "localStorage", "get").mockReturnValue(undefined as unknown as Storage);
    expect(browserStorage()).toBeNull();
  });
});

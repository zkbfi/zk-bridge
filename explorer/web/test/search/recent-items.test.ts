import { describe, expect, it } from "vitest";
import { loadRecent, RECENT_LIMIT, RECENT_STORAGE_KEY, rememberRecent, clearRecent, type RecentStorage } from "../../src/search/recent-items";
import { viewResults } from "../../src/search/search-model";

const memoryStorage = (initial: Record<string, string> = {}): RecentStorage & { readonly data: Record<string, string> } => {
  const data = { ...initial };
  return { data, getItem: (key) => data[key] ?? null, setItem: (key, value) => void (data[key] = value) };
};

describe("recent items", () => {
  const [global, pair, audit] = viewResults("eth-pls");

  it("puts the newest first and keeps each result once", () => {
    const storage = memoryStorage();
    rememberRecent(storage, global!);
    rememberRecent(storage, pair!);
    const list = rememberRecent(storage, global!);
    expect(list.map((result) => result.id)).toEqual([global!.id, pair!.id]);
    expect(loadRecent(storage).map((result) => result.id)).toEqual([global!.id, pair!.id]);
  });

  it("keeps only the limit", () => {
    const storage = memoryStorage();
    for (let index = 0; index < RECENT_LIMIT + 3; index += 1) rememberRecent(storage, { ...audit!, id: `view:${index}` });
    expect(loadRecent(storage)).toHaveLength(RECENT_LIMIT);
  });

  it("treats a broken or hostile value as an empty list", () => {
    expect(loadRecent(memoryStorage({ [RECENT_STORAGE_KEY]: "{not json" }))).toEqual([]);
    expect(loadRecent(memoryStorage({ [RECENT_STORAGE_KEY]: JSON.stringify([{ id: 1 }, "x", null]) }))).toEqual([]);
  });

  it("works with no storage and with a storage that throws", () => {
    expect(loadRecent(null)).toEqual([]);
    expect(rememberRecent(null, global!)).toHaveLength(1);
    const failing: RecentStorage = { getItem: () => null, setItem: () => { throw new Error("full"); } };
    expect(() => rememberRecent(failing, global!)).not.toThrow();
  });

  it("clears the list", () => {
    const storage = memoryStorage();
    rememberRecent(storage, global!);
    clearRecent(storage);
    expect(loadRecent(storage)).toEqual([]);
  });
});

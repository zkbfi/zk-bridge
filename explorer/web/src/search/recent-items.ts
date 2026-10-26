/**
 * The recent results of the palette. They live in the browser storage of the viewer and nowhere else. The storage can
 * be missing or full, so every read and write is guarded and the palette works without it.
 */
import type { SearchResult } from "./search-model";

/** The part of `Storage` that the recent list uses. */
export type RecentStorage = Pick<Storage, "getItem" | "setItem">;

/** The key of the list. */
export const RECENT_STORAGE_KEY = "zk-bridge-explorer.recent";

/** How many results the list keeps. */
export const RECENT_LIMIT = 6;

const isResult = (value: unknown): value is SearchResult => {
  if (typeof value !== "object" || value === null) return false;
  const row = value as Record<string, unknown>;
  const jump = row.jump as Record<string, unknown> | undefined;
  return typeof row.id === "string" && typeof row.kind === "string" && typeof row.title === "string" && typeof row.subtitle === "string" && Array.isArray(row.keywords) && typeof jump === "object" && jump !== null && (jump.type === "route" || jump.type === "action");
};

/**
 * Reads the list. A missing, broken or hostile value gives an empty list.
 *
 * @param storage The storage, or null when there is none.
 */
export const loadRecent = (storage: RecentStorage | null): readonly SearchResult[] => {
  if (storage === null) return [];
  try {
    const parsed: unknown = JSON.parse(storage.getItem(RECENT_STORAGE_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter(isResult).slice(0, RECENT_LIMIT) : [];
  } catch {
    return [];
  }
};

/**
 * Puts a result first in the list, once, and returns the new list.
 *
 * @param storage The storage, or null when there is none.
 * @param result The result that the user opened.
 */
export const rememberRecent = (storage: RecentStorage | null, result: SearchResult): readonly SearchResult[] => {
  const next = [result, ...loadRecent(storage).filter((entry) => entry.id !== result.id)].slice(0, RECENT_LIMIT);
  try {
    storage?.setItem(RECENT_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // A full or blocked storage only costs the recent list.
  }
  return next;
};

/**
 * Empties the list.
 *
 * @param storage The storage, or null when there is none.
 */
export const clearRecent = (storage: RecentStorage | null): void => {
  try {
    storage?.setItem(RECENT_STORAGE_KEY, "[]");
  } catch {
    // Nothing to do.
  }
};

/** The browser storage, or null when the browser refuses access. */
export const browserStorage = (): RecentStorage | null => {
  try {
    return window.localStorage ?? null;
  } catch {
    return null;
  }
};

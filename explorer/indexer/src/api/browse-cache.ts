/**
 * A cache of one answer for a few seconds. The all-time counts and the address activity scan whole tables, and the
 * browse page asks for them at every poll, so a burst of readers shares one scan. The answer is at most
 * {@link BROWSE_CACHE_SECONDS} old; the lists themselves are never cached.
 */

/** How long a cached answer serves. The counts on the page poll every 15 to 30 seconds. */
export const BROWSE_CACHE_SECONDS = 10;

type Entry<T> = { readonly at: number; readonly value: Promise<T> };

const entries = new Map<string, Entry<unknown>>();

/**
 * Returns the cached answer for `key`, or computes it. Readers that arrive while it computes share the same promise.
 * A failed computation is not kept.
 *
 * @param key The name of the answer.
 * @param compute Computes the answer.
 */
export const cachedFor = <T>(key: string, compute: () => Promise<T>): Promise<T> => {
  const now = Date.now();
  const found = entries.get(key) as Entry<T> | undefined;
  if (found !== undefined && now - found.at < BROWSE_CACHE_SECONDS * 1000) return found.value;
  const value = compute();
  entries.set(key, { at: now, value });
  value.catch(() => {
    if (entries.get(key)?.value === value) entries.delete(key);
  });
  return value;
};

/** Forgets every cached answer. A test calls it between cases. */
export const resetBrowseCache = (): void => entries.clear();

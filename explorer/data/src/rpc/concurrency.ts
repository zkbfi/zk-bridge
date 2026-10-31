/**
 * Runs an async function over a list with at most `limit` calls in flight, and keeps the order of the results.
 *
 * @param items The inputs.
 * @param limit How many calls may run at once. At least 1.
 * @param run The function to call for each input.
 * @throws The first error that a call throws. The calls already started still finish.
 */
export const mapWithLimit = async <input, output>(
  items: readonly input[],
  limit: number,
  run: (item: input, index: number) => Promise<output>,
): Promise<output[]> => {
  const results = new Array<output>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await run(items[index] as input, index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
};

/**
 * Makes a function run one call at a time. A call that arrives while another runs waits for it, whether it fails or not.
 */
export const createSerialQueue = (): (<value>(task: () => Promise<value>) => Promise<value>) => {
  let tail: Promise<unknown> = Promise.resolve();
  return <value>(task: () => Promise<value>): Promise<value> => {
    const result = tail.then(task, task);
    tail = result.catch(() => undefined);
    return result;
  };
};

/** Runs jobs one after another. Two transactions from one account must not race for a nonce. */
export interface SerialQueue {
  run<Result>(job: () => Promise<Result>): Promise<Result>;
}

/** Builds an empty queue. A job that throws does not stop the jobs behind it. */
export function createSerialQueue(): SerialQueue {
  let tail: Promise<unknown> = Promise.resolve();
  return {
    run(job) {
      const result = tail.then(job, job);
      tail = result.catch(() => undefined);
      return result;
    },
  };
}

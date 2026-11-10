// The work of the grind worker, apart from the thread, so that a test can run it. A plain module: it loads without a
// TypeScript loader.

/** How many times a grind starts over with fresh inputs, so that a board that keeps moving cannot hold the job forever. */
export const MAXIMUM_ATTEMPTS = 3;

/**
 * The most blocks that a stamp may lie behind the head. The board keeps roughly the last 120 blocks, so a stamp that is
 * older than this may be refused by the time it is posted.
 */
export const MAXIMUM_BLOCK_AGE = 100;

/**
 * Finds the proof of work for one message and builds the reply that the worker sends to its parent thread.
 *
 * The SDK reads the work factors (here, through `status`) and the hash of the latest block once, when the grind starts:
 * the engine grinds against that snapshot. A grind of minutes can end after the board has raised its floor or moved
 * past the window of the block hash, and then the board refuses the message and the work is lost. So after each grind
 * the job reads both again, and when either went stale it grinds again from fresh inputs (at most MAXIMUM_ATTEMPTS
 * times, and the last work is returned as it is). The stamp is checked after the grind, not during it, because the
 * engine call cannot be interrupted and a throw from the stamper makes the SDK search from nonce 0 again.
 *
 * @param {{ category: string, payload: string }} job The message to grind.
 * @param {{ board: object, toRLP: (message: object) => string }} dependencies The board client and the encoder.
 * @returns {Promise<object>} `{ ok: true, rlp, hash, nonce, difficulty, iterations, durationMilliseconds }`, or `{ ok: false, error }`.
 */
export async function runGrindJob(job, { board, toRLP }) {
  try {
    let work;
    for (let attempt = 1; ; attempt += 1) {
      const status = await board.status();
      if (!status.enabled) throw new Error("the node does not run the msgboard module");
      // Work for the live floor of the board: the cheapest message that the board accepts.
      const multiplier = BigInt(status.workMultiplier);
      const divisor = BigInt(status.workDivisor);
      board.setDifficultyFactors(multiplier, divisor);
      work = await board.grind(job.category, job.payload);
      if (!work.stats.isValid) throw new Error("the proof of work search ended without a valid nonce");
      if (attempt >= MAXIMUM_ATTEMPTS || !(await isStale(board, work.message, multiplier, divisor))) break;
    }
    return {
      ok: true,
      rlp: toRLP(work.message),
      hash: work.message.hash,
      nonce: work.message.nonce.toString(),
      difficulty: work.stats.difficulty.toString(),
      iterations: work.stats.iterations.toString(),
      durationMilliseconds: work.stats.duration,
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Whether the board would refuse this work now: its floor is higher than the work was ground for, or the block is too old. */
async function isStale(board, message, multiplier, divisor) {
  const status = await board.status();
  if (BigInt(status.workMultiplier) * divisor > multiplier * BigInt(status.workDivisor)) return true;
  const head = await board.lastestBlock();
  return BigInt(head.number) - BigInt(message.blockNumber) > BigInt(MAXIMUM_BLOCK_AGE);
}

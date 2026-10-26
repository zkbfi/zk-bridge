// The work of the grind worker, apart from the thread, so that a test can run it. A plain module: it loads without a
// TypeScript loader.

/**
 * Finds the proof of work for one message and builds the reply that the worker sends to its parent thread.
 *
 * @param {{ category: string, payload: string }} job The message to grind.
 * @param {{ board: object, toRLP: (message: object) => string }} dependencies The board client and the encoder.
 * @returns {Promise<object>} `{ ok: true, rlp, hash, nonce, difficulty, iterations, durationMilliseconds }`, or `{ ok: false, error }`.
 */
export async function runGrindJob(job, { board, toRLP }) {
  try {
    const status = await board.status();
    if (!status.enabled) throw new Error("the node does not run the msgboard module");
    // Work for the live floor of the board: the cheapest message that the board accepts.
    board.setDifficultyFactors(BigInt(status.workMultiplier), BigInt(status.workDivisor));
    const work = await board.grind(job.category, job.payload);
    if (!work.stats.isValid) throw new Error("the proof of work search ended without a valid nonce");
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

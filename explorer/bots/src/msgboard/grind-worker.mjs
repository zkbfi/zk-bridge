// Runs in a worker thread. Proof of work is a busy loop, so it must not run on the thread that serves the bots.
// Input (workerData): { url, category, payload, timeoutMilliseconds }.
// Output (one message to the parent): { ok: true, rlp, hash, nonce, difficulty, iterations, durationMilliseconds }
// or { ok: false, error }.
import { parentPort, workerData } from "node:worker_threads";
import { createClient, http } from "viem";
import { MsgBoardClient, toRLP } from "@msgboard/sdk";

const { url, category, payload, timeoutMilliseconds } = workerData;

try {
  const client = createClient({ transport: http(url, { timeout: timeoutMilliseconds, retryCount: 1 }) });
  const board = new MsgBoardClient({ request: (argument) => client.request(argument) });
  const status = await board.status();
  if (!status.enabled) throw new Error("the node does not run the msgboard module");
  // Work for the live floor of the board: the cheapest message that the board accepts.
  board.setDifficultyFactors(BigInt(status.workMultiplier), BigInt(status.workDivisor));
  const work = await board.grind(category, payload);
  if (!work.stats.isValid) throw new Error("the proof of work search ended without a valid nonce");
  parentPort.postMessage({
    ok: true,
    rlp: toRLP(work.message),
    hash: work.message.hash,
    nonce: work.message.nonce.toString(),
    difficulty: work.stats.difficulty.toString(),
    iterations: work.stats.iterations.toString(),
    durationMilliseconds: work.stats.duration,
  });
} catch (error) {
  parentPort.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) });
}

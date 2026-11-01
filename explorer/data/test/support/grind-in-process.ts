import { createClient, http } from "viem";
import { MsgBoardClient, toRLP } from "@msgboard/sdk";
import type { GrindFunction } from "../../src/index.js";

/** The grind of the worker thread, run in this process against a fake board. A test only: the proof of work is trivial there. */
export const grindInProcess: GrindFunction = async (input) => {
  const client = createClient({ transport: http(input.boardUrl) });
  const board = new MsgBoardClient({ request: (argument) => client.request(argument as never) });
  const status = await board.status();
  if (!status.enabled) throw new Error("the node does not run the msgboard module");
  board.setDifficultyFactors(BigInt(status.workMultiplier), BigInt(status.workDivisor));
  const work = await board.grind(input.category, input.payload);
  return {
    rlp: toRLP(work.message),
    hash: work.message.hash,
    nonce: BigInt(work.message.nonce),
    difficulty: BigInt(work.stats.difficulty),
    iterations: BigInt(work.stats.iterations),
    durationMilliseconds: work.stats.duration,
    threads: 1,
  };
};

import { describe, expect, it, vi } from "vitest";
import { MAXIMUM_ATTEMPTS, MAXIMUM_BLOCK_AGE, runGrindJob, type GrindBoard } from "../src/msgboard/grind-job.mjs";

const job = { category: "0xcategory", payload: "0xpayload" };

function boardWith(overrides: Partial<GrindBoard> = {}) {
  const setDifficultyFactors = vi.fn();
  const grind = vi.fn(async () => ({
    message: { hash: "0xhash", nonce: 99n, blockNumber: 1000n },
    stats: { isValid: true, difficulty: 1234n, iterations: 5678n, duration: 42 },
  }));
  const board: GrindBoard = {
    status: async () => ({ enabled: true, workMultiplier: 3, workDivisor: 7 }),
    setDifficultyFactors,
    lastestBlock: async () => ({ number: "0x3e8" }),
    grind,
    ...overrides,
  };
  return { board, setDifficultyFactors, grind };
}

describe("runGrindJob", () => {
  it("grinds at the live floor of the board and reports every figure as text", async () => {
    const { board, setDifficultyFactors, grind } = boardWith();
    const toRLP = vi.fn(() => "0xrlp");
    const reply = await runGrindJob(job, { board, toRLP });
    expect(setDifficultyFactors).toHaveBeenCalledWith(3n, 7n);
    expect(grind).toHaveBeenCalledWith("0xcategory", "0xpayload");
    expect(toRLP).toHaveBeenCalledWith({ hash: "0xhash", nonce: 99n, blockNumber: 1000n });
    expect(reply).toEqual({ ok: true, rlp: "0xrlp", hash: "0xhash", nonce: "99", difficulty: "1234", iterations: "5678", durationMilliseconds: 42 });
  });

  it("refuses a node that does not run the msgboard module, before it does any work", async () => {
    const { board, grind } = boardWith({ status: async () => ({ enabled: false, workMultiplier: 1, workDivisor: 1 }) });
    expect(await runGrindJob(job, { board, toRLP: () => "0x" })).toEqual({ ok: false, error: "the node does not run the msgboard module" });
    expect(grind).not.toHaveBeenCalled();
  });

  it("refuses a search that ended without a valid nonce", async () => {
    const { board } = boardWith({ grind: async () => ({ message: { hash: "0x", nonce: 0n, blockNumber: 0n }, stats: { isValid: false, difficulty: 0n, iterations: 0n, duration: 0 } }) });
    expect(await runGrindJob(job, { board, toRLP: () => "0x" })).toEqual({ ok: false, error: "the proof of work search ended without a valid nonce" });
  });

  it("reports the message of an error, and the text of a value that is not an error", async () => {
    const failing = boardWith({ status: async () => Promise.reject(new Error("connection refused")) });
    expect(await runGrindJob(job, { board: failing.board, toRLP: () => "0x" })).toEqual({ ok: false, error: "connection refused" });
    const odd = boardWith({ status: async () => Promise.reject("plain text") });
    expect(await runGrindJob(job, { board: odd.board, toRLP: () => "0x" })).toEqual({ ok: false, error: "plain text" });
  });

  it("grinds again from fresh inputs when the board raised its floor during the grind", async () => {
    const floors = [{ workMultiplier: 3, workDivisor: 7 }, { workMultiplier: 4, workDivisor: 7 }, { workMultiplier: 4, workDivisor: 7 }, { workMultiplier: 4, workDivisor: 7 }];
    const { board, setDifficultyFactors, grind } = boardWith({ status: async () => ({ enabled: true, ...floors.shift()! }) });
    expect((await runGrindJob(job, { board, toRLP: () => "0x" })).ok).toBe(true);
    expect(grind).toHaveBeenCalledTimes(2);
    expect(setDifficultyFactors.mock.calls).toEqual([[3n, 7n], [4n, 7n]]);
  });

  it("keeps work for a floor that fell, because the board accepts it", async () => {
    const floors = [{ workMultiplier: 3, workDivisor: 7 }, { workMultiplier: 2, workDivisor: 7 }];
    const { board, grind } = boardWith({ status: async () => ({ enabled: true, ...(floors.length > 1 ? floors.shift()! : floors[0]!) }) });
    await runGrindJob(job, { board, toRLP: () => "0x" });
    expect(grind).toHaveBeenCalledOnce();
  });

  it("grinds again when the block of the stamp fell out of the window of the board", async () => {
    const heads = [1000n + BigInt(MAXIMUM_BLOCK_AGE) + 1n, 1000n];
    const { board, grind } = boardWith({ lastestBlock: async () => ({ number: heads.shift()! }) });
    await runGrindJob(job, { board, toRLP: () => "0x" });
    expect(grind).toHaveBeenCalledTimes(2);
  });

  it("keeps a stamp that is exactly as old as allowed", async () => {
    const { board, grind } = boardWith({ lastestBlock: async () => ({ number: 1000n + BigInt(MAXIMUM_BLOCK_AGE) }) });
    await runGrindJob(job, { board, toRLP: () => "0x" });
    expect(grind).toHaveBeenCalledOnce();
  });

  it("gives up restarting after a few attempts and returns the last work", async () => {
    const { board, grind } = boardWith({ lastestBlock: async () => ({ number: 5000 }) });
    expect((await runGrindJob(job, { board, toRLP: () => "0xrlp" })).ok).toBe(true);
    expect(grind).toHaveBeenCalledTimes(MAXIMUM_ATTEMPTS);
  });
});

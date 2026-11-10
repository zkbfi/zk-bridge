import { describe, expect, it, vi } from "vitest";
import { checkWork, difficulty } from "@msgboard/sdk";
import { MAXIMUM_THREADS, NONCES_PER_THREAD, createRangeStamper, loadWasmEngine, stamperForThread, startNonceFor, writeWarning } from "../src/msgboard/grind-stamper.mjs";

const category = `0x${"11".repeat(32)}` as const;
const blockHash = `0x${"ab".repeat(32)}` as const;
const input = { category, data: "0x0102", workMultiplier: 3n, workDivisor: 7n, blockHash } as const;

describe("startNonceFor", () => {
  it("gives each thread its own range of nonces, and every start fits the 32 bits of the engine", () => {
    expect(startNonceFor(0)).toBe(0);
    expect(startNonceFor(1)).toBe(NONCES_PER_THREAD);
    expect(startNonceFor(3)).toBe(3 * NONCES_PER_THREAD);
    expect(startNonceFor(MAXIMUM_THREADS - 1) + NONCES_PER_THREAD).toBe(2 ** 32);
  });
});

describe("createRangeStamper", () => {
  it("asks the engine for the nonces of its range only, and unpacks the 40 byte answer", () => {
    const answer = new Uint8Array(40);
    answer[7] = 9;
    answer.fill(0xcd, 8);
    const engine = vi.fn((_request: object) => answer);
    const stamp = createRangeStamper(engine, 2);
    expect(stamp(input)).toEqual({ nonce: 9n, hash: `0x${"cd".repeat(32)}` });
    const request = engine.mock.calls[0]![0] as Record<string, unknown>;
    expect(request).toMatchObject({ workMultiplier: 3, workDivisor: 7, version: 1, startNonce: 2 * NONCES_PER_THREAD, maxIters: NONCES_PER_THREAD });
    expect(request.category).toEqual(new Uint8Array(32).fill(0x11));
    expect(request.data).toEqual(new Uint8Array([1, 2]));
    expect(request.blockHash).toEqual(new Uint8Array(32).fill(0xab));
  });

  it("goes on to the next range of the thread when a range holds no nonce, a step of one range per thread", () => {
    const answer = new Uint8Array(40);
    answer[7] = 5;
    const engine = vi.fn((request: object) => ((request as { startNonce: number }).startNonce === (1 + 3 * 4) * NONCES_PER_THREAD ? answer : undefined));
    const stamp = createRangeStamper(engine, 1, 4);
    expect(stamp(input).nonce).toBe(5n);
    expect(engine.mock.calls.map((call) => (call[0] as { startNonce: number }).startNonce / NONCES_PER_THREAD)).toEqual([1, 5, 9, 13]);
  });

  it("throws when every range of the thread, up to the 32 bits of the engine, holds no nonce", () => {
    const engine = vi.fn((_request: object) => undefined);
    expect(() => createRangeStamper(engine, 0, 1)(input)).toThrow("no nonce in the ranges of thread 0");
    expect(engine).toHaveBeenCalledTimes(MAXIMUM_THREADS);
    const last = vi.fn((_request: object) => null);
    expect(() => createRangeStamper(last, 1, MAXIMUM_THREADS)(input)).toThrow("no nonce in the ranges of thread 1");
    expect(last).toHaveBeenCalledTimes(1);
  });

  it("starts no new range after the deadline", () => {
    let clock = 1_000;
    const engine = vi.fn((_request: object) => {
      clock += 600;
      return undefined;
    });
    const stamp = createRangeStamper(engine, 0, 1, { deadline: 2_000, now: () => clock });
    expect(() => stamp(input)).toThrow("the time ran out before thread 0 found a nonce");
    expect(engine).toHaveBeenCalledTimes(2);
  });
});

describe("the real engine", () => {
  it("finds valid work in the range of any thread, and a later thread finds other nonces than the first", async () => {
    const engine = await loadWasmEngine();
    const factors = { workMultiplier: 1n, workDivisor: 1_000_000n };
    const base = { category, data: "0xdeadbeef", blockHash, ...factors } as const;
    const first = await createRangeStamper(engine, 0)(base);
    const third = await createRangeStamper(engine, 3)(base);
    for (const [stamp, index] of [[first, 0], [third, 3]] as const) {
      expect(stamp.nonce).toBeGreaterThanOrEqual(BigInt(startNonceFor(index)));
      expect(stamp.nonce).toBeLessThan(BigInt(startNonceFor(index + 1)));
      const message = { ...base, blockNumber: 0n, nonce: stamp.nonce, hash: stamp.hash, version: 1 };
      expect(checkWork(message as never, difficulty(factors, 4))).toBe(stamp.hash);
    }
    expect(third.nonce).not.toBe(first.nonce);
  });
});

describe("stamperForThread", () => {
  it("is the stamper of the thread over the engine that loads", async () => {
    const engine = vi.fn((_request: object) => new Uint8Array(40));
    const stamp = await stamperForThread(1, 4, { load: async () => engine });
    stamp!(input);
    expect(engine.mock.calls[0]![0]).toMatchObject({ startNonce: NONCES_PER_THREAD });
  });

  it("logs the reason and is undefined when the engine does not load, so that the SDK searches by itself", async () => {
    const warn = vi.fn();
    expect(await stamperForThread(2, 4, { load: async () => Promise.reject(new Error("no wasm")), warn })).toBeUndefined();
    expect(warn).toHaveBeenCalledWith("grind_engine_unavailable", { thread: 2, reason: "no wasm" });
  });
});

describe("writeWarning", () => {
  it("writes one JSON line with the level, the event and the fields to the error output", () => {
    const write = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    writeWarning("grind_engine_unavailable", { thread: 1 });
    expect(write).toHaveBeenCalledWith('{"level":"warn","event":"grind_engine_unavailable","thread":1}\n');
    write.mockRestore();
  });

  it("is what stamperForThread logs with by default, and a reason that is not an error becomes its text", async () => {
    const write = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    await stamperForThread(0, 1, { load: async () => Promise.reject("plain") });
    expect(write).toHaveBeenCalledWith(expect.stringContaining('"reason":"plain"'));
    write.mockRestore();
  });
});

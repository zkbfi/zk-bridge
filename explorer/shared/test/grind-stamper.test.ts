import { describe, expect, it, vi } from "vitest";
import { checkWork, difficulty } from "@msgboard/sdk";
import { MAXIMUM_THREADS, NONCES_PER_THREAD, createRangeStamper, loadWasmEngine, stamperForThread, startNonceFor } from "../src/msgboard/grind-stamper.mjs";

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

  it("throws when the range holds no nonce, so that the thread reports it and the others go on", () => {
    expect(() => createRangeStamper(() => undefined, 0)(input)).toThrow("no nonce in the range of thread 0");
    expect(() => createRangeStamper(() => null, 1)(input)).toThrow("no nonce in the range of thread 1");
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
    const stamp = await stamperForThread(1, async () => engine);
    stamp!(input);
    expect(engine.mock.calls[0]![0]).toMatchObject({ startNonce: NONCES_PER_THREAD });
  });

  it("is undefined when the engine does not load, so that the SDK searches by itself", async () => {
    expect(await stamperForThread(0, async () => Promise.reject(new Error("no wasm")))).toBeUndefined();
  });
});

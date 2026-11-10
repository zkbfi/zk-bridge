import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

const workers: FakeWorker[] = [];
const behaviour = vi.hoisted(() => ({ throwOnStart: null as Error | null }));
class FakeWorker extends EventEmitter {
  terminate = vi.fn(async () => 0);
  constructor(
    readonly file: URL,
    readonly options: { workerData: Record<string, string> },
  ) {
    super();
    if (behaviour.throwOnStart !== null) throw behaviour.throwOnStart;
    workers.push(this);
  }
}
vi.mock("node:worker_threads", () => ({ Worker: FakeWorker }));

const { PREFLIGHT_DIFFICULTY, grindPreflight, guardGrind } = await import("../src/msgboard/grind-preflight.js");
const { createRangeStamper, loadWasmEngine } = await import("../src/msgboard/grind-stamper.mjs");

afterEach(() => {
  workers.length = 0;
  behaviour.throwOnStart = null;
  vi.useRealTimers();
});

/** What a healthy worker answers: a real stamp from the real engine, for the message that the preflight sent. */
async function realAnswer(worker: FakeWorker) {
  const data = worker.options.workerData;
  const stamp = createRangeStamper(await loadWasmEngine(), 0)({
    category: data.category!,
    data: data.data!,
    blockHash: data.blockHash!,
    workMultiplier: BigInt(data.workMultiplier!),
    workDivisor: BigInt(data.workDivisor!),
  });
  return { ok: true, nonce: stamp.nonce.toString(), hash: stamp.hash };
}

describe("grindPreflight", () => {
  it("asks a worker for a proof of work of difficulty 256 and accepts a nonce that the SDK check accepts", async () => {
    const result = grindPreflight();
    const worker = workers[0]!;
    expect(worker.file.pathname.endsWith("/src/msgboard/grind-preflight-worker.mjs")).toBe(true);
    expect(PREFLIGHT_DIFFICULTY).toBe(256n);
    worker.emit("message", await realAnswer(worker));
    const done = await result;
    expect(done.ok).toBe(true);
    expect(done).toEqual({ ok: true, durationMilliseconds: expect.any(Number) });
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it("reports load-failed when the worker says the engine did not load, or crashes, or does not start", async () => {
    const loading = grindPreflight();
    workers[0]!.emit("message", { ok: false, stage: "load", error: "no wasm" });
    expect(await loading).toEqual({ ok: false, reason: "load-failed", detail: "no wasm" });
    const crashing = grindPreflight();
    workers[1]!.emit("error", new Error("out of memory"));
    expect(await crashing).toEqual({ ok: false, reason: "load-failed", detail: "the worker crashed: out of memory" });
    behaviour.throwOnStart = new Error("no threads");
    expect(await grindPreflight()).toEqual({ ok: false, reason: "load-failed", detail: "the worker did not start: no threads" });
    behaviour.throwOnStart = "plain" as never;
    expect(await grindPreflight()).toEqual({ ok: false, reason: "load-failed", detail: "the worker did not start: plain" });
  });

  it("reports wrong-result for a nonce that is not valid work, a hash that does not match, and a search that fails", async () => {
    const invalid = grindPreflight();
    workers[0]!.emit("message", { ok: true, nonce: "1", hash: `0x${"00".repeat(32)}` });
    expect(await invalid).toMatchObject({ ok: false, reason: "wrong-result", detail: expect.stringContaining("not valid work") });
    const mismatch = grindPreflight();
    const answer = await realAnswer(workers[1]!);
    workers[1]!.emit("message", { ...answer, hash: `0x${"11".repeat(32)}` });
    expect(await mismatch).toMatchObject({ ok: false, reason: "wrong-result" });
    const failing = grindPreflight();
    workers[2]!.emit("message", { ok: false, stage: "search", error: "no nonce in the ranges of thread 0" });
    expect(await failing).toEqual({ ok: false, reason: "wrong-result", detail: "no nonce in the ranges of thread 0" });
  });

  it("reports a timeout and stops the worker when it does not answer in time", async () => {
    vi.useFakeTimers();
    const result = grindPreflight({ timeoutMilliseconds: 2_000 });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await result).toEqual({ ok: false, reason: "timeout", detail: "no proof of work within 2000 milliseconds" });
    expect(workers[0]!.terminate).toHaveBeenCalledOnce();
  });
});

describe("guardGrind", () => {
  const grind = vi.fn(async () => ({ rlp: "0x", hash: "0x", nonce: 1n, difficulty: 1n, iterations: 1n, durationMilliseconds: 1, threads: 1 }) as never);
  const input = { boardUrl: "http://board.invalid", category: "0xaa", payload: "0xbb", timeoutMilliseconds: 1 } as const;

  it("is the grind itself when the preflight passed or has not run", () => {
    expect(guardGrind(grind, undefined)).toBe(grind);
    expect(guardGrind(grind, { ok: true, durationMilliseconds: 5 })).toBe(grind);
  });

  it("rejects with the reason, and never grinds, when the preflight failed", async () => {
    const guarded = guardGrind(grind, { ok: false, reason: "load-failed", detail: "no wasm" });
    await expect(guarded(input)).rejects.toThrow("the proof-of-work engine failed its start-up test (load-failed: no wasm), so no proof of work is started");
    expect(grind).not.toHaveBeenCalled();
  });
});

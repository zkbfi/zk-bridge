import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

const workers: FakeWorker[] = [];
class FakeWorker extends EventEmitter {
  terminate = vi.fn(async () => 0);
  constructor(
    readonly file: URL,
    readonly options: { workerData: unknown },
  ) {
    super();
    workers.push(this);
  }
}
vi.mock("node:worker_threads", () => ({ Worker: FakeWorker }));

const { GrindError, grindInWorker } = await import("../src/msgboard/grind.js");

const input = { boardUrl: "https://node.example/rpc/secret", category: "0xaa", payload: "0xbb", timeoutMilliseconds: 5_000 } as const;

afterEach(() => {
  workers.length = 0;
  vi.useRealTimers();
});

describe("grindInWorker", () => {
  it("starts the worker module with the endpoint, the message and the limit in the worker data", () => {
    void grindInWorker(input);
    expect(workers[0]!.file.pathname.endsWith("/src/msgboard/grind-worker.mjs")).toBe(true);
    expect(workers[0]!.options.workerData).toEqual({ url: input.boardUrl, category: "0xaa", payload: "0xbb", timeoutMilliseconds: 5_000 });
  });

  it("turns the reply of the worker into a result with numbers as bigint, and stops the worker", async () => {
    const result = grindInWorker(input);
    workers[0]!.emit("message", { ok: true, rlp: "0xrlp", hash: "0xhash", nonce: "9", difficulty: "10", iterations: "11", durationMilliseconds: 12 });
    expect(await result).toEqual({ rlp: "0xrlp", hash: "0xhash", nonce: 9n, difficulty: 10n, iterations: 11n, durationMilliseconds: 12 });
    expect(workers[0]!.terminate).toHaveBeenCalledOnce();
  });

  it("rejects with the error that the worker reports", async () => {
    const result = grindInWorker(input);
    workers[0]!.emit("message", { ok: false, error: "the node does not run the msgboard module" });
    await expect(result).rejects.toThrow(new GrindError("the node does not run the msgboard module"));
    expect(workers[0]!.terminate).toHaveBeenCalledOnce();
  });

  it("rejects when the worker crashes, and names the cause", async () => {
    const result = grindInWorker(input);
    workers[0]!.emit("error", new Error("out of memory"));
    await expect(result).rejects.toThrow("the grind worker crashed: out of memory");
    expect(workers[0]!.terminate).toHaveBeenCalledOnce();
  });

  it("stops the worker and rejects when it outlives the limit", async () => {
    vi.useFakeTimers();
    const result = grindInWorker(input);
    const assertion = expect(result).rejects.toThrow("the proof of work did not finish in 5000 milliseconds");
    await vi.advanceTimersByTimeAsync(4_999);
    expect(workers[0]!.terminate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await assertion;
    expect(workers[0]!.terminate).toHaveBeenCalledOnce();
  });
});

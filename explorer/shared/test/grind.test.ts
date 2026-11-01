import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

const workers: FakeWorker[] = [];
class FakeWorker extends EventEmitter {
  terminate = vi.fn(async () => 0);
  constructor(
    readonly file: URL,
    readonly options: { workerData: Record<string, unknown> },
  ) {
    super();
    workers.push(this);
  }
}
vi.mock("node:worker_threads", () => ({ Worker: FakeWorker }));
const parallelism = vi.hoisted(() => ({ cores: 4 }));
vi.mock("node:os", () => ({ availableParallelism: () => parallelism.cores }));

const { GrindError, grindInWorker, grindOnThreads, threadsForGrind } = await import("../src/msgboard/grind.js");

const input = { boardUrl: "https://node.example/rpc/secret", category: "0xaa", payload: "0xbb", timeoutMilliseconds: 5_000 } as const;
const found = { ok: true, rlp: "0xrlp", hash: "0xhash", nonce: "9", difficulty: "10", iterations: "11", durationMilliseconds: 12 };

afterEach(() => {
  workers.length = 0;
  parallelism.cores = 4;
  vi.useRealTimers();
});

describe("threadsForGrind", () => {
  it("is one thread per core, at least one, and no more than the nonce ranges allow", () => {
    parallelism.cores = 4;
    expect(threadsForGrind()).toBe(4);
    parallelism.cores = 0;
    expect(threadsForGrind()).toBe(1);
    parallelism.cores = 512;
    expect(threadsForGrind()).toBe(64);
  });
});

describe("grindInWorker", () => {
  it("starts one worker per core, each with the endpoint, the message, the limit and its own thread number", () => {
    parallelism.cores = 4;
    void grindInWorker(input);
    expect(workers).toHaveLength(4);
    workers.forEach((worker, index) => {
      expect(worker.file.pathname.endsWith("/src/msgboard/grind-worker.mjs")).toBe(true);
      expect(worker.options.workerData).toEqual({ url: input.boardUrl, category: "0xaa", payload: "0xbb", timeoutMilliseconds: 5_000, threadIndex: index });
    });
  });
});

describe("grindOnThreads", () => {
  it("takes the first worker that finds the work, reports the thread count, and stops every worker", async () => {
    const result = grindOnThreads(input, 3);
    workers[1]!.emit("message", found);
    expect(await result).toEqual({ rlp: "0xrlp", hash: "0xhash", nonce: 9n, difficulty: 10n, iterations: 11n, durationMilliseconds: 12, threads: 3 });
    for (const worker of workers) expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it("ignores a second answer after the first", async () => {
    const result = grindOnThreads(input, 2);
    workers[0]!.emit("message", found);
    workers[1]!.emit("message", { ...found, nonce: "77" });
    expect((await result).nonce).toBe(9n);
  });

  it("goes on when one worker fails and another finds the work", async () => {
    const result = grindOnThreads(input, 3);
    workers[0]!.emit("message", { ok: false, error: "no nonce in the range of thread 0" });
    workers[1]!.emit("error", new Error("out of memory"));
    workers[2]!.emit("message", found);
    expect((await result).threads).toBe(3);
  });

  it("ignores a crash that comes after the work was found", async () => {
    const result = grindOnThreads(input, 2);
    workers[0]!.emit("message", found);
    workers[1]!.emit("error", new Error("terminated"));
    expect((await result).nonce).toBe(9n);
  });

  it("rejects with the first error when every worker reports an error", async () => {
    const result = grindOnThreads(input, 2);
    const assertion = expect(result).rejects.toThrow(new GrindError("the node does not run the msgboard module"));
    workers[0]!.emit("message", { ok: false, error: "the node does not run the msgboard module" });
    workers[1]!.emit("message", { ok: false, error: "connection refused" });
    await assertion;
    for (const worker of workers) expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it("rejects when every worker crashes, and names the cause", async () => {
    const result = grindOnThreads(input, 1);
    workers[0]!.emit("error", new Error("out of memory"));
    await expect(result).rejects.toThrow("the grind worker crashed: out of memory");
    expect(workers[0]!.terminate).toHaveBeenCalledOnce();
  });

  it("stops every worker and rejects when they outlive the limit", async () => {
    vi.useFakeTimers();
    const result = grindOnThreads(input, 2);
    const assertion = expect(result).rejects.toThrow("the proof of work did not finish in 5000 milliseconds");
    await vi.advanceTimersByTimeAsync(4_999);
    expect(workers[0]!.terminate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await assertion;
    for (const worker of workers) expect(worker.terminate).toHaveBeenCalledOnce();
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";

const startPublisher = vi.fn(async (_input: unknown) => undefined);
const startRunner = vi.fn(async (_input: unknown) => undefined);
const loadBotContext = vi.fn();
vi.mock("../../src/publisher/service.ts", () => ({ startPublisher: (input: unknown) => startPublisher(input) }));
vi.mock("../../src/runner/service.ts", () => ({ startRunner: (input: unknown) => startRunner(input) }));
vi.mock("../../src/runtime/context.ts", () => ({ loadBotContext: (input: unknown) => loadBotContext(input) }));

const { main } = await import("../../src/cli.ts");

const SECRET = "hunter2-hunter2";
const context = { vault: { knownSecrets: () => [SECRET] } };

function captureStandardError() {
  const lines: string[] = [];
  const spy = vi.spyOn(process.stderr, "write").mockImplementation((text: string | Uint8Array) => {
    lines.push(String(text));
    return true;
  });
  return { lines, spy };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("main", () => {
  it("starts the publisher with the context and the once flag, and exits with 0", async () => {
    loadBotContext.mockResolvedValue(context);
    expect(await main(["publisher", "--config", "bots.json", "--once"], { A: "b" })).toBe(0);
    expect(loadBotContext).toHaveBeenCalledWith(expect.objectContaining({ configPath: "bots.json", environment: { A: "b" } }));
    expect(startPublisher).toHaveBeenCalledWith(expect.objectContaining({ context, runOnce: true }));
    expect(startRunner).not.toHaveBeenCalled();
  });

  it("starts the runner and does not start the publisher", async () => {
    loadBotContext.mockResolvedValue(context);
    expect(await main(["runner", "--config", "bots.json"], {})).toBe(0);
    expect(startRunner).toHaveBeenCalledWith(expect.objectContaining({ context, runOnce: false }));
    expect(startPublisher).not.toHaveBeenCalled();
  });

  it("writes each log line of the context to standard error with a line break", async () => {
    const { lines } = captureStandardError();
    loadBotContext.mockImplementation(async (input: { write: (text: string) => void }) => {
      input.write("one");
      return context;
    });
    await main(["runner", "--config", "bots.json"], {});
    expect(lines).toEqual(["one\n"]);
  });

  it("aborts the signal of the bot on SIGINT and on SIGTERM", async () => {
    loadBotContext.mockResolvedValue(context);
    const signals: AbortSignal[] = [];
    startRunner.mockImplementation(async (input: unknown) => {
      signals.push((input as { signal: AbortSignal }).signal);
    });
    const before = { int: process.listeners("SIGINT"), term: process.listeners("SIGTERM") };
    await main(["runner", "--config", "a"], {});
    await main(["runner", "--config", "b"], {});
    expect(signals.map((signal) => signal.aborted)).toEqual([false, false]);
    process.emit("SIGINT");
    expect(signals.map((signal) => signal.aborted)).toEqual([true, true]);
    const second = signals[1]!;
    expect(second.aborted).toBe(true);
    process.emit("SIGTERM");
    for (const listener of process.listeners("SIGINT")) if (!before.int.includes(listener)) process.removeListener("SIGINT", listener);
    for (const listener of process.listeners("SIGTERM")) if (!before.term.includes(listener)) process.removeListener("SIGTERM", listener);
  });

  it("prints a usage error for a bad command line and exits with 1, without loading a context", async () => {
    const { lines } = captureStandardError();
    expect(await main(["relayer"], {})).toBe(1);
    expect(lines.join("")).toContain("Choose publisher or runner.");
    expect(loadBotContext).not.toHaveBeenCalled();
  });

  it("removes every known secret from the error of a failed run", async () => {
    loadBotContext.mockResolvedValue(context);
    startRunner.mockRejectedValue(new Error(`rejected with ${SECRET}`));
    const { lines } = captureStandardError();
    expect(await main(["runner", "--config", "bots.json"], {})).toBe(1);
    expect(lines.join("")).toBe("rejected with [redacted]\n");
  });
});

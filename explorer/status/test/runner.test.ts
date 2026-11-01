import { describe, expect, it, vi } from "vitest";
import { createRunner } from "../src/runner.ts";
import { openStore } from "../src/store.ts";
import type { CheckDefinition } from "../src/types.ts";

const def = (id: string, run: CheckDefinition["run"]): CheckDefinition => ({ id, name: id.toUpperCase(), section: "services", run });

function setup(checks: CheckDefinition[], options: { timeoutMilliseconds?: number } = {}) {
  const store = openStore(":memory:");
  const lines: Array<Record<string, unknown>> = [];
  let clock = 1_000_000;
  const logger = {
    debug: vi.fn(),
    info: (event: string, fields?: object) => lines.push({ event, ...fields }),
    warn: (event: string, fields?: object) => lines.push({ event, ...fields }),
    error: (event: string, fields?: object) => lines.push({ event, ...fields }),
  };
  const runner = createRunner({
    checks,
    store,
    logger,
    now: () => (clock += 10),
    timeoutMilliseconds: options.timeoutMilliseconds ?? 50,
    retentionMilliseconds: 30 * 86_400_000,
    secrets: () => ["sekret-value"],
  });
  return { store, lines, runner };
}

describe("runner", () => {
  it("runs every check, times it, and stores the results", async () => {
    const { runner, store } = setup([def("a", async () => ({ state: "ok", detail: "fine" })), def("b", async () => ({ state: "degraded", detail: "slow" }))]);
    const results = await runner.runRound();
    expect(results.map((result) => [result.id, result.state, result.detail])).toEqual([
      ["a", "ok", "fine"],
      ["b", "degraded", "slow"],
    ]);
    expect(results[0]?.latencyMs).toBeGreaterThan(0);
    expect(store.current().map((entry) => entry.name)).toEqual(["A", "B"]);
  });

  it("turns a throw into down with a detail that holds no URL and no secret", async () => {
    const { runner } = setup([def("a", async () => { throw new Error("fetch https://rpc.example.org/sekret-value failed with sekret-value"); })]);
    const [result] = await runner.runRound();
    expect(result).toMatchObject({ state: "down", detail: "fetch [url] failed with [redacted]" });
  });

  it("turns a non-error throw into down and a check that never answers into a timeout", async () => {
    const { runner } = setup([
      def("a", async () => { throw "plain text"; }),
      def("b", () => new Promise(() => {})),
    ]);
    const results = await runner.runRound();
    expect(results[0]).toMatchObject({ state: "down", detail: "plain text" });
    expect(results[1]).toMatchObject({ state: "down", detail: "no answer within 0.05 s" });
  });

  it("logs a change of state once, with the name", async () => {
    let state: "ok" | "down" = "ok";
    const { runner, lines } = setup([def("a", async () => ({ state, detail: state }))]);
    await runner.runRound();
    await runner.runRound();
    state = "down";
    await runner.runRound();
    expect(lines.filter((line) => line.event === "check_changed")).toEqual([
      { event: "check_changed", check: "a", from: "ok", to: "down", detail: "down" },
    ]);
  });

  it("ignores a round that starts while the last one runs, and prunes once a day", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { runner, store, lines } = setup([def("a", async () => { await gate; return { state: "ok", detail: "" }; })]);
    const first = runner.runRound();
    expect(await runner.runRound()).toEqual([]);
    release();
    await first;
    expect(lines.some((line) => line.event === "pruned")).toBe(true);
    const count = lines.filter((line) => line.event === "pruned").length;
    await runner.runRound();
    expect(lines.filter((line) => line.event === "pruned")).toHaveLength(count);
    expect(store.size()).toBe(2);
  });

  it("logs a failing store and goes on", async () => {
    const { runner, store, lines } = setup([def("a", async () => ({ state: "ok", detail: "" }))]);
    vi.spyOn(store, "record").mockImplementation(() => { throw new Error("disk full"); });
    expect(await runner.runRound()).toHaveLength(1);
    expect(lines).toContainEqual(expect.objectContaining({ event: "store_failed" }));
  });

  it("stops without having started", async () => {
    const { runner } = setup([]);
    await runner.stop();
  });

  it("starts at once, repeats on the timer and stops", async () => {
    vi.useFakeTimers();
    const run = vi.fn(async () => ({ state: "ok" as const, detail: "" }));
    const { runner } = setup([def("a", run)]);
    runner.start(1000);
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2000);
    expect(run).toHaveBeenCalledTimes(3);
    await runner.stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(run).toHaveBeenCalledTimes(3);
    vi.useRealTimers();
  });
});

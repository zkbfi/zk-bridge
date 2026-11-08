import { describe, expect, it, vi } from "vitest";
import { createAlerter } from "../src/alerts.ts";
import { createRunner } from "../src/runner.ts";
import { openStore } from "../src/store.ts";
import type { CheckDefinition } from "../src/types.ts";

const def = (id: string, run: CheckDefinition["run"]): CheckDefinition => ({ id, name: id.toUpperCase(), section: "services", run });

function setup(checks: CheckDefinition[], options: { timeoutMilliseconds?: number; store?: ReturnType<typeof openStore>; hook?: typeof fetch } = {}) {
  const store = options.store ?? openStore(":memory:");
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
    alerter: options.hook === undefined ? undefined : createAlerter({ url: "https://hooks.example.org/sekret-value", checks: undefined, fetch: options.hook, logger, now: () => 42, secrets: () => ["sekret-value"] }),
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

  describe("alerts", () => {
    const deadline = (state: () => "ok" | "degraded" | "down") => def("lightclient-deadline-x", async () => ({ state: state(), detail: `state ${state()}` }));
    const hook = () => {
      const posts: Array<{ url: string; init: RequestInit; body: Record<string, unknown> }> = [];
      const fn = vi.fn(async (url: string, init: RequestInit) => {
        posts.push({ url, init, body: JSON.parse(String(init.body)) });
        return new Response("", { status: 200 });
      });
      return { fn: fn as unknown as typeof fetch, posts };
    };

    it("posts once when a watched check enters down, not while it stays down, and once when it recovers", async () => {
      let state: "ok" | "degraded" | "down" = "ok";
      const { fn, posts } = hook();
      const { runner } = setup([deadline(() => state), def("other", async () => ({ state: "down", detail: "x" }))], { hook: fn });
      await runner.runRound();
      expect(posts).toHaveLength(0);
      state = "degraded";
      await runner.runRound();
      expect(posts).toHaveLength(0);
      state = "down";
      await runner.runRound();
      await runner.runRound();
      expect(posts).toHaveLength(1);
      expect(posts[0]?.url).toBe("https://hooks.example.org/sekret-value");
      expect(posts[0]?.init).toMatchObject({ method: "POST", headers: { "content-type": "application/json" } });
      expect(posts[0]?.body).toEqual({ text: "LIGHTCLIENT-DEADLINE-X: state down", content: "LIGHTCLIENT-DEADLINE-X: state down", check: "lightclient-deadline-x", name: "LIGHTCLIENT-DEADLINE-X", state: "down", detail: "state down", at: 42 });
      state = "ok";
      await runner.runRound();
      expect(posts).toHaveLength(2);
      expect(posts[1]?.body).toMatchObject({ state: "ok", text: "LIGHTCLIENT-DEADLINE-X recovered: state ok" });
      await runner.runRound();
      expect(posts).toHaveLength(2);
    });

    it("posts when a watched check is down in the first round it is seen", async () => {
      const { fn, posts } = hook();
      const { runner } = setup([deadline(() => "down")], { hook: fn });
      await runner.runRound();
      expect(posts).toHaveLength(1);
    });

    it("does not post after a restart when the store already holds down, and posts when it held ok", async () => {
      const { fn, posts } = hook();
      const first = setup([deadline(() => "down")]);
      await first.runner.runRound();
      const restarted = setup([deadline(() => "down")], { store: first.store, hook: fn });
      await restarted.runner.runRound();
      expect(posts).toHaveLength(0);
      const okStore = setup([deadline(() => "ok")]);
      await okStore.runner.runRound();
      await setup([deadline(() => "down")], { store: okStore.store, hook: fn }).runner.runRound();
      expect(posts).toHaveLength(1);
    });

    it("posts nothing without an alerter", async () => {
      const { runner } = setup([deadline(() => "down")]);
      expect(await runner.runRound()).toHaveLength(1);
    });

    it("logs a refused post with the status and a thrown one with the message, never the URL, and the round goes on", async () => {
      const refused = setup([deadline(() => "down")], { hook: (async () => new Response("", { status: 500 })) as unknown as typeof fetch });
      expect(await refused.runner.runRound()).toHaveLength(1);
      const thrown = setup([deadline(() => "down")], { hook: (async () => { throw new Error("connect to https://hooks.example.org/sekret-value failed"); }) as unknown as typeof fetch });
      await thrown.runner.runRound();
      const odd = setup([deadline(() => "down")], { hook: (async () => { throw "plain"; }) as unknown as typeof fetch });
      await odd.runner.runRound();
      expect(refused.lines).toContainEqual({ event: "alert_failed", check: "lightclient-deadline-x", status: 500 });
      expect(thrown.lines).toContainEqual({ event: "alert_failed", check: "lightclient-deadline-x", error: "connect to [url] failed" });
      expect(odd.lines).toContainEqual({ event: "alert_failed", check: "lightclient-deadline-x", error: "plain" });
      expect(JSON.stringify([refused.lines, thrown.lines, odd.lines])).not.toContain("hooks.example.org");
    });

    it("watches explicit ids when the configuration names them", async () => {
      const { fn, posts } = hook();
      const store = openStore(":memory:");
      const logger = { debug() {}, info() {}, warn() {}, error() {} };
      const runner = createRunner({
        checks: [deadline(() => "down"), def("rpc-1", async () => ({ state: "down", detail: "slow" }))],
        store,
        logger,
        now: () => 1,
        timeoutMilliseconds: 50,
        retentionMilliseconds: 1e9,
        secrets: () => [],
        alerter: createAlerter({ url: "https://h.example.org/x", checks: ["rpc-1"], fetch: fn, logger, now: () => 1, secrets: () => [] }),
      });
      await runner.runRound();
      expect(posts.map((post) => post.body.check)).toEqual(["rpc-1"]);
    });
  });
});

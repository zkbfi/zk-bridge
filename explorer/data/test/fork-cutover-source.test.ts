import { describe, expect, it, vi } from "vitest";
import { fetchSourceForks } from "../src/fork-cutover-source.js";

const answers: Record<string, unknown> = {
  "/eth/v1/config/fork_schedule": { data: [{ current_version: "0x90000070", epoch: "50" }] },
  "/eth/v1/beacon/genesis": { data: { genesis_time: "1000" } },
  "/eth/v1/config/spec": { data: { SECONDS_PER_SLOT: "12", SLOTS_PER_EPOCH: "32" } },
};

const good = (calls: string[] = []) =>
  vi.fn(async (url: string) => {
    calls.push(url);
    const path = url.replace(/^https:\/\/[a-z]+/, "");
    return new Response(JSON.stringify(answers[path]), { status: 200 });
  });

describe("fetchSourceForks", () => {
  it("reads the schedule and the clock", async () => {
    const calls: string[] = [];
    const result = await fetchSourceForks({ urls: ["https://a/"], fetch: good(calls) });
    expect(result).toEqual({ kind: "known", forks: [{ version: "0x90000070", epoch: 50, name: "Phase 0" }], clock: { genesisTime: 1000, secondsPerSlot: 12, slotsPerEpoch: 32 } });
    expect(calls).toHaveLength(3);
    expect(calls[0]).toBe("https://a/eth/v1/config/fork_schedule");
  });
  it("is unreachable with no endpoint", async () => {
    expect(await fetchSourceForks({ urls: [] })).toEqual({ kind: "unreachable", reason: "no beacon endpoint is set for this chain" });
  });
  it("goes to the next endpoint after a failure", async () => {
    const doFetch = vi.fn(async (url: string) => {
      if (url.startsWith("https://bad")) return new Response("no", { status: 503 });
      return good()(url);
    });
    const result = await fetchSourceForks({ urls: ["https://bad", "https://ok"], fetch: doFetch });
    expect(result.kind).toBe("known");
  });
  it("is unreachable when every endpoint fails, with no URL in the reason", async () => {
    const throwing = vi.fn(async () => {
      throw new TypeError("secret-key");
    });
    const one = await fetchSourceForks({ urls: ["https://x/key123"], fetch: throwing });
    expect(one).toEqual({ kind: "unreachable", reason: "the beacon node did not answer (no answer for /eth/v1/config/fork_schedule (TypeError))" });
    const two = await fetchSourceForks({ urls: ["https://x/key123", "https://y"], fetch: vi.fn(async () => new Response("{}", { status: 404 })) });
    expect(two.kind === "unreachable" && two.reason).toContain("all 2 beacon nodes did not answer (answered 404");
  });
  it("is unreachable when the answer has another form", async () => {
    const result = await fetchSourceForks({ urls: ["https://a"], fetch: vi.fn(async () => new Response(JSON.stringify({ nope: 1 }), { status: 200 })) });
    expect(result.kind).toBe("unreachable");
  });
  it("uses the global fetch by default", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = good() as unknown as typeof fetch;
    try {
      expect((await fetchSourceForks({ urls: ["https://a"], timeoutMilliseconds: 1000 })).kind).toBe("known");
    } finally {
      globalThis.fetch = original;
    }
  });
});

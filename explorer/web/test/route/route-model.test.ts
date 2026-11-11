import { describe, expect, it } from "vitest";
import { routeBlockersOf } from "@zk-bridge/shared";
import { FIXTURE_PAIR } from "@terminal/data/fixtures";
import { blockerNotice, clockText, constraintLines, relativeText, requestRefusal, situationLines, spanClock, stepSubtitle, stepTitle } from "../../src/route/route-model";
import { MESSAGE, NOW_MS, stepOf } from "./fixtures";

const context = { pair: FIXTURE_PAIR, nowMs: NOW_MS };
const names = FIXTURE_PAIR;

describe("the situation of a step, in numbers", () => {
  it("says how far behind a light client is, how many transfers wait and when it strands", () => {
    expect(situationLines(stepOf("light-client-update"), context)[0]).toMatch(/^Ethereum's light client on PulseChain is 19 h behind; 3 transfers wait for it; it strands in 8 h \(\d\d:\d\d UTC\)\.$/);
    expect(situationLines(stepOf("light-client-update", { direction: null }), context)[0]).toContain("Ethereum's light client on PulseChain");
    expect(situationLines(stepOf("light-client-update", { situation: { behindSeconds: null, waitingTransfers: 1, strandsAt: null } }), context)[0]).toBe("Ethereum's light client on PulseChain has no head read; 1 transfer waits for it.");
  });

  it("holds up sends and deliveries in words", () => {
    expect(situationLines(stepOf("light-client-update", { situation: { blocks: ["sends", "deliveries"] } }), context)[1]).toBe("It holds up new sends and deliveries.");
    expect(situationLines(stepOf("open-deposits", { situation: { blocks: ["sends"] } }), context)[1]).toBe("It holds up new sends.");
  });

  it("covers the registry light client, the fork observation and the opening", () => {
    expect(situationLines(stepOf("registry-light-client-update"), context)[0]).toContain("The fork registry's light client on PulseChain is 19 h behind; it reaches its 64-period limit in 8 h");
    expect(situationLines(stepOf("registry-light-client-update", { situation: { behindSeconds: null, strandsAt: null } }), context)[0]).toBe("The fork registry's light client on PulseChain has no head read.");
    expect(situationLines(stepOf("fork-observation", { situation: { activeVersion: "0x90000075", recordedVersion: "0x80000075", waitingTransfers: 0 } }), context)[0]).toBe("PulseChain runs fork version 0x90000075; the fork registry holds 0x80000075.");
    expect(situationLines(stepOf("fork-observation", { situation: { waitingTransfers: 0 } }), context)[0]).toBe("PulseChain runs fork version unknown; the fork registry holds none.");
    expect(situationLines(stepOf("open-deposits"), context)[0]).toMatch(/^Deposits on PulseChain are closed since \d\d:\d\d UTC; 3 transfers wait for it\.$/);
    expect(situationLines(stepOf("open-deposits", { situation: { since: null, waitingTransfers: 0 } }), context)[0]).toBe("Deposits on PulseChain are closed.");
  });

  it("covers layout rows, a delivery and a seal", () => {
    expect(situationLines(stepOf("layout-rows", { situation: { layoutRows: 2 } }), context)[0]).toBe("2 layout rows must be posted on PulseChain before this transfer can be delivered.");
    expect(situationLines(stepOf("layout-rows", { situation: { layoutRows: null, waitingTransfers: 0 } }), context)[0]).toBe("0 layout rows must be posted on PulseChain before this transfer can be delivered.");
    expect(situationLines(stepOf("deliver", { situation: { layoutRows: 1, waitingTransfers: 0 } }), context)[0]).toBe("This transfer is covered on PulseChain and waits for its delivery; 1 layout row first.");
    expect(situationLines(stepOf("deliver", { situation: { layoutRows: 0, waitingTransfers: 0 } }), context)[0]).toBe("This transfer is covered on PulseChain and waits for its delivery.");
    expect(situationLines(stepOf("deliver", { situation: { layoutRows: null, waitingTransfers: 0 } }), context)[0]).toBe("This transfer is covered on PulseChain and waits for its delivery.");
    expect(situationLines(stepOf("seal"), context)[0]).toContain("The Ethereum deposit gate can be sealed now");
  });
});

describe("the constraints of a step, in numbers", () => {
  const text = (step = stepOf("light-client-update"), steps = [step]) => constraintLines(step, context, steps).map((line) => line.text);

  it("gives the finality time, the GPU time, the budget, the gas and cost, and who posts otherwise", () => {
    const lines = text();
    expect(lines[0]).toMatch(/^The next block becomes final at \d\d:\d\d UTC \(in 12 min\); the newest final slot is 11530720\.$/);
    expect(lines[1]).toBe("The proof takes about 1 min on a warm worker; about 5 min if a worker has to start. No worker is warm now.");
    expect(lines[2]).toBe("$3.40 of the $5.00 GPU budget for this direction is left today.");
    expect(lines[3]).toMatch(/^Posting uses 310,000 gas \(simulated with the proof\), about \S+ PLS at 2 gwei\.$/);
    expect(lines[4]).toMatch(/^If nobody posts it, the backend posts it at \d\d:\d\d UTC \(in 3 h\)\.$/);
  });

  it("names the finality that has come, a warm worker and a missing timing", () => {
    const now = text(stepOf("light-client-update", { constraints: { finality: { finalizedSlot: 5, nextAt: NOW_MS - 1000 }, gpu: { warmMs: null, coldMs: null, workerWarm: true, budgetUsd: 5, spentUsd: 0, leftUsd: 5 } } }));
    expect(now[0]).toMatch(/^The newest final slot is 5; the next block becomes final about now/);
    expect(now[1]).toBe("The proof runs on the GPU. A worker is warm now.");
    expect(text(stepOf("light-client-update", { constraints: { gpu: null } }))[1]).toBe("The proof runs on the GPU; the backend has no timing for it yet.");
  });

  it("says a step without GPU is built in seconds, and a step without finality has no finality line", () => {
    const lines = text(stepOf("open-deposits", { constraints: { finality: null } }));
    expect(lines[0]).toBe("The proof is built in a few seconds from chain data; it uses no GPU.");
  });

  it("says that a running job is joined, and the step that lands first", () => {
    const first = stepOf("open-deposits");
    const lines = text(stepOf("deliver", { constraints: { job: { jobId: "j1", status: "running", startedAt: NOW_MS - 120_000 }, after: first.id } }), [first]);
    expect(lines).toContain("A proof for this finality is being made (started 2 min ago): you join it.");
    expect(lines).toContain("It lands after: Open deposits, Ethereum to PulseChain: opens deposits on the PulseChain bridge.");
    expect(text(stepOf("deliver", { constraints: { after: "x:1" } }), [])).toContain("It lands after: x:1.");
  });

  it("says the gas is known with the proof, the fallback gas, a cost without a price, and the runner's time", () => {
    expect(text(stepOf("deliver", { constraints: { posting: { gas: null, gasSource: null, gasPriceWei: null, costWei: null } } }))).toContain("The gas of the posting transaction is known once the proof exists.");
    expect(text(stepOf("deliver", { constraints: { posting: { gas: "100000", gasSource: "fallback", gasPriceWei: null, costWei: null } } }))).toContain("Posting uses 100,000 gas (the figure the backend's own posting uses).");
    expect(text(stepOf("deliver", { constraints: { posting: { gas: "100000", gasSource: "simulated", gasPriceWei: "5", costWei: "500000" } } })).find((line) => line.startsWith("Posting"))).toMatch(/^Posting uses 100,000 gas \(simulated with the proof\), about \S+ PLS at 5 wei\.$/);
    expect(text(stepOf("deliver", { fallback: { by: "runner", at: null } }))).toContain("If nobody posts it, the runner posts it as soon as it can.");
    expect(text(stepOf("deliver", { fallback: null })).some((line) => line.startsWith("If nobody"))).toBe(false);
  });
});

describe("the words of a request", () => {
  it("has none for an accepted request", () => {
    expect(requestRefusal({ jobId: "j" }, NOW_MS)).toBeNull();
  });

  it("says what each refusal means and when the button comes back", () => {
    expect(requestRefusal(null, NOW_MS)).toEqual({ note: "The backend did not take the request. Try again in 1 min.", retryAt: NOW_MS + 60_000 });
    expect(requestRefusal({ refused: "nothing-to-prove", why: "proof-pending" }, NOW_MS)).toEqual({ note: "A proof is made already and waits to land.", retryAt: null });
    expect(requestRefusal({ refused: "nothing-to-prove", why: "no-need" }, NOW_MS)?.note).toBe("This step is not pending any more.");
    expect(requestRefusal({ refused: "cannot-check", retryAfterSeconds: 30 }, NOW_MS)).toEqual({ note: "The backend could not read the chains. Try again in 30 s.", retryAt: NOW_MS + 30_000 });
    expect(requestRefusal({ refused: "not-served" }, NOW_MS)).toEqual({ note: "This backend does not make this proof.", retryAt: null });
    expect(requestRefusal({ refused: "rate-limited", retryAfterSeconds: 600, why: "same-finality" }, NOW_MS)?.note).toBe("A proof for the newest finality is already made or running. The next finality comes in about 10 min.");
    expect(requestRefusal({ refused: "rate-limited", retryAfterSeconds: 7200, why: "gpu-budget" }, NOW_MS)?.note).toBe("The 24-hour GPU budget of this direction is used up. It frees in about 2 h.");
    expect(requestRefusal({ refused: "rate-limited", retryAfterSeconds: 0 }, NOW_MS)).toEqual({ note: "Too many requests from this address. Try again in 1 s.", retryAt: NOW_MS + 1000 });
    expect(requestRefusal({ refused: "rate-limited", retryAfterSeconds: 60, why: "limit", detail: "the last proof of this step failed" }, NOW_MS)).toEqual({ note: "The last proof of this step failed. Try again in 1 min.", retryAt: NOW_MS + 60_000 });
  });
});

describe("headings and small helpers", () => {
  it("names each kind with its route, chain or transfer", () => {
    expect(stepTitle(stepOf("deliver"))).toBe("Deliver a message");
    expect(stepSubtitle(stepOf("light-client-update"), names)).toBe("Ethereum to PulseChain: posts to the PulseChain light client");
    expect(stepSubtitle(stepOf("light-client-update", { direction: null }), names)).toContain("Ethereum to PulseChain");
    expect(stepSubtitle(stepOf("open-deposits", { direction: "second-to-first" }), names)).toBe("PulseChain to Ethereum: opens deposits on the Ethereum bridge");
    expect(stepSubtitle(stepOf("open-deposits", { direction: null }), names)).toContain("Ethereum to PulseChain");
    expect(stepSubtitle(stepOf("registry-light-client-update"), names)).toBe("PulseChain fork registry");
    expect(stepSubtitle(stepOf("fork-observation"), names)).toBe("PulseChain fork registry");
    expect(stepSubtitle(stepOf("seal"), names)).toBe("Ethereum deposit gate");
    expect(stepSubtitle(stepOf("deliver"), names)).toBe(`Transfer ${MESSAGE}, delivered on PulseChain`);
    expect(stepSubtitle(stepOf("deliver", { messageId: null }), names)).toBe(`Transfer ${MESSAGE}, delivered on PulseChain`);
  });

  it("formats times and spans", () => {
    expect(clockText(Date.UTC(2026, 10, 11, 14, 32))).toBe("14:32 UTC");
    expect(relativeText(NOW_MS + 90_000, NOW_MS)).toBe("in 2 min");
    expect(relativeText(NOW_MS - 7200_000, NOW_MS)).toBe("2 h ago");
    expect(spanClock(72_000)).toBe("1:12");
    expect(spanClock(-5)).toBe("0:00");
  });
});

describe("the notice of the Bridge screen", () => {
  it("is null without a blocker", () => {
    expect(blockerNotice([], context)).toBeNull();
  });

  it("says what holds up sends and deliveries, with the count of the others", () => {
    expect(blockerNotice([stepOf("open-deposits")], context)).toBe("Deposits on PulseChain are closed until someone posts the opening proof.");
    expect(blockerNotice([stepOf("seal"), stepOf("open-deposits")], context)).toBe("The Ethereum deposit gate can be sealed, which stops every send through it. 1 more step waits too.");
    expect(blockerNotice([stepOf("light-client-update"), stepOf("seal"), stepOf("open-deposits")], context)).toBe("The PulseChain light client for Ethereum strands in 8 h unless someone posts an update. 2 more steps wait too.");
    expect(blockerNotice([stepOf("light-client-update", { situation: { strandsAt: null } })], context)).toBe("The PulseChain light client for Ethereum strands unless someone posts an update.");
    expect(blockerNotice([stepOf("light-client-update", { direction: null })], context)).toContain("for Ethereum");
  });

  it("goes with routeBlockersOf: a light client far from stranding is not a blocker", () => {
    expect(routeBlockersOf([stepOf("light-client-update", { situation: { strandsAt: NOW_MS + 30 * 3_600_000 } })], NOW_MS)).toEqual([]);
  });
});

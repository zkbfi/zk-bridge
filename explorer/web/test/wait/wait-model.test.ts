import { describe, expect, it } from "vitest";
import { MIN_SAMPLES, SANE_LIMITS, basisText, buildTimeline, clockText, durationText, feeVerdict, provingOf, rangeText, remainingOf, ruleOf, timingFor, type ProofRule, type WaitInputs } from "../../src/wait/wait-model";
import type { WindowTiming } from "../../src/explore/explore-source";

/** Dollars as USD × 1e18. */
const usd = (dollars: number): bigint => BigInt(Math.round(dollars * 1e6)) * 10n ** 12n;

const SEPOLIA = 11155111;
const rule = (overrides: Partial<ProofRule> = {}): ProofRule => ({ minIntervalSeconds: 3600, profitMargin: 1.5, proofCostUsd: 0.025, priced: false, ...overrides });
const spread = (median: number | null, p90: number | null) => ({ avg: null, median, p90 });
const timing = (count: number, overrides: Partial<WindowTiming> = {}): WindowTiming => ({ count, sentToDelivered: spread(900, 4000), steps: [spread(760, 790), spread(600, 3600), spread(30, 200)], ...overrides });
const inputs = (overrides: Partial<WaitInputs> = {}): WaitInputs => ({ sourceChainId: SEPOLIA, timing: null, rule: rule(), proving: null, ...overrides });
const unknown = { kind: "unknown" } as const;

describe("durations in words (2026-11-07)", () => {
  it("seconds under a minute, minutes under two hours, then hours", () => {
    expect([0, 45, 59.6, 60, 1080, 4500, 7199, 7200, 7800, -5].map(durationText)).toEqual(["0 s", "45 s", "1 min", "1 min", "18 min", "75 min", "2 h", "2 h", "2 h 10 min", "0 s"]);
  });

  it("a range reads typical and up to", () => {
    expect(rangeText({ typical: 1080, worst: 4500 })).toBe("typical 18 min · up to 75 min");
  });
});

describe("whether a fee pays for a proof (2026-11-07)", () => {
  it("pays when the fee reaches the cost times the margin, falls short below it, and is unknown without a fee or a price", () => {
    const priced = rule({ priced: true });
    expect(feeVerdict(priced, { kind: "known", feeUsd: usd(0.15), costUsd: usd(0.1) })).toBe("pays");
    expect(feeVerdict(priced, { kind: "known", feeUsd: usd(0.149), costUsd: usd(0.1) })).toBe("short");
    expect(feeVerdict(priced, unknown)).toBe("unknown");
    expect(feeVerdict(priced, { kind: "observed" })).toBe("unknown");
    expect(feeVerdict(rule(), { kind: "known", feeUsd: usd(100), costUsd: usd(0.1) })).toBe("unknown");
  });
});

describe("the timeline from the chain and the rule only (2026-11-07)", () => {
  it("a testnet: final by the chain's rule (the next epoch's checkpoint, two epochs later), proofs at least hourly, and it says it is not measured", () => {
    const timeline = buildTimeline(inputs(), unknown);
    expect(timeline.steps.map((step) => [step.key, step.range, step.basis])).toEqual([
      ["sent", { typical: 12, worst: 24 }, "chain"],
      // 81.5 slots typical and 97 worst from the send (expectedFinalityAt, as the backend's watcher), less the send's block.
      ["final", { typical: 978 - 12, worst: 1164 - 12 }, "chain"],
      ["proved", { typical: 1800 + 120, worst: 3600 + 240 }, "rule"],
      ["delivered", { typical: 60, worst: 300 }, "chain"],
    ]);
    expect(timeline.steps[2].note).toBe("Testnet: proofs run at least hourly");
    expect(timeline.total).toEqual({ typical: 12 + 966 + 1920 + 60, worst: 24 + 1152 + 3840 + 300 });
    expect(timeline).toMatchObject({ basis: "derived", samples: 0, start: "testnet", batchSeconds: 3600 });
    expect(basisText(timeline)).toBe("Based on the chain and the proof rule.");
  });

  it("an interval that is not an hour is named in minutes", () => {
    expect(buildTimeline(inputs({ rule: rule({ minIntervalSeconds: 5400 }) }), unknown).steps[2].note).toBe("Testnet: proofs run at least every 90 min");
  });

  it("PulseChain testnet has 10 s slots: final 815 s typical and 970 s worst after the send", () => {
    expect(buildTimeline(inputs({ sourceChainId: 943 }), unknown).steps[1].range).toEqual({ typical: 805, worst: 960 });
  });

  it("mainnet: a fee that pays starts the proof at finality, a fee that falls short waits for a batch, an unchosen fee waits for a batch without saying more", () => {
    const priced = inputs({ rule: rule({ priced: true }) });
    const pays = buildTimeline(priced, { kind: "known", feeUsd: usd(0.2), costUsd: usd(0.1) });
    expect(pays).toMatchObject({ start: "at-finality", batchSeconds: null });
    expect(pays.steps[2]).toMatchObject({ range: { typical: 120, worst: 240 }, note: "A proof starts at finality", basis: "chain" });
    const short = buildTimeline(priced, { kind: "known", feeUsd: usd(0.1), costUsd: usd(0.1) });
    expect(short).toMatchObject({ start: "batch", batchSeconds: 3600 });
    expect(short.steps[2].note).toBe("Waits for a batch: up to 60 min; your fee does not pay for a proof alone");
    expect(short.steps[2].range).toEqual({ typical: 1920, worst: 3840 });
    expect(buildTimeline(priced, unknown).steps[2].note).toBe("Waits for a batch: up to 60 min");
    expect(short.total.typical).toBeGreaterThan(pays.total.typical);
  });

  it("an interval of 0 proves at finality whatever the fee", () => {
    const timeline = buildTimeline(inputs({ rule: rule({ priced: true, minIntervalSeconds: 0 }) }), { kind: "known", feeUsd: usd(0), costUsd: usd(1) });
    expect(timeline.start).toBe("at-finality");
  });

  it("the backend's measured proving time replaces the default", () => {
    const timeline = buildTimeline(inputs({ rule: rule({ priced: true }), proving: { typical: 200, worst: 500 } }), { kind: "known", feeUsd: usd(1), costUsd: usd(0.1) });
    expect(timeline.steps[2]).toMatchObject({ range: { typical: 200, worst: 500 }, basis: "measured" });
  });

  it("without a rule (an older backend, or none reachable) the proof step is the proving time alone", () => {
    const timeline = buildTimeline(inputs({ rule: null }), { kind: "known", feeUsd: usd(1), costUsd: usd(0.1) });
    expect(timeline).toMatchObject({ start: "unknown", batchSeconds: null });
    expect(timeline.steps[2]).toMatchObject({ range: { typical: 120, worst: 240 }, basis: "chain", note: "A proof of the finalized block is made and posted" });
    expect(buildTimeline(inputs({ rule: null, proving: { typical: 5, worst: 9 } }), unknown).steps[2].basis).toBe("measured");
  });
});

describe("the timeline from the last 7 days (2026-11-07)", () => {
  it("uses the measured covered-to-delivered, keeps final on the watcher's rule (not the indexer's send-to-final), and says how many transfers", () => {
    const timeline = buildTimeline(inputs({ timing: timing(20) }), unknown);
    expect(timeline.steps[1]).toMatchObject({ range: { typical: 978 - 12, worst: 1164 - 12 }, basis: "chain" });
    expect(timeline.steps[3]).toMatchObject({ range: { typical: 30, worst: 200 }, basis: "measured" });
    expect(timeline).toMatchObject({ basis: "measured", samples: 20 });
    expect(basisText(timeline)).toBe("Based on 20 transfers in the last 7 days; the proof step follows the proof rule.");
  });

  it("with fewer than the minimum deliveries it falls back to the chain and the rule", () => {
    const few = buildTimeline(inputs({ timing: timing(MIN_SAMPLES - 1) }), unknown);
    expect(few.basis).toBe("derived");
    expect(few.steps[1].basis).toBe("chain");
    expect(buildTimeline(inputs({ timing: timing(MIN_SAMPLES) }), unknown).basis).toBe("measured");
  });

  it("a step with no figures stays on the chain's, and the worst case is never under the typical", () => {
    const partial = buildTimeline(inputs({ timing: timing(20, { steps: [spread(null, null), spread(600, 100), spread(30, null)] }) }), { kind: "observed" });
    expect(partial.basis).toBe("derived");
    expect(partial.steps[1].basis).toBe("chain");
    expect(partial.steps[3].basis).toBe("chain");
    expect(partial.steps[2].range).toEqual({ typical: 600, worst: 600 });
  });

  it("observed: the proof step is the measured wait", () => {
    const timeline = buildTimeline(inputs({ timing: timing(20) }), { kind: "observed" });
    expect(timeline).toMatchObject({ start: "measured", basis: "measured" });
    expect(timeline.steps[2]).toMatchObject({ range: { typical: 600, worst: 3600 }, basis: "measured", note: "The wait for a proof, as measured" });
    expect(basisText(timeline)).toBe("Based on 20 transfers in the last 7 days.");
  });
});

describe("what is left of a transfer in flight (2026-11-07)", () => {
  const timeline = buildTimeline(inputs(), unknown);
  it("is the total less the time since the send, never under the delivery step", () => {
    expect(remainingOf(timeline, "sent", 0)).toEqual({ ...timeline.total, late: false });
    expect(remainingOf(timeline, "waiting_for_finality", 600)).toEqual({ typical: timeline.total.typical - 600, worst: timeline.total.worst - 600, late: false });
    expect(remainingOf(timeline, "waiting_for_finality", timeline.total.typical)).toMatchObject({ typical: 60, late: false });
    expect(remainingOf(timeline, "sent", -50)).toMatchObject({ typical: timeline.total.typical });
  });

  it("a proven transfer has the delivery step left; past the worst case it is late", () => {
    expect(remainingOf(timeline, "covered", 99_999)).toEqual({ typical: 60, worst: 300, late: false });
    expect(remainingOf(timeline, "waiting_for_finality", timeline.total.worst + 1)).toEqual({ typical: 60, worst: 300, late: true });
  });

  it("a delivered or failed transfer has nothing left", () => {
    expect(remainingOf(timeline, "delivered", 5)).toBeNull();
    expect(remainingOf(timeline, "release_failed", 5)).toBeNull();
  });
});

describe("reading the sources (2026-11-07)", () => {
  it("the clock text is the hour and minute", () => {
    expect(clockText(0)).toMatch(/^\d\d:\d\d$/);
  });

  it("the timing of a direction is its source chain's last 7 days, or null", () => {
    const rows = [{ sourceChainId: 1, timing: { last24h: timing(1), last7d: timing(9) } }, { sourceChainId: 2, timing: null }];
    expect(timingFor(rows, 1)?.count).toBe(9);
    expect(timingFor(rows, 2)).toBeNull();
    expect(timingFor(rows, 3)).toBeNull();
  });

  it("the proving time is the prover's total plus the time to the chain, in seconds, and null with too few proofs", () => {
    const stat = (count: number, medianMs: number | null, p90Ms: number | null) => ({ count, medianMs, p90Ms });
    expect(provingOf({ total: stat(9, 100_000, 160_000), proofToOnChain: stat(9, 30_000, 50_000) })).toEqual({ typical: 130, worst: 210 });
    expect(provingOf({ total: stat(9, 100_000, 160_000), proofToOnChain: stat(0, null, null) })).toEqual({ typical: 100, worst: 160 });
    // With the answer-to-board time of a newer backend.
    expect(provingOf({ total: stat(9, 100_000, 160_000), webhookToBoard: stat(9, 10_000, 40_000), proofToOnChain: stat(9, 30_000, 50_000) })).toEqual({ typical: 140, worst: 250 });
    expect(provingOf({ total: stat(9, 100_000, 160_000), webhookToBoard: stat(0, null, null), proofToOnChain: stat(9, 30_000, 50_000) })).toEqual({ typical: 130, worst: 250 - 40 });
    expect(provingOf({ total: stat(MIN_SAMPLES - 1, 1, 1), proofToOnChain: stat(0, null, null) })).toBeNull();
    expect(provingOf({ total: stat(9, null, null), proofToOnChain: stat(0, null, null) })).toBeNull();
    expect(provingOf(undefined)).toBeNull();
  });

  it("the rule is read from the pipeline answer, null from an older backend", () => {
    expect(ruleOf({ minIntervalSeconds: 3600, profitMargin: 1, proofCostUsd: "0.025000", priced: false })).toEqual({ minIntervalSeconds: 3600, profitMargin: 1, proofCostUsd: 0.025, priced: false });
    expect(ruleOf(undefined)).toBeNull();
  });
});

describe("a measured range past what its step can take is left out (2026-11-08)", () => {
  const stat = (count: number, medianMs: number | null, p90Ms: number | null) => ({ count, medianMs, p90Ms });
  // GET /benchmarks?window=7d, live 2026-11-08, before the backend fix: proofToOnChain 52 h median, 113 h p90.
  const live = { total: stat(236, 49_235, 71_322), webhookToBoard: stat(236, 16_667, 55_589), proofToOnChain: stat(236, 188_791_410, 408_330_591) };
  // GET /api/delivered, live 2026-11-08, last 7 days from Sepolia.
  const sepolia = timing(14, { steps: [spread(768, 768), spread(963, 3202.4), spread(40, 120)] });

  it("the live 52 h proof time no longer gives ~57 h: the proof step falls back to the rule, and the line says so", () => {
    const proving = provingOf(live);
    expect(proving?.typical).toBeGreaterThan(SANE_LIMITS.provingSeconds);
    const derived = buildTimeline(inputs({ proving }), { kind: "known", feeUsd: usd(0), costUsd: usd(0.1) });
    expect(derived.ignored).toEqual(["proved"]);
    expect(derived.steps[2]).toMatchObject({ range: { typical: 1800 + 120, worst: 3600 + 240 }, basis: "rule" });
    expect(derived.total.worst).toBeLessThan(90 * 60);
    expect(basisText(derived)).toBe("Based on the chain and the proof rule.");

    const measured = buildTimeline(inputs({ proving, timing: sepolia }), { kind: "known", feeUsd: usd(0), costUsd: usd(0.1) });
    expect(measured.basis).toBe("measured");
    expect(basisText(measured)).toBe("Based on 14 transfers in the last 7 days; the proof step is based on the chain and the proof rule.");
  });

  it("with the backend fixed (proofs land seconds after the board post), the Sepolia timeline is about 48 min typical and 84 min worst (final by the watcher's rule, this answer's 40/120 s deliveries)", () => {
    // The 20 newest proofs of the same answer, each matched to its own light client update: 7.4 s median, 11.5 s p90.
    const proving = provingOf({ ...live, proofToOnChain: stat(20, 7_446, 11_520) });
    expect(proving).toEqual({ typical: (49_235 + 16_667 + 7_446) / 1000, worst: (71_322 + 55_589 + 11_520) / 1000 });
    const timeline = buildTimeline(inputs({ proving, timing: sepolia }), { kind: "known", feeUsd: usd(0), costUsd: usd(0.1) });
    expect(timeline.ignored).toEqual([]);
    expect(timeline.steps[2].range.typical).toBeCloseTo(1800 + 73.348);
    expect(timeline.steps[2].range.worst).toBeCloseTo(3600 + 138.431);
    expect(durationText(timeline.total.typical)).toBe("48 min");
    expect(durationText(timeline.total.worst)).toBe("84 min");
  });

  it("a measured proof wait or delivery past its limit falls back to the chain's figure; the indexer's send-to-final is never read", () => {
    const wild = timing(20, { steps: [spread(760, 768 * 3 + 1), spread(600, 2 * 3600 + 1801), spread(30, 1801)] });
    const timeline = buildTimeline(inputs({ timing: wild }), { kind: "observed" });
    expect(timeline.ignored).toEqual(["proved", "delivered"]);
    expect(timeline.steps.map((step) => step.basis)).toEqual(["chain", "chain", "chain", "chain"]);
    expect(timeline.basis).toBe("derived");
    expect(basisText(timeline)).toBe("Based on the chain and the proof rule.");
    // Without a rule an hour stands in for the interval; at the limits the measured ranges stay.
    const edge = timing(20, { steps: [spread(760, 768 * 3), spread(600, 2 * 3600 + 1800), spread(30, 1800)] });
    expect(buildTimeline(inputs({ timing: edge, rule: null }), { kind: "observed" }).ignored).toEqual([]);
    expect(buildTimeline(inputs({ timing: timing(20, { steps: [spread(760, 790), spread(600, 2 * 3600 + 1801), spread(30, 200)] }), rule: null }), { kind: "observed" }).ignored).toEqual(["proved"]);
  });

  it("a wild measured proof wait and a wild proving time are named once", () => {
    const timeline = buildTimeline(inputs({ timing: timing(20, { steps: [spread(760, 790), spread(600, 99_999), spread(30, 200)] }), proving: { typical: 9_999, worst: 99_999 } }), { kind: "observed" });
    expect(timeline.ignored).toEqual(["proved"]);
    expect(timeline.steps[2]).toMatchObject({ range: { typical: 120, worst: 240 }, basis: "chain" });
  });
});

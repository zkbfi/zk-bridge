import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  DELIVERY_DEFAULT,
  MIN_SAMPLES,
  PROOF_COST_USD,
  PROVING_DEFAULT,
  SANE_LIMITS,
  addRanges,
  batchCostUsd,
  batchDueAt,
  clockFromSlot,
  defaultFinalitySeconds,
  deliveryRangeOfStat,
  epochSeconds,
  expectedFinalityAt,
  feeVerdict,
  feesPay,
  finalityWaitRange,
  finalizedSlotAt,
  hoursUntil,
  hoursUntilRounded,
  intervalAllows,
  intervalEndsAt,
  marginOfWad,
  marginWadOf,
  proofWaitRange,
  provingPartsOf,
  provingRangeOf,
  rangeOfSpread,
  remainingWait,
  saneProvingParts,
  saneRange,
  secondsPerSlot,
  slotAtTime,
  slotStartTime,
  strandingDeadline,
  syncCommitteePeriodOf,
  waitDurationText,
  waitEstimate,
  withMargin,
  type FeeReading,
  type MeasuredSteps,
  type ProofRule,
  type Range,
  type WaitInputs,
} from "../src/index.js";
import vectors from "../vectors/wait-estimates-vectors.json" with { type: "json" };

/** The vectors' live inputs as the module takes them. */
const live = vectors.live;
const liveRule: ProofRule = { minIntervalSeconds: live.rule.minIntervalSeconds, profitMargin: live.rule.profitMargin, proofCostUsd: live.rule.proofCostUsd, priced: live.rule.priced };
const liveProving = provingRangeOf(provingPartsOf(live.benchmarks)) as Range;
const unknown: FeeReading = { kind: "unknown" };
const closeRange = (actual: Range, expected: Range) => {
  expect(actual.typical).toBeCloseTo(expected.typical, 6);
  expect(actual.worst).toBeCloseTo(expected.worst, 6);
};

describe("the shipped wait vectors", () => {
  it("is the file the package exports as ./wait-vectors", () => {
    const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { exports: Record<string, unknown>; files: string[] };
    expect(manifest.exports["./wait-vectors"]).toBe("./vectors/wait-estimates-vectors.json");
    expect(manifest.files).toContain("vectors/wait-estimates-vectors.json");
  });
});

describe("the chain's timing (vectors)", () => {
  it("slot length, finality window, epoch and the expected wait to finality of each chain; an unknown chain has 12 s slots", () => {
    for (const chain of vectors.chains) {
      expect(secondsPerSlot(chain.chainId), String(chain.chainId)).toBe(chain.secondsPerSlot);
      expect(defaultFinalitySeconds(chain.chainId)).toBe(chain.finalitySeconds);
      expect(epochSeconds(chain.chainId)).toBe(chain.epochSeconds);
      expect(finalityWaitRange(chain.secondsPerSlot)).toEqual(chain.finalityWait);
    }
  });

  it("the start of a slot and the expected finality of a block in it: the next epoch's checkpoint, final two epochs later, one slot for the signatures", () => {
    for (const entry of vectors.slots) {
      expect(slotStartTime(entry.slot, vectors.clock)).toBe(entry.slotStartTime);
      expect(expectedFinalityAt(entry.slot, vectors.clock), String(entry.slot)).toBe(entry.expectedFinalityAt);
      // A block is covered from the moment its finality is expected, not a second earlier.
      expect(finalizedSlotAt(entry.expectedFinalityAt, vectors.clock)).toBeGreaterThanOrEqual(entry.slot);
      // Except the first slot of an epoch: it is that epoch's own checkpoint and finalizes an epoch sooner than
      // expectedFinalityAt says (the rule is the backend's and errs late for it).
      if (entry.slot % 32 !== 0) expect(finalizedSlotAt(entry.expectedFinalityAt - 1, vectors.clock)).toBeLessThan(entry.slot);
    }
    for (const entry of vectors.finalizedSlots) expect(finalizedSlotAt(entry.seconds, vectors.clock), String(entry.seconds)).toBe(entry.finalizedSlotAt);
  });

  it("the slot of a time, 0 before genesis, and the clock from a head's slot and slot time", () => {
    const { message } = vectors;
    expect(clockFromSlot(message.head.slot, message.head.slotTime, 12)).toEqual(message.clock);
    expect(slotAtTime(message.sentAt, message.clock)).toBe(message.slot);
    expect(slotAtTime(message.sentAt + 11, message.clock)).toBe(message.slot);
    expect(slotAtTime(message.clock.genesisTime - 5, message.clock)).toBe(0);
    expect(expectedFinalityAt(message.slot, message.clock) - message.sentAt).toBe(message.waitSeconds);
  });

  it("the sync-committee period, the stranding deadline and the hours until it", () => {
    expect(syncCommitteePeriodOf(8192 * 3 + 1)).toBe(3);
    expect(syncCommitteePeriodOf(99, 10)).toBe(9);
    for (const entry of vectors.stranding.cases) {
      expect(strandingDeadline({ headSlot: entry.headSlot, nextCommitteeKnown: entry.nextCommitteeKnown, slotsPerPeriod: vectors.stranding.slotsPerPeriod }, vectors.stranding.clock)).toEqual(entry.deadline);
      for (const hours of entry.hours) {
        expect(hoursUntil(entry.deadline.deadlineSeconds * 1000, hours.nowMs)).toBeCloseTo(hours.hoursUntil, 9);
        expect(hoursUntilRounded(entry.deadline.deadlineSeconds * 1000, hours.nowMs)).toBe(hours.hoursUntilRounded);
      }
    }
  });
});

describe("the proof rule (vectors)", () => {
  it("margins, the cost times the margin rounded up, and whether fees pay", () => {
    expect(PROOF_COST_USD.toString()).toBe(vectors.fee.proofCostUsd);
    for (const entry of vectors.fee.cases) {
      expect(marginWadOf(entry.margin)).toBe(BigInt(entry.marginWad));
      expect(marginOfWad(BigInt(entry.marginWad))).toBe(entry.margin);
      expect(withMargin(BigInt(entry.costUsd), BigInt(entry.marginWad))).toBe(BigInt(entry.withMargin));
      for (const pay of entry.pays) expect(feesPay(BigInt(pay.feesUsd), BigInt(entry.costUsd), BigInt(entry.marginWad))).toBe(pay.pays);
    }
    for (const entry of vectors.fee.batchCost) expect(batchCostUsd(entry.count, BigInt(entry.deliveryUsd), BigInt(entry.marginWad))).toBe(BigInt(entry.costUsd));
  });

  it("when a batch that does not pay is due: the interval after the last proof, never before the first finality", () => {
    const { message } = vectors;
    for (const entry of message.batch) {
      expect(batchDueAt(message.expectedFinalityAt, entry.lastProofAt, entry.minIntervalSeconds)).toBe(entry.dueAt);
      expect(intervalAllows(message.expectedFinalityAt, entry.lastProofAt, entry.minIntervalSeconds)).toBe(entry.allowsAtFinality);
    }
    expect(intervalEndsAt(null, 3600)).toBe(Number.NEGATIVE_INFINITY);
    expect(intervalEndsAt(100, 3600)).toBe(3700);
  });

  it("the wait for a proof: the proving time when the fee pays or there is no interval, else up to the interval more", () => {
    const proving = { typical: 10, worst: 20 };
    expect(proofWaitRange(3600, proving, true)).toBe(proving);
    expect(proofWaitRange(0, proving, false)).toBe(proving);
    expect(proofWaitRange(3600, proving, false)).toEqual({ typical: 1810, worst: 3620 });
  });

  it("the fee verdict: pays, short, or unknown without a fee, for observed waits, and on a testnet", () => {
    for (const entry of live.fees) {
      expect(feeVerdict(entry.rule, { kind: "known", feeUsd: BigInt(entry.feeUsd), costUsd: BigInt(entry.costUsd) })).toBe(entry.verdict);
    }
    expect(feeVerdict(live.fees[0]!.rule, unknown)).toBe("unknown");
    expect(feeVerdict(live.fees[0]!.rule, { kind: "observed" })).toBe("unknown");
    expect(feeVerdict(liveRule, { kind: "known", feeUsd: 10n ** 20n, costUsd: 1n })).toBe("unknown");
  });
});

describe("measured step times", () => {
  const stat = (count: number, medianMs: number | null, p90Ms: number | null) => ({ count, medianMs, p90Ms });

  it("the proving parts and their sum from the benchmarks (vectors); a missing later step counts 0", () => {
    closeRange(liveProving, live.proving);
    expect(provingPartsOf({ total: stat(9, 100_000, 160_000), proofToOnChain: stat(0, null, null) })).toEqual({ total: { typical: 100, worst: 160 }, webhookToBoard: { typical: 0, worst: 0 }, proofToOnChain: { typical: 0, worst: 0 } });
  });

  it("no proving parts with too few runs or without the figures", () => {
    expect(provingPartsOf({ total: stat(MIN_SAMPLES - 1, 1, 1), proofToOnChain: stat(9, 1, 1) })).toBeNull();
    expect(provingPartsOf({ total: stat(9, null, 1), proofToOnChain: stat(9, 1, 1) })).toBeNull();
    expect(provingPartsOf({ total: stat(9, 1, null), proofToOnChain: stat(9, 1, 1) })).toBeNull();
    expect(provingPartsOf(undefined)).toBeNull();
    expect(provingRangeOf(null)).toBeNull();
  });

  it("proving parts past the sanity limit are left out: the 52 h of 2026-11-08", () => {
    const parts = provingPartsOf({ ...live.benchmarks, proofToOnChain: stat(236, 188_791_410, 408_330_591) });
    expect(saneProvingParts(parts)).toBeNull();
    expect(saneProvingParts(null)).toBeNull();
    const fine = provingPartsOf(live.benchmarks);
    expect(saneProvingParts(fine)).toBe(fine);
  });

  it("a covered-to-delivered benchmark as a range, or null with too few samples, without figures or past its limit", () => {
    expect(deliveryRangeOfStat(live.benchmarks.coveredToDelivered)).toEqual(live.directions[0]!.expected.delivered);
    expect(deliveryRangeOfStat(stat(9, 50_000, 40_000))).toEqual({ typical: 50, worst: 50 });
    expect(deliveryRangeOfStat(stat(MIN_SAMPLES - 1, 1, 1))).toBeNull();
    expect(deliveryRangeOfStat(stat(9, null, 1))).toBeNull();
    expect(deliveryRangeOfStat(stat(9, 1, null))).toBeNull();
    expect(deliveryRangeOfStat(stat(9, 1, SANE_LIMITS.deliverySeconds * 1000 + 1))).toBeNull();
    expect(deliveryRangeOfStat(undefined)).toBeNull();
  });

  it("ranges: sane within the limit, a spread as a range with the worst never under the typical, sums", () => {
    expect(saneRange(null, 1)).toBeNull();
    expect(saneRange({ typical: 1, worst: 2 }, 2)).toEqual({ typical: 1, worst: 2 });
    expect(saneRange({ typical: 1, worst: 3 }, 2)).toBeNull();
    expect(rangeOfSpread({ median: 5, p90: 3 })).toEqual({ typical: 5, worst: 5 });
    expect(rangeOfSpread({ median: null, p90: 3 })).toBeNull();
    expect(rangeOfSpread({ median: 5, p90: null })).toBeNull();
    expect(rangeOfSpread(undefined)).toBeNull();
    expect(addRanges()).toEqual({ typical: 0, worst: 0 });
    expect(addRanges({ typical: 1, worst: 2 }, { typical: 3, worst: 4 })).toEqual({ typical: 4, worst: 6 });
  });
});

describe("the timeline of a direction (vectors)", () => {
  const inputsOf = (sourceChainId: number, timing: MeasuredSteps | null): WaitInputs => ({ sourceChainId, timing, rule: liveRule, proving: liveProving });

  it("the live case of 2026-11-08: testnet rule 3600 s, Sepolia to 943 about 48 min typical and 83 min worst, 943 to Sepolia about 46 and 80", () => {
    for (const direction of live.directions) {
      const estimate = waitEstimate(inputsOf(direction.sourceChainId, direction.timing as unknown as MeasuredSteps), unknown);
      const expected = direction.expected;
      for (const key of ["sent", "final", "proved", "delivered", "total"] as const) closeRange(estimate[key], expected[key]);
      expect(waitDurationText(estimate.total.typical)).toBe(expected.text.typical);
      expect(waitDurationText(estimate.total.worst)).toBe(expected.text.worst);
      expect(estimate).toMatchObject({ measured: true, samples: direction.timing.count, start: "testnet", batchSeconds: 3600, ignored: [], basis: { final: "chain", proved: "rule", delivered: "measured" } });
    }
  });

  it("without measured deliveries: the chain's finality rule and the defaults", () => {
    for (const direction of live.derived) {
      const estimate = waitEstimate(inputsOf(direction.sourceChainId, null), unknown);
      for (const key of ["sent", "final", "proved", "delivered", "total"] as const) closeRange(estimate[key], direction.expected[key]);
      expect(waitDurationText(estimate.total.typical)).toBe(direction.expected.text.typical);
      expect(waitDurationText(estimate.total.worst)).toBe(direction.expected.text.worst);
      expect(estimate).toMatchObject({ measured: false, samples: 0, basis: { final: "chain", proved: "rule", delivered: "chain" } });
    }
  });

  it("a fee that pays proves at finality, one that falls short waits for a batch (vectors)", () => {
    for (const entry of live.fees) {
      const estimate = waitEstimate({ ...inputsOf(11155111, null), rule: entry.rule }, { kind: "known", feeUsd: BigInt(entry.feeUsd), costUsd: BigInt(entry.costUsd) });
      closeRange(estimate.proved, entry.proved);
      expect(estimate.start).toBe(entry.start);
    }
  });

  it("an interval of 0 proves at finality whatever the fee; without a rule or for observed waits, the measured wait or the proving time", () => {
    expect(waitEstimate({ ...inputsOf(1, null), rule: { ...liveRule, minIntervalSeconds: 0 } }, unknown)).toMatchObject({ start: "at-finality", batchSeconds: null, basis: { proved: "measured" } });
    expect(waitEstimate({ sourceChainId: 1, timing: null, rule: null, proving: null }, unknown)).toMatchObject({ start: "unknown", proved: PROVING_DEFAULT, delivered: DELIVERY_DEFAULT, basis: { proved: "chain" } });
    const timing = live.directions[0]!.timing as unknown as MeasuredSteps;
    expect(waitEstimate({ ...inputsOf(11155111, timing), rule: null }, unknown)).toMatchObject({ start: "measured", proved: { typical: 963, worst: 3202.4 }, basis: { proved: "measured" } });
    expect(waitEstimate(inputsOf(11155111, timing), { kind: "observed" })).toMatchObject({ start: "measured" });
    expect(waitEstimate({ ...inputsOf(11155111, null), rule: { ...liveRule, priced: true } }, unknown).start).toBe("batch");
  });

  it("fewer than the minimum deliveries fall back; a measured range past its limit is left out and named once", () => {
    const timing = live.directions[0]!.timing as unknown as MeasuredSteps;
    expect(waitEstimate(inputsOf(11155111, { ...timing, count: MIN_SAMPLES - 1 }), unknown).measured).toBe(false);
    const wild: MeasuredSteps = { count: 20, steps: [{ median: 760, p90: 768 * 3 + 1 }, { median: 600, p90: 2 * 3600 + 1801 }, { median: 30, p90: 1801 }] };
    const estimate = waitEstimate({ ...inputsOf(11155111, wild), proving: { typical: 9_999, worst: 99_999 } }, { kind: "observed" });
    expect(estimate.ignored).toEqual(["proved", "delivered"]);
    expect(estimate.measured).toBe(false);
    // Without a rule an hour stands in for the interval; at the limits the measured ranges stay.
    const edge: MeasuredSteps = { count: 20, steps: [{ median: 760, p90: 768 * 3 }, { median: 600, p90: 2 * 3600 + 1800 }, { median: 30, p90: 1800 }] };
    expect(waitEstimate({ ...inputsOf(11155111, edge), rule: null }, { kind: "observed" }).ignored).toEqual([]);
    // The indexer's send-to-final is its window, not a measurement: whatever it says, the step follows the watcher's rule.
    const ruled = waitEstimate(inputsOf(11155111, null), unknown).final;
    expect(waitEstimate(inputsOf(11155111, { ...timing, steps: [{ median: 5, p90: 99_999 }, timing.steps[1], timing.steps[2]] }), unknown).final).toEqual(ruled);
  });

  it("what is left of a transfer in flight (vectors)", () => {
    const estimate = waitEstimate(inputsOf(11155111, live.directions[0]!.timing as unknown as MeasuredSteps), unknown);
    for (const entry of live.remaining) {
      const left = remainingWait(estimate, entry.status, entry.elapsedSeconds);
      if (entry.left === null) expect(left).toBeNull();
      else {
        closeRange(left as Range, entry.left);
        expect(left?.late).toBe(entry.left.late);
      }
    }
    expect(remainingWait(estimate, "release_failed", 1)).toBeNull();
    expect(remainingWait(estimate, "sent", -50)?.typical).toBeCloseTo(estimate.total.typical, 6);
  });

  it("durations in words", () => {
    expect([0, 45, 59.6, 60, 1080, 4500, 7199, 7200, 7800, -5].map(waitDurationText)).toEqual(["0 s", "45 s", "1 min", "1 min", "18 min", "75 min", "2 h", "2 h", "2 h 10 min", "0 s"]);
  });
});

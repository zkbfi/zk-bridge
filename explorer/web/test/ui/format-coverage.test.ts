import { describe, expect, it } from "vitest";
import { formatAmountWithSymbol, formatLag, formatSlot, lagSeverity, STATUS_LABELS, STATUS_MEANINGS, STATUS_PALETTES } from "../../src/ui/format";

const STATUSES = ["sent", "waiting_for_finality", "covered", "delivered", "failed_call", "fallback_used", "claimable"] as const;

describe("formatAmountWithSymbol", () => {
  it("groups thousands and cuts, never rounds, at six fraction digits", () => {
    // The seventh fraction digit is 9. A rounding formatter would show 1,234,567.890124.
    expect(formatAmountWithSymbol(1_234_567_890_123_956n, { decimals: 9, symbol: "USDC" })).toBe("1,234,567.890123 USDC");
  });

  it("shows a whole amount with no fraction", () => {
    expect(formatAmountWithSymbol(5_000_000n, { decimals: 6, symbol: "USDC" })).toBe("5 USDC");
  });
});

describe("formatSlot", () => {
  it("groups the thousands of a slot", () => {
    expect(formatSlot(12_345_678n)).toBe("12,345,678");
    expect(formatSlot(0n)).toBe("0");
  });
});

describe("formatLag", () => {
  it("says unknown when the head has no lag", () => {
    expect(formatLag({ lagSlots: null, secondsPerSlot: 12 })).toBe("unknown");
  });

  it("gives the slots and the time that they take", () => {
    expect(formatLag({ lagSlots: 80n, secondsPerSlot: 12 })).toBe("80 slots (16m 00s)");
  });
});

describe("lagSeverity", () => {
  const severity = (seconds: number) => lagSeverity({ lagSlots: BigInt(seconds), secondsPerSlot: 1 });

  it("is unknown without a lag", () => {
    expect(lagSeverity({ lagSlots: null, secondsPerSlot: 12 })).toBe("unknown");
  });

  it("is good below an hour, a warning from an hour, and bad from six hours", () => {
    expect(severity(0)).toBe("good");
    expect(severity(3_599)).toBe("good");
    expect(severity(3_600)).toBe("warning");
    expect(severity(6 * 3_600 - 1)).toBe("warning");
    expect(severity(6 * 3_600)).toBe("bad");
  });

  it("turns slots into seconds with the slot time of the chain", () => {
    expect(lagSeverity({ lagSlots: 300n, secondsPerSlot: 12 })).toBe("warning");
    expect(lagSeverity({ lagSlots: 300n, secondsPerSlot: 1 })).toBe("good");
  });
});

describe("the status tables", () => {
  it("hold a label, a meaning and a palette for every status", () => {
    for (const status of STATUSES) {
      expect(STATUS_LABELS[status]).toBeTruthy();
      expect(STATUS_MEANINGS[status]).toBeTruthy();
      expect(STATUS_PALETTES[status]).toBeTruthy();
    }
    expect(STATUS_LABELS.waiting_for_finality).toBe("Waiting for finality");
    expect(STATUS_PALETTES.failed_call).toBe("red");
    expect(Object.keys(STATUS_LABELS).sort()).toEqual([...STATUSES].sort());
    expect(Object.keys(STATUS_MEANINGS).sort()).toEqual([...STATUSES].sort());
    expect(Object.keys(STATUS_PALETTES).sort()).toEqual([...STATUSES].sort());
  });
});

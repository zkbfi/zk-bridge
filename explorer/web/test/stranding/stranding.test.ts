import { describe, expect, it } from "vitest";
import { hoursText, strandingLine, strandingMenuNote, toneOf } from "../../src/stranding/stranding";
import { directionInto } from "../../src/stranding/use-stranding";

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;
const at = (hours: number) => ({ at: NOW + hours * HOUR, period: 17 });

describe("the hours text", () => {
  it("has one decimal under 10 h and whole hours from 10 h", () => {
    expect(hoursText(5.2)).toBe("5.2");
    expect(hoursText(0)).toBe("0.0");
    expect(hoursText(9.94)).toBe("9.9");
    expect(hoursText(10)).toBe("10");
    expect(hoursText(9.96)).toBe("10");
    expect(hoursText(30.6)).toBe("31");
  });
});

describe("the line", () => {
  it("says the hours until stranded with the period", () => {
    expect(strandingLine(at(5.2), NOW)?.text).toBe("5.2 h until stranded (period 17)");
    expect(strandingLine(at(31), NOW)?.text).toBe("31 h until stranded (period 17)");
  });

  it("states how far past the stranding point a light client is", () => {
    expect(strandingLine(at(-2.1), NOW)).toMatchObject({ text: "Past the stranding point by 2.1 h (period 17)", tone: "bad" });
  });

  it("is hidden when the deadline is unknown", () => {
    expect(strandingLine(null, NOW)).toBeNull();
    expect(strandingLine(undefined, NOW)).toBeNull();
  });

  it("uses the clock, not the backend's hoursLeft", () => {
    const deadline = { ...at(5), hoursLeft: 99 };
    expect(strandingLine(deadline, NOW)?.text).toBe("5.0 h until stranded (period 17)");
    expect(strandingLine(deadline, NOW + 2 * HOUR)?.text).toBe("3.0 h until stranded (period 17)");
  });
});

describe("the tone", () => {
  it("is normal above 12 h, warn up to 12 h, bad up to 6 h and when passed", () => {
    expect(toneOf(12.01)).toBe("normal");
    expect(toneOf(12)).toBe("warn");
    expect(toneOf(6.01)).toBe("warn");
    expect(toneOf(6)).toBe("bad");
    expect(toneOf(0)).toBe("bad");
    expect(toneOf(-1)).toBe("bad");
    expect(strandingLine(at(12), NOW)?.tone).toBe("warn");
    expect(strandingLine(at(6), NOW)?.tone).toBe("bad");
  });
});

describe("the route menu note", () => {
  it("shows from 6 h and fewer, and once passed, and not above 6 h", () => {
    expect(strandingMenuNote(at(4.1), NOW)).toBe("light client 4.1 h from stranded");
    expect(strandingMenuNote(at(6), NOW)).toBe("light client 6.0 h from stranded");
    expect(strandingMenuNote(at(6.1), NOW)).toBeNull();
    expect(strandingMenuNote(at(-1), NOW)).toBe("light client is past its stranding point");
    expect(strandingMenuNote(null, NOW)).toBeNull();
    expect(strandingMenuNote(undefined, NOW)).toBeNull();
  });
});

describe("which direction belongs to a light client", () => {
  it("is the direction that delivers to the chain", () => {
    expect(directionInto({ first: { chainId: 1 } }, 1)).toBe("second-to-first");
    expect(directionInto({ first: { chainId: 1 } }, 369)).toBe("first-to-second");
  });
});

import { describe, expect, it } from "vitest";
import { getAddress } from "viem";
import * as tipCopy from "../src/tip-copy.js";
import { GAS_MODE_HELP, GAS_MODE_SHORT_LABEL, routerInWords, TIP_MODE_NAMES } from "../src/index.js";

const deliveryRouter = getAddress(`0x${"aa".repeat(20)}`);
const other = getAddress(`0x${"bb".repeat(20)}`);

describe("TIP_MODE_NAMES", () => {
  it("gives each tip mode its own words", () => {
    expect(TIP_MODE_NAMES).toEqual({ share: "percentage of the transfer", fixed: "fixed amount", gas: "gas based, up to the limit" });
  });
});

describe("routerInWords", () => {
  it("names the default delivery router, whatever the letter case of the address", () => {
    expect(routerInWords(deliveryRouter.toLowerCase(), deliveryRouter)).toBe(`${deliveryRouter} (the default delivery router)`);
  });

  it("warns that another router is not the delivery router, because the tip terms are written for the delivery router", () => {
    expect(routerInWords(other, deliveryRouter)).toBe(`${other} (not the default delivery router)`);
  });
});

describe("the words of the gas based mode", () => {
  it("has a label that fits a column of 14 characters, and a help line that says the deliverer decides and the limit is the ceiling", () => {
    expect(GAS_MODE_SHORT_LABEL.length).toBeLessThanOrEqual(14);
    expect(GAS_MODE_HELP).toContain("the deliverer's gas choice decides");
    expect(GAS_MODE_HELP).toContain("price ceiling");
  });
});

describe("the wording rules about tips", () => {
  const strings = (value: unknown): string[] => {
    if (typeof value === "string") return [value];
    if (value !== null && typeof value === "object") return Object.values(value).flatMap(strings);
    return [];
  };

  it("no tip text mentions proof, prover, proving or graphics", () => {
    const texts = strings(tipCopy);
    expect(texts.length).toBeGreaterThan(5);
    for (const text of texts) expect(text).not.toMatch(/proof|prover|proving|graphics|gpu/i);
  });

  it("says plainly that the gas mode cannot tip zero, and how to tip zero", () => {
    expect(tipCopy.TIP_RANGE_HELP).toContain("lowest tip is just above zero");
    expect(tipCopy.TIP_RANGE_HELP).toContain("No tip or a fixed amount of 0");
    expect(tipCopy.TIP_RANGE_HELP).not.toContain("any tip from zero up");
  });

  it("says that a tip is voluntary, goes to the reward address, and buys no promise", () => {
    expect(tipCopy.TIP_NATURE).toContain("reward address");
    expect(tipCopy.TIP_NATURE).toContain("voluntary");
    expect(tipCopy.TIP_NATURE).toContain("no promise");
  });
});

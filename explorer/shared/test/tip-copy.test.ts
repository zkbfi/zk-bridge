import { describe, expect, it } from "vitest";
import { getAddress } from "viem";
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

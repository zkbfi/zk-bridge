import { describe, expect, it } from "vitest";
import { getAddress } from "viem";
import { routerInWords, TIP_MODE_NAMES } from "../src/index.js";

const feeRouter = getAddress(`0x${"aa".repeat(20)}`);
const other = getAddress(`0x${"bb".repeat(20)}`);

describe("TIP_MODE_NAMES", () => {
  it("gives each tip mode its own words", () => {
    expect(TIP_MODE_NAMES).toEqual({ share: "percentage of the transfer", fixed: "fixed amount", gas: "gas multiplier" });
  });
});

describe("routerInWords", () => {
  it("names the fee router of the deployment, whatever the letter case of the address", () => {
    expect(routerInWords(feeRouter.toLowerCase(), feeRouter)).toBe(`${feeRouter} (the fee router of the deployment)`);
  });

  it("warns that another router is not the fee router, because the tip terms are written for the fee router", () => {
    expect(routerInWords(other, feeRouter)).toBe(`${other} (not the fee router of the deployment)`);
  });
});

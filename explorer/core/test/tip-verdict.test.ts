import { describe, expect, it } from "vitest";
import type { Address } from "viem";
import {
  COST_MARGIN,
  DEFAULT_CAP_WAD,
  PERCENT_WAD,
  PROOF_COST_USD,
  WAD,
  atAutomaticMaximum,
  createPriceKeeper,
  feeValueOf,
  meetsProfitRule,
  poolReaderAtLatest,
  tipPays,
  tipVerdict,
  tipVerdictOfTerms,
  tokenValuationIn,
  type PriceState,
  type ProfitRule,
} from "../src/index.js";
import { FIXTURE_COST, amountOf, chainsOf, directorOf, fixtureClient, tipUnitsOf, tipVectors, tokenOf, type TipCase } from "./fixtures/pool-caller.js";

const known: PriceState = { kind: "known" };
const noMarket: PriceState = { kind: "no-market" };

describe("the automatic maximum", () => {
  it("is the frontend's 1% automatic cap, the one constant", () => {
    expect(DEFAULT_CAP_WAD).toBe(PERCENT_WAD);
  });

  it("is reached at 1% of the amount, in base units as the router rounds it, and never with no tip", () => {
    expect(atAutomaticMaximum(10n, 1_000n)).toBe(true);
    expect(atAutomaticMaximum(9n, 1_000n)).toBe(false);
    expect(atAutomaticMaximum(1_000n, 1_000n)).toBe(true);
    expect(atAutomaticMaximum(0n, 0n)).toBe(false);
    // The router's 1% share rounds down, and the dapp signs that share: it always reaches the maximum.
    expect(atAutomaticMaximum((1_099n * PERCENT_WAD) / WAD, 1_099n)).toBe(true);
    expect(atAutomaticMaximum(9n, 1_099n)).toBe(false);
    // 1% of a tiny amount rounds to nothing, and a tip of nothing is never the maximum.
    expect(atAutomaticMaximum(0n, 50n)).toBe(false);
    expect(atAutomaticMaximum(1n, 50n)).toBe(true);
  });
});

describe("the profit rules", () => {
  it("margin (backend profitMargin, the dapp's 2×): the fee reaches the cost times the margin, rounded up", () => {
    const twice: ProfitRule = { kind: "margin", marginWad: COST_MARGIN * WAD };
    expect(meetsProfitRule(200n, 100n, twice)).toBe(true);
    expect(meetsProfitRule(199n, 100n, twice)).toBe(false);
    const half: ProfitRule = { kind: "margin", marginWad: WAD / 2n };
    expect(meetsProfitRule(2n, 3n, half)).toBe(true); // 1.5 rounds up to 2
    expect(meetsProfitRule(1n, 3n, half)).toBe(false);
  });

  it("loss (runner maximumLossPercent): the loss stays under the share of the cost; a fee at the cost always pays", () => {
    const loss = (maximumLossPercent: number): ProfitRule => ({ kind: "loss", maximumLossPercent });
    expect(meetsProfitRule(801n, 1_000n, loss(20))).toBe(true);
    expect(meetsProfitRule(800n, 1_000n, loss(20))).toBe(false);
    expect(meetsProfitRule(1_000n, 1_000n, loss(0))).toBe(true);
    expect(meetsProfitRule(0n, 0n, loss(0))).toBe(true);
    expect(meetsProfitRule(0n, 1n, loss(100))).toBe(false);
  });
});

describe("the verdict", () => {
  const base = { amount: 1_000n, decimals: 0, cost: 50n, rule: { kind: "margin", marginWad: WAD } as ProfitRule };

  it("judges a priced tip (known or stale) by the profit rule", () => {
    expect(tipVerdict({ ...base, fee: 50n, price: { state: known, perWholeToken: 1n } })).toBe("pays");
    expect(tipVerdict({ ...base, fee: 49n, price: { state: { kind: "stale", ageSeconds: 9 }, perWholeToken: 1n } })).toBe("below-cost");
  });

  it("takes the fee's value from the caller when it has it, only while the price is usable", () => {
    expect(tipVerdict({ ...base, fee: 1n, feeValue: 50n, price: { state: known, perWholeToken: 1n } })).toBe("pays");
    expect(tipVerdict({ ...base, fee: 50n, feeValue: null, price: { state: known, perWholeToken: 1n } })).toBe("pays");
    expect(tipVerdict({ ...base, fee: 1n, feeValue: 50n, price: { state: noMarket, perWholeToken: null } })).toBe("unpriced-below-max");
  });

  it("judges an unpriced tip by the automatic maximum: no market, unreachable, no value or no cost", () => {
    expect(tipVerdict({ ...base, fee: 10n, price: { state: noMarket, perWholeToken: null } })).toBe("unpriced-at-max");
    expect(tipVerdict({ ...base, fee: 9n, price: { state: { kind: "unreachable" }, perWholeToken: 1n } })).toBe("unpriced-below-max");
    expect(tipVerdict({ ...base, fee: 10n, price: { state: known, perWholeToken: null } })).toBe("unpriced-at-max");
    expect(tipVerdict({ ...base, cost: null, fee: 500n, price: { state: known, perWholeToken: 1n } })).toBe("unpriced-at-max");
  });

  it("counts pays and unpriced-at-max as paying", () => {
    expect(["pays", "below-cost", "unpriced-at-max", "unpriced-below-max"].map((verdict) => tipPays(verdict as never))).toEqual([true, false, true, false]);
  });

  it("values a fee in the cost's unit, rounded down, only with a usable price", () => {
    expect(feeValueOf(1_500_000n, 6, { state: known, perWholeToken: 3n })).toBe(4n);
    expect(feeValueOf(1n, 0, { state: noMarket, perWholeToken: 3n })).toBeNull();
  });

  it("reads the tip from the terms, none without a director or on an overflow", () => {
    const gas = { gasUsed: 0n, baseFeeWei: 0n };
    const share = { recipient: "0x0000000000000000000000000000000000000012" as Address, settings: 8n, limit: 0n, multiplier: PERCENT_WAD, callGas: 0n };
    const price = { state: noMarket, perWholeToken: null };
    expect(tipVerdictOfTerms({ ...base, director: share, gas, price })).toBe("unpriced-at-max");
    expect(tipVerdictOfTerms({ ...base, director: null, gas, price })).toBe("unpriced-below-max");
    expect(tipVerdictOfTerms({ ...base, director: { ...share, multiplier: 2n ** 255n }, amount: 10n ** 30n, gas, price })).toBe("unpriced-below-max");
  });
});

describe("the shared fixture, through the core", () => {
  /** The verdict of a case as the core computes it: prices from the fixture's pools, the runner's loss rule in wei. */
  const verdictOf = async (entry: TipCase) => {
    const chains = chainsOf(entry);
    const token = tokenOf(entry);
    const keeper = createPriceKeeper({ poolReader: () => poolReaderAtLatest(fixtureClient({ unreachable: entry.unreachable })), now: () => 0 });
    const holding = await keeper.read([{ key: "fee", token: { chainId: chains.destinationChainId, address: token.address, origin: token.origin }, decimals: token.decimals }], [chains.destinationChainId]);
    const valuation = tokenValuationIn(holding, "fee", chains.destinationChainId, false);
    const costWei = FIXTURE_COST.gasUsed * (FIXTURE_COST.baseFeeWei + FIXTURE_COST.priorityFeeWei);
    const inWei = tipVerdictOfTerms({
      director: directorOf(entry),
      amount: amountOf(entry),
      gas: FIXTURE_COST,
      decimals: token.decimals,
      price: { state: valuation.state, perWholeToken: valuation.weiPerToken },
      cost: costWei,
      rule: { kind: "loss", maximumLossPercent: tipVectors.rules.runnerMaximumLossPercent },
    });
    // The same in USD against the backend's cost of one message (proof and delivery gas), at its margin.
    const deliveryUsd = valuation.nativeUsdE18 === null ? null : (costWei * valuation.nativeUsdE18) / 10n ** 18n;
    const inUsd = tipVerdict({
      amount: amountOf(entry),
      fee: tipUnitsOf(entry),
      decimals: token.decimals,
      price: { state: valuation.state, perWholeToken: valuation.usdE18 },
      cost: deliveryUsd === null ? null : PROOF_COST_USD + deliveryUsd,
      rule: { kind: "margin", marginWad: BigInt(tipVectors.rules.backendProfitMargin) * WAD },
    });
    return { inWei, inUsd };
  };

  for (const entry of tipVectors.cases) {
    it(entry.name, async () => {
      expect(await verdictOf(entry)).toEqual({ inWei: entry.expected, inUsd: entry.expected });
    });
  }
});

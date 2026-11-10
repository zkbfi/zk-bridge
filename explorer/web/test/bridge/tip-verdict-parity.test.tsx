/**
 * Parity of the tip verdict: the dapp judges the shared fixture of `@zkb/core` (vectors/tip-verdict-vectors.json)
 * through its own path, the pool reader of its RPC (`countingCaller` and `poolReaderOver`), `loadPrices` and the price
 * states of `@zkb/react`, the screen's fee and cost, and `dappTipVerdict`, and reaches the verdict the backend and the
 * runner reach. The twins: backend/test/tip-verdict-parity.test.ts and bots/test/unit/tip-verdict-parity.test.ts. Owner,
 * 2026-11-09: a token with no market price pays at a tip of at least the frontend's automatic maximum: "yes, deliver
 * straight away".
 */
import { screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Address } from "viem";
import { DEFAULT_GAS_LEVEL, holdingAfterFailure, holdingAfterRead, totalCostUsd, usdOf, waitEstimate, type PriceMap, type PriceState } from "@zk-bridge/shared";
import { loadPrices, tokenPriceKey, type PriceableToken } from "@zkb/react";
import { FIXTURE_PAIR } from "@terminal/data/fixtures";
import { FIXTURE_COST, amountOf, chainsOf, fixtureClient, tipUnitsOf, tipVectors, tokenOf, type TipCase } from "../../../core/test/fixtures/pool-caller";
import { poolReaderOver } from "../../src/bridge/price-oracle";
import { AUTOMATIC_MAXIMUM_TEXT, dappTipVerdict } from "../../src/bridge/tip-verdict";
import { countingCaller } from "../../src/bridge/use-prices";
import { Shell } from "../../src/app/Shell";
import { connectedWallet, renderWithWallet } from "../app/support";
import { USDC_QUERY } from "./token-link";

/** The dapp's verdict on a case: prices read as the screen reads them, the fee and the cost as the screen values them. */
async function dappOf(entry: TipCase) {
  const chains = chainsOf(entry);
  const token = tokenOf(entry);
  // The token sent sits on the source side; its counterpart is the fee token on the destination.
  const sent: PriceableToken = token.origin === null
    ? { address: token.address, symbol: "FEE", decimals: token.decimals, side: "second", counterpart: null }
    : { address: token.origin.address, symbol: "FEE", decimals: token.decimals, side: "first", counterpart: token.address, isBridgedCopy: false };
  const pair = { first: { chainId: chains.sourceChainId }, second: { chainId: chains.destinationChainId } };
  const client = fixtureClient({ unreachable: entry.unreachable });
  const reader = async () => {
    const block = await client.getBlockNumber();
    const { caller, failures } = countingCaller(client);
    return { ...poolReaderOver(caller, block), failures };
  };
  const wanted = [tokenPriceKey(sent), `native:${chains.sourceChainId}`, `native:${chains.destinationChainId}`];
  let holding;
  try {
    holding = holdingAfterRead(await loadPrices([sent], pair, reader), 0);
  } catch (error) {
    holding = holdingAfterFailure(undefined, wanted, 0, error);
  }
  const prices = holding.data as PriceMap | undefined;
  const nativeQuote = prices?.get(`native:${chains.destinationChainId}`) ?? null;
  const tokenQuote = prices?.get(tokenPriceKey(sent)) ?? null;
  const tipUnits = tipUnitsOf(entry);
  const feeUsd = tokenQuote === null ? null : usdOf(tipUnits, token.decimals, tokenQuote.usdE18);
  const costUsd = nativeQuote === null ? null : totalCostUsd({ ...FIXTURE_COST, nativePriceE18: nativeQuote.usdE18, level: DEFAULT_GAS_LEVEL });
  return dappTipVerdict({ prices, states: holding.states, tokenKey: tokenPriceKey(sent), destinationChainId: chains.destinationChainId, decimals: token.decimals, amount: amountOf(entry), tipUnits, feeUsd, costUsd });
}

describe("the tip verdict of the shared fixture, as the dapp judges it", () => {
  for (const entry of tipVectors.cases) {
    it(entry.name, async () => {
      expect(await dappOf(entry)).toBe(entry.expected);
    });
  }

  it("names the automatic maximum as 1%", () => {
    expect(AUTOMATIC_MAXIMUM_TEXT).toBe("1%");
  });

  it("starts the proof at finality for a paying tip on a testnet, and waits for the batch below the maximum", () => {
    const rule = { minIntervalSeconds: 3600, profitMargin: 1, proofCostUsd: 0.025, priced: false };
    const inputs = { sourceChainId: 11155111, timing: null, rule, proving: null };
    expect(waitEstimate(inputs, { kind: "unpriced", atMaximum: true }).start).toBe("at-finality");
    expect(waitEstimate(inputs, { kind: "unpriced", atMaximum: false }).start).toBe("testnet");
  });

  it("judges nothing before there is an amount, a tip, the prices, or (priced) the cost", () => {
    const base = { prices: undefined, states: new Map<string, PriceState>([["first:0x1", { kind: "known" }], ["native:369", { kind: "known" }]]), tokenKey: "first:0x1", destinationChainId: 369, decimals: 18, amount: 1n, tipUnits: 1n, feeUsd: null, costUsd: null };
    expect(dappTipVerdict({ ...base, amount: null })).toBeNull();
    expect(dappTipVerdict({ ...base, amount: 0n })).toBeNull();
    expect(dappTipVerdict({ ...base, tipUnits: null })).toBeNull();
    expect(dappTipVerdict({ ...base, states: new Map() })).toBeNull();
    const quote = { usdE18: 1n, block: 1n, pool: null as Address | null };
    expect(dappTipVerdict({ ...base, prices: new Map([["first:0x1", quote], ["native:369", quote]]) })).toBeNull();
  });
});

/** What the mocked price layer answers. */
const answer: { states: Map<string, PriceState> } = { states: new Map() };
vi.mock("../../src/bridge/use-prices", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/bridge/use-prices")>();
  return { ...original, usePrices: () => ({ data: undefined, states: answer.states, error: null, isError: false, isFetching: false }) };
});

class EveryKey extends Map<string, PriceState> {
  override get(): PriceState {
    return { kind: "no-market" };
  }
}

describe("the pill, for a token with no market price", () => {
  beforeEach(() => {
    window.localStorage.clear();
    answer.states = new EveryKey();
  });
  /** The pill once You receive shows the amount less the tip. */
  const pillAt = async (extra: string, received: RegExp) => {
    window.history.replaceState(null, "", `#/bridge/${FIXTURE_PAIR.id}?${USDC_QUERY}&bridge.amount=1000${extra}`);
    renderWithWallet(<Shell />, { wallet: connectedWallet() });
    await waitFor(() => expect(document.querySelector(".zb-amount-out")).toHaveTextContent(received));
    const pill = screen.getAllByRole("button").find((button) => button.classList.contains("zb-go"))!;
    return { label: pill.textContent, detail: document.querySelector(".zb-verdict")?.textContent ?? null };
  };

  it("does not warn at the automatic maximum: the runner delivers it straight away", async () => {
    const { label } = await pillAt("", /^990$/);
    expect(label).not.toMatch(/Low tip/);
  });

  it("warns below it, and says the tip pays at 1% of the amount", async () => {
    await pillAt("&tip.mode=percentage&tip.percent=0.5", /^995$/);
    await waitFor(() => expect(screen.getAllByRole("button").find((button) => button.classList.contains("zb-go"))?.textContent).toBe("Low tip · may take about an hour longer"));
    const detail = document.querySelector(".zb-verdict")?.textContent ?? null;
    expect(detail).toMatch(/^No price is known for this token, so a tip pays only at 1% of the amount or more\./);
  });
});

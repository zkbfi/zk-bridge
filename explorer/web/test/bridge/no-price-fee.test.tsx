import { screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FIXTURE_PAIR, FIXTURE_TOKENS } from "@terminal/data/fixtures";
import type { PriceMap, PriceState } from "@zkb/react";
import { Shell } from "../../src/app/Shell";
import { disconnectedWallet, renderWithWallet } from "../app/support";
import { USDC_QUERY } from "./token-link";

/** What the mocked price layer answers; each test sets it. */
const answer: { data: PriceMap | undefined; states: Map<string, PriceState> } = { data: undefined, states: new Map() };

vi.mock("../../src/bridge/use-prices", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/bridge/use-prices")>();
  return { ...original, usePrices: () => ({ data: answer.data, states: answer.states, error: null, isError: false, isFetching: false }) };
});

const { samplePrices } = await import("../../src/bridge/use-prices");

beforeEach(() => {
  window.localStorage.clear();
  answer.data = undefined;
  answer.states = new Map();
});

const output = () => document.querySelector(".zb-amount-out")!;
const open = (amount: string, extra = "") => {
  window.history.replaceState(null, "", `#/bridge/${FIXTURE_PAIR.id}?${USDC_QUERY}&bridge.amount=${amount}${extra}`);
  renderWithWallet(<Shell />, { wallet: disconnectedWallet() });
};
/** Answers every key with one state, whatever the screen asks about. */
class EveryKey extends Map<string, PriceState> {
  constructor(private readonly state: PriceState) {
    super();
  }
  override get(): PriceState {
    return this.state;
  }
}
const everyPriceIs = (state: PriceState): void => {
  answer.states = new EveryKey(state);
};
const sample = () => samplePrices(FIXTURE_TOKENS, FIXTURE_PAIR);

describe("when the price cannot be derived", () => {
  it("known: the fee follows the curve (0.1% or less at the sample prices), with no price note", async () => {
    everyPriceIs({ kind: "known" });
    answer.data = sample();
    open("1000");
    await waitFor(() => expect(output().textContent).not.toBe("0"));
    expect(output()).not.toHaveTextContent(/^990$/);
    expect(document.querySelector(".zb-price-note")).toBeNull();
  });

  it("no market: the fee is the 1% maximum, You receive is the amount less 1% in token units, and the line says why", async () => {
    everyPriceIs({ kind: "no-market" });
    open("1000");
    await waitFor(() => expect(output()).toHaveTextContent(/^990$/));
    expect(await screen.findByText(/^No market price for \w+: the fee is the 1% maximum\.$/)).toBeInTheDocument();
  });

  it("no market with the automatic cap at 2%: the maximum in force is that cap", async () => {
    everyPriceIs({ kind: "no-market" });
    open("1000", "&tip.cap=2");
    await waitFor(() => expect(output()).toHaveTextContent(/^980$/));
  });

  it("unreachable: the fee is the 1% maximum and the line says prices are unreachable, not that there is no market", async () => {
    everyPriceIs({ kind: "unreachable" });
    open("1000");
    await waitFor(() => expect(output()).toHaveTextContent(/^990$/));
    expect(await screen.findByText(/^Prices can't be reached right now, so the fee is the 1% maximum\. They are read again every 30 seconds\.$/)).toBeInTheDocument();
    expect(screen.queryByText(/No market price/)).toBeNull();
  });

  it("stale: the last price is used (the fee is not the maximum) and the line gives its age", async () => {
    everyPriceIs({ kind: "stale", ageSeconds: 125 });
    answer.data = sample();
    open("1000");
    expect(await screen.findByText(/^Prices can't be reached right now\. Using the last price, 2 min old, until it is 10 minutes old\.$/)).toBeInTheDocument();
    await waitFor(() => expect(output().textContent).not.toBe("0"));
    expect(output()).not.toHaveTextContent(/^990$/);
  });
});

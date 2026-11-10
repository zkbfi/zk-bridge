import userEvent from "@testing-library/user-event";
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
/** Hovers the fee pill and returns its tooltip's text. */
const pillTooltip = async (): Promise<string> => {
  await userEvent.hover(screen.getByRole("button", { name: /^Delivery settings/ }));
  return (await screen.findByRole("tooltip")).textContent ?? "";
};
/** Nothing stands under the amount: the fact lives in the pill's tooltip and the delivery menu. */
const noStandingNote = (): void => {
  expect(document.querySelector(".zb-price-note")).toBeNull();
  expect(document.querySelector(".zb-amount-out")!.closest("section, form, div")!.parentElement!.querySelector("p[role=status]")).toBeNull();
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
    expect(await pillTooltip()).toMatch(/1% maximum: \w+ has no market price\. Tap for the delivery settings\.$/);
    noStandingNote();
    expect(screen.queryByText(/^1% maximum: \w+ has no market price$/)).toBeNull();
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
    expect(await pillTooltip()).toContain("1% maximum: prices unreachable, read again every 30 s.");
    expect(screen.queryByText(/has no market price/)).toBeNull();
    noStandingNote();
  });

  it("stale: the last price is used (the fee is not the maximum) and the line gives its age", async () => {
    everyPriceIs({ kind: "stale", ageSeconds: 125 });
    answer.data = sample();
    open("1000");
    expect(await pillTooltip()).toContain("Price from 2 min ago.");
    noStandingNote();
    await waitFor(() => expect(output().textContent).not.toBe("0"));
    expect(output()).not.toHaveTextContent(/^990$/);
  });
});

describe("the native coin carries a tip like a token (owner: \"why would there be no tip by default?\")", () => {
  const openNative = (amount: string, extra = "") => {
    window.history.replaceState(null, "", `#/bridge/${FIXTURE_PAIR.id}?bridge.token=first:native&bridge.amount=${amount}${extra}`);
    renderWithWallet(<Shell />, { wallet: disconnectedWallet() });
  };

  it("with no market price: the fee is the 1% automatic maximum and the line says why, as for a token", async () => {
    everyPriceIs({ kind: "no-market" });
    openNative("1000");
    await waitFor(() => expect(output()).toHaveTextContent(/^990$/));
    expect(await pillTooltip()).toMatch(/1% maximum: \w+ has no market price\./);
    expect(screen.getByRole("button", { name: /^Delivery settings/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Gas level/ })).toBeInTheDocument();
    expect(screen.queryByText(/no tip/i)).toBeNull();
  });

  it("shows no no-tip note by default (owner: 'there is also this note for some reason: \"Sent as SepETH: no tip; ...\"')", async () => {
    everyPriceIs({ kind: "known" });
    answer.data = sample();
    openNative("1");
    await waitFor(() => expect(screen.getByRole("button", { name: /^Delivery settings/ })).toHaveTextContent(/Deliver/));
    expect(screen.queryByText(/no tip/i)).toBeNull();
    expect(screen.queryByText(/Sent as/)).toBeNull();
    expect(screen.queryByText(/anyone can deliver it, for free/)).toBeNull();
  });

  it("with prices known: the fee follows the curve, so You receive is less than the amount", async () => {
    everyPriceIs({ kind: "known" });
    answer.data = sample();
    openNative("2");
    await waitFor(() => expect(output().textContent).not.toBe("0"));
    await waitFor(() => expect(output()).not.toHaveTextContent(/^2$/));
    expect(screen.getByRole("button", { name: /^Delivery settings/ })).toHaveTextContent(/Deliver for/);
  });

  it("says nothing about prices for a zero amount", async () => {
    everyPriceIs({ kind: "no-market" });
    openNative("0");
    await waitFor(() => expect(screen.getByRole("button", { name: /^Delivery settings/ })).toBeInTheDocument());
    expect(document.querySelector(".zb-price-note")).toBeNull();
  });

  it("names the destination's coin when only its price is missing", async () => {
    answer.data = sample();
    answer.states = new Map(Object.entries({ [`native:${FIXTURE_PAIR.second.chainId}`]: { kind: "no-market" } as PriceState }));
    openNative("1");
    await waitFor(() => expect(screen.getByRole("button", { name: /^Delivery settings/ })).toBeInTheDocument());
    expect(await pillTooltip()).toContain(`${FIXTURE_PAIR.second.nativeSymbol} has no market price`);
  });

  it("No tip is the user's choice: the pill reads No tip, nothing stands under the amount, and You receive is the amount", async () => {
    everyPriceIs({ kind: "no-market" });
    openNative("1000", "&tip.mode=none");
    await waitFor(() => expect(screen.getByRole("button", { name: /^Delivery settings/ })).toHaveTextContent(/^No tip$/));
    expect(screen.queryByText(/anyone can deliver it, for free/)).toBeNull();
    await waitFor(() => expect(output()).toHaveTextContent(/^1,?000$/));
    expect(screen.queryByText(/maximum/)).toBeNull();
  });
});

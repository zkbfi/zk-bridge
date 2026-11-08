import { screen, waitFor, within } from "@testing-library/react";
import { StrictMode } from "react";
import { beforeEach, describe, expect, it } from "vitest";
import { FIXTURE_PAIR, FIXTURE_TOKENS } from "@terminal/data/fixtures";
import { Shell } from "../../src/app/Shell";
import { parseLocation, resolvePair } from "../../src/app/route";
import type { Services } from "../../src/app/services";
import { choiceOf, nativeTokensOf, tokenFor } from "../../src/bridge/bridge-model";
import { buildTestServices } from "../render";
import { disconnectedWallet, renderWithWallet } from "../app/support";
import { USDC_QUERY } from "./token-link";

beforeEach(() => {
  window.localStorage.clear();
});

/** The fixture services with a data source that answers the given overrides. */
const servicesWith = (overrides: Partial<Services["dataSource"]>): Partial<Services> => {
  const base = buildTestServices().dataSource;
  return { dataSource: new Proxy(base, { get: (target, key) => (key in overrides ? overrides[key as keyof typeof overrides] : Reflect.get(target, key)) }) };
};

const output = () => document.querySelector(".zb-amount-out")!;
const fromBand = () => screen.getByRole("region", { name: /^You send/ });

describe("the owner's link, #/bridge/eth-pls?bridge.amount=1, with no wallet", () => {
  it("reads the amount from bridge.amount and from a bare amount", () => {
    for (const hash of ["#/bridge/eth-pls?bridge.amount=1", "#/bridge/eth-pls?amount=1"]) {
      const { route } = parseLocation(hash);
      expect(route).toMatchObject({ name: "bridge", pairId: "eth-pls", form: { amount: "1" } });
    }
  });

  it("defaults to the source chain's native coin when no token is bridged yet, so the pill shows and the output follows", async () => {
    window.history.replaceState(null, "", `#/bridge/${FIXTURE_PAIR.id}?bridge.amount=1`);
    renderWithWallet(<Shell />, { wallet: disconnectedWallet(), services: servicesWith({ listTokens: async () => [] }) });
    expect(await within(await screen.findByRole("region", { name: /^You send/ })).findByRole("button", { name: /^Token: ETH/ })).toBeInTheDocument();
    // The wrap route carries no tip, so all of it arrives.
    await waitFor(() => expect(output()).toHaveTextContent(/^1$/));
  });

  it("estimates the fee without a wallet: the output is the amount less the fee, and the fee line is filled", async () => {
    window.history.replaceState(null, "", `#/bridge/${FIXTURE_PAIR.id}?${USDC_QUERY}&bridge.amount=1`);
    const { container } = renderWithWallet(<Shell />, { wallet: disconnectedWallet() });
    await within(await screen.findByRole("region", { name: /^You send/ })).findByRole("button", { name: /^Token:/ });
    // At the sample prices 1 USDC is $1: the default fee wants twice the $0.025 proof cost, and the 1% cap holds it at $0.01.
    await waitFor(() => expect(output()).toHaveTextContent(/^0\.99$/));
    expect(container.querySelector('[data-fee="tip"]')!.textContent).not.toMatch(/—/);
    expect(fromBand()).toBeInTheDocument();
  });

  it("shows the amount with 'fee unknown' when the estimate cannot be read, never 0", async () => {
    window.history.replaceState(null, "", `#/bridge/${FIXTURE_PAIR.id}?${USDC_QUERY}&bridge.amount=1`);
    renderWithWallet(<Shell />, {
      wallet: disconnectedWallet(),
      services: servicesWith({
        getDeliveryCost: async () => {
          throw new Error("down");
        },
      }),
    });
    await waitFor(() => expect(output()).toHaveTextContent(/^1$/));
    expect(await screen.findByText("fee unknown")).toBeInTheDocument();
  });
});

describe("the default token", () => {
  const withTokens = [...FIXTURE_TOKENS, ...nativeTokensOf(FIXTURE_PAIR)];

  it("is the gas token of the side the transfer leaves from: ETH out of the first chain, PLS out of the second", () => {
    expect(tokenFor(undefined, withTokens, "first")?.symbol).toBe("ETH");
    expect(tokenFor(undefined, withTokens, "second")?.symbol).toBe("PLS");
    // The native coins come last in the list, so this is not the first token of the side.
    expect(withTokens.find((token) => token.side === "first")?.symbol).not.toBe("ETH");
  });

  it("is the first token of the side when the pair has no wrap route", () => {
    const noWrap = { ...FIXTURE_PAIR, first: { ...FIXTURE_PAIR.first, contracts: { ...FIXTURE_PAIR.first.contracts, wrappedNative: null } } };
    const list = [...FIXTURE_TOKENS, ...nativeTokensOf(noWrap)];
    expect(tokenFor(undefined, list, "first")).toBe(FIXTURE_TOKENS.find((token) => token.side === "first"));
    expect(tokenFor(undefined, list, "second")?.symbol).toBe("PLS");
  });

  it("is nothing when the side has no token at all", () => {
    expect(tokenFor(undefined, [], "first")).toBeNull();
  });

  it("gives way to a token the form names", () => {
    const usdc = FIXTURE_TOKENS.find((token) => token.side === "first")!;
    expect(tokenFor(choiceOf(usdc), withTokens, "first")).toBe(usdc);
    expect(tokenFor("first:native", withTokens, "first")?.symbol).toBe("ETH");
  });

  it("lists the native coins of the pair, one per wrap route", () => {
    const natives = nativeTokensOf(FIXTURE_PAIR);
    expect(natives.map((token) => `${token.side}:${token.symbol}`)).toEqual(["first:ETH", "second:PLS"]);
    const noWrap = { ...FIXTURE_PAIR, first: { ...FIXTURE_PAIR.first, contracts: { ...FIXTURE_PAIR.first.contracts, wrappedNative: null } } };
    expect(nativeTokensOf(noWrap).map((token) => token.symbol)).toEqual(["PLS"]);
  });

  it("opens the Bridge screen on ETH when sending from the first chain, even though bridged tokens exist", async () => {
    window.history.replaceState(null, "", `#/bridge/${FIXTURE_PAIR.id}`);
    renderWithWallet(<Shell />, { wallet: disconnectedWallet() });
    expect(await within(await screen.findByRole("region", { name: /^You send/ })).findByRole("button", { name: /^Token: ETH/ })).toBeInTheDocument();
  });

  it("opens on PLS when the link sends from the second chain, and on the named token when the link names one", async () => {
    window.history.replaceState(null, "", `#/bridge/${FIXTURE_PAIR.id}?dir=second-to-first`);
    const first = renderWithWallet(<Shell />, { wallet: disconnectedWallet() });
    expect(await within(await screen.findByRole("region", { name: /^You send/ })).findByRole("button", { name: /^Token: PLS/ })).toBeInTheDocument();
    first.unmount();
    const usdc = FIXTURE_TOKENS.find((token) => token.side === "first")!;
    window.history.replaceState(null, "", `#/bridge/${FIXTURE_PAIR.id}?bridge.token=${encodeURIComponent(choiceOf(usdc))}`);
    renderWithWallet(<Shell />, { wallet: disconnectedWallet() });
    expect(await within(await screen.findByRole("region", { name: /^You send/ })).findByRole("button", { name: new RegExp(`^Token: ${usdc.symbol}`) })).toBeInTheDocument();
  });
});

describe("a pair this build does not have", () => {
  it("moves to the default pair and says so", () => {
    expect(resolvePair({ name: "bridge", pairId: "eth-pls", dir: "first-to-second", form: { amount: "1" } }, "sepolia-pls943")).toEqual({
      route: { name: "bridge", pairId: "sepolia-pls943", dir: "first-to-second", form: { amount: "1" } },
      unknown: "eth-pls",
    });
    expect(resolvePair({ name: "bridge", pairId: "sepolia-pls943", dir: "first-to-second" }, "sepolia-pls943").unknown).toBeNull();
  });

  it("replaces the address and shows a short notice, also under strict mode's double first render", async () => {
    window.history.replaceState(null, "", "#/bridge/nowhere-pair?bridge.amount=1");
    renderWithWallet(
      <StrictMode>
        <Shell />
      </StrictMode>,
      { wallet: disconnectedWallet() },
    );
    expect(await screen.findByRole("status")).toHaveTextContent(`nowhere-pair isn't available here; showing ${FIXTURE_PAIR.label}`);
    expect(window.location.hash).toBe(`#/bridge/${FIXTURE_PAIR.id}?bridge.amount=1`);
  });
});

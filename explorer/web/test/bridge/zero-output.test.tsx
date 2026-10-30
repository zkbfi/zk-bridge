import { screen, waitFor, within } from "@testing-library/react";
import { StrictMode } from "react";
import { beforeEach, describe, expect, it } from "vitest";
import { FIXTURE_PAIR } from "@terminal/data/fixtures";
import { Shell } from "../../src/app/Shell";
import { parseLocation, resolvePair } from "../../src/app/route";
import type { Services } from "../../src/app/services";
import { nativeTokensOf, tokenFor } from "../../src/bridge/bridge-model";
import { buildTestServices } from "../render";
import { disconnectedWallet, renderWithWallet } from "../app/support";

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
    window.history.replaceState(null, "", `#/bridge/${FIXTURE_PAIR.id}?bridge.amount=1`);
    const { container } = renderWithWallet(<Shell />, { wallet: disconnectedWallet() });
    await within(await screen.findByRole("region", { name: /^You send/ })).findByRole("button", { name: /^Token:/ });
    await waitFor(() => expect(output()).toHaveTextContent(/^0\.999$/));
    expect(container.querySelector('[data-fee="tip"]')!.textContent).not.toMatch(/—/);
    expect(fromBand()).toBeInTheDocument();
  });

  it("shows the amount with 'fee unknown' when the estimate cannot be read, never 0", async () => {
    window.history.replaceState(null, "", `#/bridge/${FIXTURE_PAIR.id}?bridge.amount=1`);
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
  it("is the first known token, else the native coin where the wrap route exists, else nothing", () => {
    const natives = nativeTokensOf(FIXTURE_PAIR);
    expect(natives.map((token) => `${token.side}:${token.symbol}`)).toEqual(["first:ETH", "second:PLS"]);
    expect(tokenFor(undefined, natives, "second")?.symbol).toBe("PLS");
    expect(tokenFor("first:native", natives, "first")?.symbol).toBe("ETH");
    const noWrap = { ...FIXTURE_PAIR, first: { ...FIXTURE_PAIR.first, contracts: { ...FIXTURE_PAIR.first.contracts, wrappedNative: null } } };
    expect(nativeTokensOf(noWrap).map((token) => token.symbol)).toEqual(["PLS"]);
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

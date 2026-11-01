import { screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { FIXTURE_PAIR, FIXTURE_TOKENS } from "@terminal/data/fixtures";
import { Shell } from "../../src/app/Shell";
import { samplePrices } from "../../src/bridge/use-prices";
import { connectedWallet, renderWithWallet } from "../app/support";

beforeEach(() => {
  window.localStorage.clear();
});

/** The pill and its detail once the fee is known. */
const pillAt = async (query: string) => {
  window.history.replaceState(null, "", `#/bridge/${FIXTURE_PAIR.id}?${query}`);
  renderWithWallet(<Shell />, { wallet: connectedWallet() });
  await waitFor(() => expect(document.querySelector('[data-fee="tip"]')?.getAttribute("aria-label")).toMatch(/Fee \d/), { timeout: 3000 });
  const pill = screen.getAllByRole("button").find((button) => button.classList.contains("zb-go"))!;
  return { label: pill.textContent, detail: document.querySelector(".zb-verdict")?.textContent ?? null };
};

describe("the fee warnings on the Bridge pill, at the sample prices", () => {
  it("warns a small transfer may not be delivered in a timely manner when the cost is above the cap's share, with the numbers", async () => {
    // PulseChain → Ethereum: about $7.59 to deliver and prove on Ethereum, against 1% of $5.
    const { label, detail } = await pillAt("dir=second-to-first&bridge.amount=5");
    expect(label).toBe("Small transfer · may not be delivered in a timely manner");
    expect(detail).toBe("Delivery costs about $7.59, more than the 1% ($0.05) you allow. A bot may wait for cheaper gas: raise the cap in the tip drawer, or deliver it yourself.");
  });

  it("moves the line with the cap: $4 to PulseChain (about $0.025 of cost) is not small at 1%; the capped $0.04 only reads as a low fee", async () => {
    expect((await pillAt("bridge.amount=4")).label).toBe("Tip too low · may not be delivered");
  });

  it("is small at a 0.5% cap", async () => {
    const { label, detail } = await pillAt("bridge.amount=4&tip.cap=0.5");
    expect(label).toBe("Small transfer · may not be delivered in a timely manner");
    expect(detail).toMatch(/more than the 0\.5% \(\$0\.02\) you allow/);
  });

  it("shows the low fee with its numbers when the cap holds the fee under twice the cost", async () => {
    const { label, detail } = await pillAt("dir=second-to-first&bridge.amount=1000");
    expect(label).toBe("Tip too low · may not be delivered");
    expect(detail).toMatch(/^The fee \(\$10\.00\) is under twice what delivering and proving it should cost \(\$7\.59 now\)/);
  });

  it("shows High cap % for a chosen tip well above the line, never alongside another fee warning", async () => {
    const { label, detail } = await pillAt("bridge.amount=500&tip.percent=1");
    expect(label).toBe("High cap %");
    expect(detail).toMatch(/^The tip, before gas, is \$4\.9\d, over the 0\.2% of the amount/);
  });

  it("takes the default curve fee with no warning in the middle", async () => {
    expect((await pillAt("bridge.amount=50")).label).toBe("Bridge");
    expect(document.querySelector('[data-fee="tip"]')?.getAttribute("aria-label")).toMatch(/Fee 0\.193892/);
  });
});

describe("the sample prices", () => {
  it("price USDC at $1, ETH at $3,000 and PLS at $0.00003, zkb copies by their origin, at block 0", () => {
    const prices = samplePrices(FIXTURE_TOKENS, FIXTURE_PAIR);
    const usdc = FIXTURE_TOKENS.find((token) => token.symbol === "zUSDC")!;
    expect(prices.get(`${usdc.side}:${usdc.address}`)).toEqual({ usdE18: 10n ** 18n, block: 0n, pool: null });
    expect(prices.get("native:1")?.usdE18).toBe(3_000n * 10n ** 18n);
    expect(prices.get("native:369")?.usdE18).toBe(30_000_000_000_000n);
    expect(samplePrices([{ ...usdc, symbol: "ODD" }], { ...FIXTURE_PAIR, first: { ...FIXTURE_PAIR.first, chainId: 5 } }).get("native:5")).toBeNull();
  });
});

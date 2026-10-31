import { waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { FIXTURE_PAIR, FIXTURE_TOKENS } from "@terminal/data/fixtures";
import type { PairConfig, TokenInfo } from "@terminal/model/types";
import { Shell } from "../../src/app/Shell";
import { formatRoute, parseRoute } from "../../src/app/route";
import { choiceOf, counterpartOf, nativeTokensOf, tokenFor } from "../../src/bridge/bridge-model";
import { connectedWallet, renderWithWallet } from "../app/support";

// The owner (quotes 101–102): a link names the native coin as the zero address on its chain, "native" is read and
// rewritten at once, and a flip keeps the asset instead of landing on the other chain's own coin.

const ZERO = "0x0000000000000000000000000000000000000000";
const WETH = FIXTURE_PAIR.first.contracts.wrappedNative!;
const WPLS = FIXTURE_PAIR.second.contracts.wrappedNative!;
const ZKB_WETH = "0x00000000000000000000000000000000000000a2";
const ZKB_WPLS = "0x00000000000000000000000000000000000000a1";
const tokens: readonly TokenInfo[] = [
  { address: "0x0000000000000000000000000000000000001001", symbol: "USDC", decimals: 6, side: "first", counterpart: "0x0000000000000000000000000000000000002001" },
  { address: "0x0000000000000000000000000000000000002001", symbol: "zkbUSDC", decimals: 6, side: "second", counterpart: "0x0000000000000000000000000000000000001001" },
  { address: WETH, symbol: "WETH", decimals: 18, side: "first", counterpart: ZKB_WETH },
  { address: ZKB_WETH, symbol: "zkbWETH", decimals: 18, side: "second", counterpart: WETH },
  { address: WPLS, symbol: "WPLS", decimals: 18, side: "second", counterpart: ZKB_WPLS },
  { address: ZKB_WPLS, symbol: "zkbWPLS", decimals: 18, side: "first", counterpart: WPLS },
  ...nativeTokensOf(FIXTURE_PAIR as PairConfig),
];
const bySymbol = (symbol: string): TokenInfo => tokens.find((token) => token.symbol === symbol)!;

describe("the native coin in a link", () => {
  it("is written as the zero address on its chain, and read back as the native coin", () => {
    const hash = formatRoute({ name: "bridge", pairId: FIXTURE_PAIR.id, dir: "first-to-second", form: { token: "first:native", amount: "1" } });
    expect(hash).toContain(`bridge.token=first%3A${ZERO}`);
    expect(parseRoute(hash)).toMatchObject({ form: { token: "first:native" } });
  });

  it("reads \"native\" and the older side:native, taking a bare \"native\" from the direction's source chain", () => {
    expect(parseRoute(`#/bridge/${FIXTURE_PAIR.id}?bridge.token=first:native`)).toMatchObject({ form: { token: "first:native" } });
    expect(parseRoute(`#/bridge/${FIXTURE_PAIR.id}?dir=second-to-first&bridge.token=native`)).toMatchObject({ form: { token: "second:native" } });
    expect(parseRoute(`#/bridge/${FIXTURE_PAIR.id}?bridge.token=native`)).toMatchObject({ form: { token: "first:native" } });
  });

  it("an old link opens on the native coin and its address moves at once to the zero-address form, with no new history entry", async () => {
    window.history.replaceState(null, "", `#/bridge/${FIXTURE_PAIR.id}?bridge.token=first:native&bridge.amount=1`);
    const before = window.history.length;
    renderWithWallet(<Shell />, { wallet: connectedWallet() });
    await waitFor(() => expect(decodeURIComponent(window.location.hash)).toContain(`bridge.token=first:${ZERO}`));
    expect(window.history.length).toBe(before);
    expect(tokenFor("first:native", tokens, "first")?.symbol).toBe("ETH");
  });
});

describe("a flip keeps the asset", () => {
  it("native ETH on Ethereum flips to zkbWETH, and zkbWETH flips back to ETH", () => {
    const eth = tokens.find((token) => token.symbol === "ETH")!;
    expect(counterpartOf(eth, tokens, FIXTURE_PAIR as PairConfig)?.symbol).toBe("zkbWETH");
    expect(counterpartOf(bySymbol("zkbWETH"), tokens, FIXTURE_PAIR as PairConfig)?.symbol).toBe("ETH");
    expect(choiceOf(eth)).toBe("first:native");
  });

  it("native PLS flips to zkbWPLS, never to Ethereum's own coin", () => {
    const pls = tokens.find((token) => token.symbol === "PLS")!;
    expect(counterpartOf(pls, tokens, FIXTURE_PAIR as PairConfig)?.symbol).toBe("zkbWPLS");
  });

  it("a plain token flips to its counterpart and back", () => {
    expect(counterpartOf(bySymbol("USDC"), tokens, FIXTURE_PAIR as PairConfig)?.symbol).toBe("zkbUSDC");
    expect(counterpartOf(bySymbol("zkbUSDC"), tokens, FIXTURE_PAIR as PairConfig)?.symbol).toBe("USDC");
  });

  it("a token with no counterpart in the list falls back to the other chain's first token, not its native coin", () => {
    const lone: TokenInfo = { address: "0x0000000000000000000000000000000000009999", symbol: "LONE", decimals: 18, side: "first", counterpart: null };
    expect(counterpartOf(lone, [...FIXTURE_TOKENS, ...nativeTokensOf(FIXTURE_PAIR as PairConfig)], FIXTURE_PAIR as PairConfig)?.symbol).toBe("zkbUSDC");
  });
});

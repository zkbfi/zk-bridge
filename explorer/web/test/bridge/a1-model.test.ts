import { describe, expect, it } from "vitest";
import { FIXTURE_PAIR } from "@terminal/data/fixtures";
import type { PairConfig, TokenInfo } from "@terminal/model/types";
import { amountText, counterpartOf, directionFrom, nativeTokensOf, nonNegative, percentProblem, percentToWad, receivedOf, reverse, rpcUrlFor, shareOfAmount, signedShareOf, tipWadOf, usdPercentOf, withLightClientStep, type TransferStep } from "../../src/bridge/bridge-model";

const pair = FIXTURE_PAIR as PairConfig;

describe("the direction helpers", () => {
  it("reverse swaps the direction both ways, and directionFrom names the direction that leaves a side", () => {
    expect(reverse("first-to-second")).toBe("second-to-first");
    expect(reverse("second-to-first")).toBe("first-to-second");
    expect(directionFrom("first")).toBe("first-to-second");
    expect(directionFrom("second")).toBe("second-to-first");
  });
});

describe("counterpartOf without a pair", () => {
  const usdc: TokenInfo = { address: "0x0000000000000000000000000000000000001001", symbol: "USDC", decimals: 6, side: "first", counterpart: "0x0000000000000000000000000000000000002001" };
  const zusdc: TokenInfo = { address: "0x0000000000000000000000000000000000002001", symbol: "zUSDC", decimals: 6, side: "second", counterpart: usdc.address };
  const [ethCoin] = nativeTokensOf(pair);

  it("finds a token's copy by the list alone, with no native swap since no chain is known", () => {
    expect(counterpartOf(usdc, [usdc, zusdc, ethCoin!])).toBe(zusdc);
  });

  it("gives the native coin no counterpart of its own: it falls back to the other chain's default token", () => {
    expect(counterpartOf(ethCoin!, [usdc, zusdc, ethCoin!])).toBe(zusdc);
  });
});

describe("withLightClientStep", () => {
  const steps: readonly TransferStep[] = [{ label: "Sent on A", estimate: "~12 s", seconds: 12 }, { label: "Delivered", estimate: "~1 min", seconds: 60 }];

  it("appends the row at the end when no step is the proof", () => {
    const out = withLightClientStep(steps, { seconds: 7200 });
    expect(out.map((step) => step.label)).toEqual(["Sent on A", "Delivered", "Light client is 2 h behind"]);
    expect(out[2]).toMatchObject({ estimate: "no added wait", seconds: 0 });
  });

  it("puts the row right after the proof step when there is one", () => {
    const withProof = [steps[0]!, { label: "Proof of the finalized block", estimate: "~2 min", seconds: 120 }, steps[1]!];
    expect(withLightClientStep(withProof, { seconds: 10800 }).map((step) => step.label)).toEqual(["Sent on A", "Proof of the finalized block", "Light client is 3 h behind", "Delivered"]);
  });

  it("leaves the steps alone without a delay", () => {
    expect(withLightClientStep(steps, null)).toBe(steps);
  });
});

describe("the search shortcut", () => {
  it("reads ⌘K on Apple platforms, by platform or by user agent, and Ctrl K elsewhere", async () => {
    const { shortcutOf } = await import("../../src/bridge/Header");
    expect(shortcutOf({ platform: "MacIntel", userAgent: "x" })).toBe("⌘K");
    expect(shortcutOf({ platform: "", userAgent: "Mozilla (iPhone; CPU)" })).toBe("⌘K");
    expect(shortcutOf({ platform: "Win32", userAgent: "Mac" })).toBe("Ctrl K");
    expect(shortcutOf({ platform: "", userAgent: "" })).toBe("Ctrl K");
    expect(shortcutOf(undefined)).toBe("Ctrl K");
  });
});

describe("percentProblem", () => {
  it("accepts a share from 0 to 100, with or without a percent sign", () => {
    expect(percentProblem("0.5")).toBeNull();
    expect(percentProblem(" 12% ")).toBeNull();
    expect(percentProblem("0")).toBeNull();
    expect(percentProblem("100")).toBeNull();
  });

  it("asks for a number when the text is empty or not one", () => {
    expect(percentProblem("")).toBe("Enter a number, such as 0.5.");
    expect(percentProblem("  ")).toBe("Enter a number, such as 0.5.");
    expect(percentProblem("abc")).toBe("Enter a number, such as 0.5.");
  });

  it("refuses a share below 0 or above 100", () => {
    expect(percentProblem("-1")).toBe("Use a number from 0 to 100.");
    expect(percentProblem("100.5%")).toBe("Use a number from 0 to 100.");
  });
});

describe("rpcUrlFor", () => {
  it("takes the user's choice, then the configuration's, then the default, and null when there is none", () => {
    expect(rpcUrlFor("https://mine", "https://configured", "https://default")).toBe("https://mine");
    expect(rpcUrlFor(undefined, "https://configured", "https://default")).toBe("https://configured");
    expect(rpcUrlFor(undefined, undefined, "https://default")).toBe("https://default");
    expect(rpcUrlFor(undefined, undefined, null)).toBeNull();
  });
});

describe("receivedOf and nonNegative", () => {
  it("is the amount less the fee once the fee is known, the amount before, and null with no amount", () => {
    expect(receivedOf(1000n, 30n)).toBe(970n);
    expect(receivedOf(1000n, null)).toBe(1000n);
    expect(receivedOf(null, 30n)).toBeNull();
    expect(receivedOf(null, null)).toBeNull();
  });

  it("goes below zero for a fee above the amount, which nonNegative shows as zero", () => {
    expect(receivedOf(10n, 30n)).toBe(-20n);
    expect(nonNegative(-20n)).toBe(0n);
    expect(nonNegative(0n)).toBe(0n);
    expect(nonNegative(5n)).toBe(5n);
  });
});

describe("amountText", () => {
  it("shows a dust amount of a token with many decimals to its last digit, and cuts a larger one to 6 decimals", () => {
    expect(amountText(1n, 18)).toBe("0.000000000000000001");
    expect(amountText(1_234_567_891_000_000_000n, 18)).toBe("1.234567");
    expect(amountText(0n, 18)).toBe("0");
    expect(amountText(1_500_000n, 6)).toBe("1.5");
  });
});

describe("percentToWad", () => {
  it("turns a percent into a share of the amount to 4 decimals", () => {
    expect(percentToWad(100)).toBe(10n ** 18n);
    expect(percentToWad(0.5)).toBe(5n * 10n ** 15n);
    expect(percentToWad(0.00004)).toBe(0n);
    expect(percentToWad(1.23456)).toBe(12_346n * 10n ** 12n);
  });
});

describe("the tip and share arithmetic", () => {
  const WAD = 10n ** 18n;
  it("tipWadOf is what is left of the fee after the cost, as a share of the amount to 0.0001%, and none when the cost is the fee or more", () => {
    // A $5.025 fee over a $0.025 cost on $500 is 1%.
    expect(tipWadOf(5_025n * 10n ** 15n, 25n * 10n ** 15n, 500n * WAD)).toBe(WAD / 100n);
    expect(tipWadOf(25n * 10n ** 15n, 25n * 10n ** 15n, 500n * WAD)).toBe(0n);
    expect(tipWadOf(10n ** 15n, 25n * 10n ** 15n, 500n * WAD)).toBe(0n);
    // The dust under 0.00005% rounds away.
    expect(tipWadOf(25n * 10n ** 15n + 10n ** 6n, 25n * 10n ** 15n, 500n * WAD)).toBe(0n);
  });

  it("signedShareOf adds the cost's share to the tip and keeps 0.000001% of the amount", () => {
    expect(signedShareOf(WAD / 100n, 5n * WAD, 500n * WAD)).toBe(WAD / 50n);
    expect(signedShareOf(0n, 3n, 500n * WAD)).toBe(0n);
  });

  it("shareOfAmount and usdPercentOf give percents of an amount", () => {
    expect(shareOfAmount(5n, 1_000n)).toBe(0.5);
    expect(shareOfAmount(1n, 3n)).toBe(33.3333);
    expect(usdPercentOf(WAD / 2n, 100n * WAD)).toBe(0.5);
    expect(usdPercentOf(1n, 100n * WAD)).toBe(0);
  });
});

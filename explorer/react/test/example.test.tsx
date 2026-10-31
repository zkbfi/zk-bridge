/**
 * The example host app of README.md, rendered. Keep the two in step: the snippet below is the one in the README.
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
// --- README example starts here
import { useState } from "react";
import { PRICE_NOTE, ReviewNotice, ReviewRow, ReviewSheet, TokenIcon, useDefaultFee, useFeeCaps, useHardCap, usePrices, useVerdict, type PriceSource } from "../src/index.js";
// In a real host: import { ... } from "@zkb/react"; import "@zkb/react/styles.css";

const ETH = { address: "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE", symbol: "ETH", decimals: 18, side: "first", counterpart: null } as const;
const pair = { first: { chainId: 1 }, second: { chainId: 369 } };
// The host decides where prices come from. Here: the sample data. A live host passes { mode: "live", id, poolReader }.
const source: PriceSource = { mode: "sample" };

export const Bridge = ({ amountUsd }: { amountUsd: bigint }) => {
  const [review, setReview] = useState(false);
  const caps = useFeeCaps(); // the caps live in the host's storage (localStorage unless you pass your own)
  const prices = usePrices({ tokens: [ETH], pair, source }).data;
  const costUsd = 5n * 10n ** 18n; // the host reads the delivery cost from its own indexer
  const { auto } = useDefaultFee({ amountUsd, costUsd, costNormalUsd: costUsd, capPercent: caps.storedCap });
  const amountUnits = 10n ** 18n;
  const feeUnits = amountUnits / 100n; // 1% of the amount
  const hard = useHardCap({ hardCapPercent: caps.hardCapPercent, amountUnits, feeUnits, worstFeeUnits: 0n });
  const { verdict, pressable } = useVerdict({
    connected: true,
    draft: { status: "ready", reason: null },
    amountEntered: true,
    overBalance: false,
    symbol: ETH.symbol,
    paused: null,
    tipBelowBreakEven: false,
  });
  const price = prices?.get(`first:${ETH.address}`)?.usdE18;
  return (
    <main>
      <TokenIcon subject={{ chainId: 1 }} symbol="ETH" imageServer="https://img.example/{chainId}/{address}" />
      <p title={PRICE_NOTE}>{price === undefined ? "no price" : `ETH $${price / 10n ** 18n}`}</p>
      <p>Default fee: ${(auto.feeUsd ?? 0n) / 10n ** 16n} cents; hard cap {caps.hardCapPercent}%{hard.over ? " (over)" : ""}</p>
      <button type="button" disabled={!pressable} onClick={() => setReview(true)}>{verdict.label}</button>
      {review ? (
        <ReviewSheet onClose={() => setReview(false)}>
          <ReviewRow label="You send"><b>1 ETH</b></ReviewRow>
          <ReviewNotice>Check the receiver before you confirm.</ReviewNotice>
        </ReviewSheet>
      ) : null}
    </main>
  );
};
// --- README example ends here

describe("the example host app", () => {
  it("renders with the hooks fed by the host, and opens the review sheet", async () => {
    window.localStorage.clear();
    const { container } = render(<Bridge amountUsd={3_000n * 10n ** 18n} />);
    await waitFor(() => expect(screen.getByText("ETH $3000")).toBeInTheDocument());
    expect(screen.getByText(/Default fee: \$\d+ cents; hard cap 2%$/)).toBeInTheDocument();
    expect(container.querySelector("img")).toHaveAttribute("src", "https://img.example/1");
    await userEvent.click(screen.getByRole("button", { name: "Bridge" }));
    expect(screen.getByRole("dialog", { name: "Review" })).toHaveTextContent("You send1 ETH");
    expect(screen.getByText("Check the receiver before you confirm.")).toHaveClass("zb-warnbox");
  });
});

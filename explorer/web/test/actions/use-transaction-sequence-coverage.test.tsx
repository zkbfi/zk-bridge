import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useTransactionSequence } from "../../src/actions/use-transaction-sequence";
import { disconnectedWallet, walletWrapper } from "../app/support";

describe("useTransactionSequence", () => {
  it("refuses to prepare a transaction when no account is connected, so nothing can reach a wallet that is not there", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(() => renderHook(() => useTransactionSequence([]), { wrapper: walletWrapper({ wallet: disconnectedWallet() }) })).toThrow(
      "A wallet account must be connected before a transaction is prepared.",
    );
  });
});

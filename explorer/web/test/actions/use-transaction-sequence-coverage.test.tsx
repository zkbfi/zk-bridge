import { renderHook, waitFor } from "@testing-library/react";
import { FIXTURE_ACCOUNT, FIXTURE_PAIR, FIXTURE_TOKENS } from "@terminal/data/fixtures";
import type { ConnectionRuntime } from "@terminal/data/connection-runtime";
import { computeBridgeDraft, DEFAULT_DELIVERY_OPTIONS } from "../../src/tx/bridge-draft";
import { buildFixtureContext } from "../helpers";
import { describe, expect, it, vi } from "vitest";
import { useTransactionSequence } from "../../src/actions/use-transaction-sequence";
import { connectedWallet, disconnectedWallet, walletWrapper } from "../app/support";

describe("useTransactionSequence", () => {
  it("refuses to prepare a transaction when no account is connected, so nothing can reach a wallet that is not there", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(() => renderHook(() => useTransactionSequence([]), { wrapper: walletWrapper({ wallet: disconnectedWallet() }) })).toThrow(
      "A wallet account must be connected before a transaction is prepared.",
    );
  });

  it("checks the deposit gate on a live page, on the flow client, with the beacon endpoints of Settings", async () => {
    const { context, tokens } = await buildFixtureContext({ allowance: 10n ** 30n });
    const draft = computeBridgeDraft(
      { token: `first:${FIXTURE_TOKENS[0]!.address}`, amount: "1", receiver: FIXTURE_ACCOUNT, mode: "plain", data: "", gasLimit: "" },
      { ...DEFAULT_DELIVERY_OPTIONS, mode: "none" },
      { pair: FIXTURE_PAIR, tokens, context, report: null, priorityFeeWei: null },
    );
    const resolved = vi.fn(() => ({ beaconUrls: {} }));
    const flowClient = vi.fn(() => ({
      getBlock: async () => {
        throw new Error("the node is down");
      },
    }));
    const services = { connection: { resolved } as unknown as ConnectionRuntime, chainAccess: { flowClient } as never };
    const { result } = renderHook(() => useTransactionSequence(draft.steps), { wrapper: walletWrapper({ wallet: connectedWallet(), services }) });
    await waitFor(() => expect(result.current.state.phase).toBe("error"));
    expect(result.current.state.error).toBe("Could not confirm the Ethereum deposit gate: the node is down.");
    expect(resolved).toHaveBeenCalled();
    expect(flowClient).toHaveBeenCalledWith(FIXTURE_PAIR.first.chainId);
  });
});

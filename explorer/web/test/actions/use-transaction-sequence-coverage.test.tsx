import { renderHook, waitFor } from "@testing-library/react";
import { FIXTURE_ACCOUNT, FIXTURE_PAIR, FIXTURE_TOKENS } from "@terminal/data/fixtures";
import type { ConnectionRuntime } from "@terminal/data/connection-runtime";
import { computeBridgeDraft, DEFAULT_DELIVERY_OPTIONS } from "../../src/tx/bridge-draft";
import { buildFixtureContext } from "../helpers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useTransactionSequence } from "../../src/actions/use-transaction-sequence";
import { connectedWallet, disconnectedWallet, walletWrapper } from "../app/support";

afterEach(() => vi.unstubAllGlobals());

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
      { token: `first:${FIXTURE_TOKENS[0]!.address}`, amount: "1", receiver: FIXTURE_ACCOUNT, mode: "plain", data: "", callGas: "", callbackGas: "" },
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
  it("refuses a send paused before a fork, before anything reaches the wallet, with the numbers of the pause", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const body = url.includes("fork_schedule")
          ? { data: [{ current_version: "0x90000069", epoch: "0" }, { current_version: "0x90000070", epoch: "50" }] }
          : url.includes("genesis")
            ? { data: { genesis_time: "1000000" } }
            : { data: { SECONDS_PER_SLOT: "12", SLOTS_PER_EPOCH: "32" } };
        return new Response(JSON.stringify(body), { status: 200 });
      }),
    );
    const { context, tokens } = await buildFixtureContext({ allowance: 10n ** 30n });
    const draft = computeBridgeDraft(
      { token: `first:${FIXTURE_TOKENS[0]!.address}`, amount: "1", receiver: FIXTURE_ACCOUNT, mode: "plain", data: "", callGas: "", callbackGas: "" },
      { ...DEFAULT_DELIVERY_OPTIONS, mode: "none" },
      { pair: FIXTURE_PAIR, tokens, context, report: null, priorityFeeWei: null },
    );
    // The light client head (slot 1000) is before the fork (slot 1600) and the clock is long after it: paused.
    const flowClient = vi.fn(() => ({ readContract: async () => 1000n }));
    const sendTransaction = vi.fn();
    const services = { connection: { resolved: () => ({ beaconUrls: {} }) } as unknown as ConnectionRuntime, chainAccess: { flowClient } as never };
    const { result } = renderHook(() => useTransactionSequence(draft.steps), { wrapper: walletWrapper({ wallet: connectedWallet({ sendTransaction }), services }) });
    await waitFor(() => expect(result.current.state.phase).toBe("error"));
    expect(result.current.state.error).toContain("Sends from Ethereum are paused");
    expect(result.current.state.error).toContain("the Altair fork (epoch 50)");
    expect(sendTransaction).not.toHaveBeenCalled();
  });
});

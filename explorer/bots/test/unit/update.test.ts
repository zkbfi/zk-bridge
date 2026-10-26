import { encodeFunctionData } from "viem";
import { beaconLightClientAbi } from "@zk-bridge/shared";
import { describe, expect, it } from "vitest";
import { sendTerms } from "../../src/chain/transactions.ts";
import { postUpdate } from "../../src/runner/update.ts";
import { LIGHT_CLIENT, fakeChain, proofMessage, word } from "../support/builders.ts";

describe("posting update to the light client", () => {
  const message = proofMessage({ startSlot: 100n, newSlot: 164n });
  const expectedData = encodeFunctionData({ abi: beaconLightClientAbi, functionName: "update", args: [message.proof, message.publicValues] });

  it("simulates the exact call, then sends it under the terms of the simulated gas, and reports the receipt", async () => {
    const chain = fakeChain();
    chain.gas = 250_000n;
    chain.gasUsed = 200_000n;
    const outcome = await postUpdate({ chain, lightClient: LIGHT_CLIENT, message });
    expect(outcome).toEqual({ posted: true, transactionHash: word(0xee), gasUsed: 200_000n, effectiveGasPrice: 10n });
    expect(chain.log).toEqual([
      { kind: "simulate", request: { to: LIGHT_CLIENT, data: expectedData } },
      { kind: "send", request: { to: LIGHT_CLIENT, data: expectedData } },
    ]);
    expect(chain.sentTerms).toEqual([sendTerms({ baseFee: 10n, priorityFee: 0n }, 250_000n)]);
  });

  it("sends nothing when the simulation reverts, and gives the reason", async () => {
    const chain = fakeChain();
    chain.simulateOverride = () => ({ ok: false, reason: "HeadNotAdvancing" });
    expect(await postUpdate({ chain, lightClient: LIGHT_CLIENT, message })).toEqual({ posted: false, reason: "simulation-reverted", detail: "HeadNotAdvancing" });
    expect(chain.log.map((entry) => entry.kind)).toEqual(["simulate"]);
  });

  it("reports the hash when the mined transaction reverts", async () => {
    const chain = fakeChain();
    chain.receiptSuccess = false;
    expect(await postUpdate({ chain, lightClient: LIGHT_CLIENT, message })).toEqual({ posted: false, reason: "transaction-reverted", detail: word(0xee) });
  });
});

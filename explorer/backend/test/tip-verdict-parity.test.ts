/**
 * Parity of the tip verdict: the backend values the shared fixture of `@zkb/core` (vectors/tip-verdict-vectors.json)
 * through its own path, the economics reader over its PulseChain client and the batch plan, and decides as the dapp
 * and the runner do: a paying tip (priced and above the cost, or unpriced at the automatic maximum of 1%) makes its
 * batch prove at finality; any other waits for the interval. The twins: bots/test/unit/tip-verdict-parity.test.ts and
 * web/test/bridge/tip-verdict-parity.test.ts. Owner, 2026-11-09: "yes, deliver straight away".
 */
import { describe, expect, it } from "vitest";
import { encodeAbiParameters, encodeFunctionData, type Address, type Hex } from "viem";
import { WAD, marginWadOf, tokenMediatorAbi } from "@zk-bridge/shared";
import { FIXTURE_COST, amountOf, chainsOf, directorOf, fixtureClient, tipUnitsOf, tipVectors, tokenOf, type TipCase } from "../../core/test/fixtures/pool-caller.ts";
import { planBatch, type BatchRule } from "../src/watch/batch.ts";
import { DELIVERY_GAS, createEconomicsReader } from "../src/watch/economics.ts";

const ROUTER: Address = "0x00000000000000000000000000000000000000d1";
const MESSAGE: Hex = `0x${"ab".repeat(32)}`;
const NOW = 1_000_000;

/** The mediator call of a case: its amount relayed to the router with its director. */
function messageData(entry: TipCase): Hex {
  const director = directorOf(entry);
  const words = encodeAbiParameters([{ type: "address" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }], [director.recipient, director.settings, director.limit, director.multiplier, director.callGas]);
  return encodeFunctionData({ abi: tokenMediatorAbi, functionName: "handleNativeTokensAndCall", args: [tokenOf(entry).address, ROUTER, amountOf(entry), words, 400_000n] });
}

/** What the backend makes of a case: the economics of the one waiting message, and the plan of its batch. */
async function backendOf(entry: TipCase) {
  const chains = chainsOf(entry);
  const token = tokenOf(entry);
  const read = createEconomicsReader({
    destinationChainId: chains.destinationChainId,
    deliveryRouter: ROUTER,
    wrappedNative: chains.wrappedNative,
    marginWad: marginWadOf(tipVectors.rules.backendProfitMargin),
    now: () => NOW * 1000,
    dependencies: {
      readMessageData: async () => messageData(entry),
      // A testnet pair has no PulseChain side.
      pulsechain: chains.destinationChainId === 369 ? fixtureClient({ unreachable: entry.unreachable }) : null,
      destinationBaseFee: async () => FIXTURE_COST.baseFeeWei,
    },
  });
  const economics = await read([
    { messageId: MESSAGE, destinationToken: { address: token.address, decimals: token.decimals, isBridgedCopy: token.origin !== null, homeChainId: token.origin?.chainId ?? null, homeToken: token.origin?.address ?? null } },
  ]);
  // Final now, the last proof ten minutes ago: inside the hour, so only a batch that pays proves now.
  const rule: BatchRule = { minIntervalSeconds: 3600, lookaheadSeconds: 384, marginWad: WAD };
  const plan = planBatch({ messages: [{ messageId: MESSAGE, slot: 400, finalAt: NOW - 10 }], finalizedSlot: 500, nowSeconds: NOW, rule, economics, lastProofAt: NOW - 600 });
  return { economics, plan };
}

describe("the tip verdict of the shared fixture, as the backend's batching decides it", () => {
  it("counts the fixture's delivery gas and priority fee", () => {
    expect(DELIVERY_GAS).toBe(FIXTURE_COST.gasUsed);
  });

  for (const entry of tipVectors.cases) {
    it(entry.name, async () => {
      const { economics, plan } = await backendOf(entry);
      const pays = entry.expected === "pays" || entry.expected === "unpriced-at-max";
      // A paying tip makes its batch prove at finality; any other waits for the interval.
      expect(plan).toMatchObject(pays ? { due: true, trigger: "profit" } : { due: false, startWhy: "interval" });
      if (economics.kind !== "known") throw new Error("the economics were expected to be read");
      const carriesTip = tipUnitsOf(entry) > 0n;
      expect({
        atMaximum: economics.atMaximum.has(MESSAGE),
        unpriced: economics.unpriced,
        valued: economics.feesUsd.has(MESSAGE),
      }).toEqual({
        atMaximum: entry.expected === "unpriced-at-max",
        unpriced: entry.expected === "unpriced-below-max" && carriesTip ? 1 : 0,
        valued: (entry.expected === "pays" || entry.expected === "below-cost") && carriesTip,
      });
    });
  }
});

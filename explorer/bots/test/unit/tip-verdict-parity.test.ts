/**
 * Parity of the tip verdict: the runner judges the shared fixture of `@zkb/core` (vectors/tip-verdict-vectors.json)
 * through its own path, the fee quote of the router, the price source over its PulseChain client and `judgeOffer`, and
 * reaches the verdict the dapp and the backend reach. Its twins: backend/test/tip-verdict-parity.test.ts and
 * web/test/bridge/tip-verdict-parity.test.ts. Owner, 2026-11-09: a token with no market price pays at a tip of at least
 * the frontend's automatic maximum (1% of the amount): "yes, deliver straight away".
 */
import { describe, expect, it } from "vitest";
import type { Address, Hex } from "viem";
import { expectedFee } from "@zk-bridge/shared";
import { judgeOffer, type DeliveryDependencies, type Judgement } from "../../src/runner/delivery.ts";
import { createTokenPricing, pulseChainClientOf } from "../../src/runner/pricing.ts";
import { FIXTURE_COST, amountOf, chainsOf, directorOf, fixtureClient, tipVectors, tokenOf, type TipCase } from "../../../core/test/fixtures/pool-caller.ts";
import { fakeChain, feedItem, memoryLogger } from "../support/builders.ts";

/** The verdict a judgement stands for. */
const verdictOf = (judgement: Judgement): string => {
  if (judgement.kind === "pay") return judgement.verdict;
  return ({ "loss-at-or-above-limit": "below-cost", "unpriced-tip-below-maximum": "unpriced-below-max" } as Record<string, string>)[judgement.outcome.reason] ?? judgement.outcome.reason;
};

/** Judges a case the way the runner does: the router's fee for the director, the token priced through the runner's pricing. */
async function judge(entry: TipCase): Promise<{ readonly judgement: Judgement; readonly asked: number }> {
  const chains = chainsOf(entry);
  const token = tokenOf(entry);
  const director = directorOf(entry);
  const chain = fakeChain();
  chain.quote = { baseFee: FIXTURE_COST.baseFeeWei, priorityFee: FIXTURE_COST.priorityFeeWei };
  chain.feeTokensOf = ({ value, gasUsed }) => expectedFee(director, { value, gasUsed, baseFeeWei: FIXTURE_COST.baseFeeWei, priorityFeeWei: FIXTURE_COST.priorityFeeWei }).fee;
  chain.tokenDecimals = token.decimals;
  const pulsechain = chains.destinationChainId === 369 ? fixtureClient({ unreachable: entry.unreachable }) : null;
  const listed = feedItem({ id: 1, token: token.address });
  const transfer = listed.transfer as NonNullable<typeof listed.transfer>;
  const item = {
    ...listed,
    direction: { sourceChainId: chains.sourceChainId, destinationChainId: chains.destinationChainId },
    transfer: {
      ...transfer,
      sourceToken: { ...transfer.sourceToken, chainId: chains.sourceChainId, address: token.origin?.address ?? transfer.sourceToken.address },
      destinationToken: { ...(transfer.destinationToken as NonNullable<typeof transfer.destinationToken>), chainId: chains.destinationChainId },
      sourceIsNative: token.origin !== null,
    },
  };
  const dependencies = {
    chain,
    deliveryRouter: "0x0000000000000000000000000000000000000077",
    wrappedNative: chains.wrappedNative,
    settings: { maximumLossPercent: tipVectors.rules.runnerMaximumLossPercent },
    pricing: createTokenPricing({ destinationChainId: chains.destinationChainId, wrappedNative: chains.wrappedNative, pulsechain, now: () => 0 }),
    logger: memoryLogger().logger,
  } as unknown as DeliveryDependencies;
  const judgement = await judgeOffer(dependencies, {
    item,
    offer: { kind: "offer", director, value: amountOf(entry), call: null },
    feeGasUnits: FIXTURE_COST.gasUsed,
    costGasUnits: FIXTURE_COST.gasUsed,
    quote: chain.quote,
    messageId: item.messageId as Hex,
  });
  return { judgement, asked: pulsechain?.calls.length ?? 0 };
}

describe("the tip verdict of the shared fixture, as the runner judges it", () => {
  for (const entry of tipVectors.cases) {
    it(entry.name, async () => {
      const { judgement } = await judge(entry);
      expect(verdictOf(judgement)).toBe(entry.expected);
      // Paying verdicts are delivered now; the others are left to the hourly unpaid rule.
      expect(judgement.kind).toBe(entry.expected === "pays" || entry.expected === "unpriced-at-max" ? "pay" : "skip");
    });
  }

  it("values a priced tip in wei of the destination's coin from the pools, and an unpriced one not at all", async () => {
    const [priced, , , thin] = tipVectors.cases as [TipCase, TipCase, TipCase, TipCase];
    const paid = (await judge(priced)).judgement;
    // 10 tokens at 33,333,333,333 PLS a token.
    expect(paid).toMatchObject({ kind: "pay", feeWei: 10n * BigInt(tipVectors.prices.tokenAWeiPerToken) });
    expect((await judge(thin)).judgement).toMatchObject({ kind: "pay", feeWei: null, verdict: "unpriced-at-max" });
  });

  it("reads no pool for a testnet token", async () => {
    const testnet = tipVectors.cases.find((entry) => entry.chain === "testnet") as TipCase;
    expect((await judge(testnet)).asked).toBe(0);
  });

  it("prices a testnet copy as no market without a read, and the wrapped native coin at exactly 1e18 wei a token", async () => {
    const testnet = tipVectors.cases[7] as TipCase;
    const pricing = createTokenPricing({ destinationChainId: 943, wrappedNative: chainsOf(testnet).wrappedNative, pulsechain: null, now: () => 0 });
    expect((await pricing({ address: tokenOf(testnet).address, decimals: 18, origin: tokenOf(testnet).origin })).state).toEqual({ kind: "no-market" });
    const wpls = tipVectors.pulsechain.wpls as Address;
    const wrapped = await createTokenPricing({ destinationChainId: 369, wrappedNative: wpls, pulsechain: fixtureClient(), now: () => 0 })({ address: wpls, decimals: 18, origin: null });
    expect(wrapped).toMatchObject({ state: { kind: "known" }, weiPerToken: 10n ** 18n });
  });

  it("reads prices through the pair's PulseChain side, and needs none on a testnet pair", () => {
    const client = fixtureClient();
    expect(pulseChainClientOf([{ chainId: 1, rpcUrl: "a" }, { chainId: 369, rpcUrl: "b" }], () => client)).toBe(client);
    expect(pulseChainClientOf([{ chainId: 11155111, rpcUrl: "a" }, { chainId: 943, rpcUrl: "b" }], () => client)).toBeNull();
  });

  it("uses a valuation for 30 s before it reads the pools again", async () => {
    let now = 0;
    const client = fixtureClient();
    const wpls = tipVectors.pulsechain.wpls as Address;
    const pricing = createTokenPricing({ destinationChainId: 369, wrappedNative: wpls, pulsechain: client, now: () => now });
    const token = { address: tokenOf(tipVectors.cases[0] as TipCase).address, decimals: 18, origin: null };
    const first = await pricing(token);
    const reads = client.calls.length;
    now = 29_999;
    expect(await pricing(token)).toBe(first);
    expect(client.calls.length).toBe(reads);
    now = 30_000;
    expect(await pricing(token)).toEqual(first);
    expect(client.calls.length).toBeGreaterThan(reads);
  });
});

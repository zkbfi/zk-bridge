import { encodeFunctionData, type Hex } from "viem";
import { tokenMediatorAbi } from "@zk-bridge/shared";
import { describe, expect, it } from "vitest";
import { buildFixtureFeed, FIXTURE_NOW, FIXTURE_PAIR } from "@terminal/data/fixtures";
import { createFixtureIndexerClient } from "../../src/data/fixture-indexer-client";
import type { MessageDetail } from "../../src/data/message-detail";
import { CONTRACT_NAMES, contractKeyOf, contractNameOf } from "../../src/explore/contract-names";
import type { ProofRow } from "../../src/explore/explore-source";
import { appOf, calledFunction, coveringProof, messageSteps, payloadSummary, stepCostText } from "../../src/explore/message-model";

const feed = buildFixtureFeed(FIXTURE_NOW);
const tokenItem = feed.find((item) => item.kind === "token" && item.status === "delivered" && item.direction === "first-to-second")!;
const detail = async (): Promise<MessageDetail> => (await createFixtureIndexerClient().message(tokenItem.id))!;
const RECIPIENT = "0x52908400098527886e0f7030069857d2e4169ee7" as const;

const proof = (changes: Partial<ProofRow>): ProofRow => ({
  number: 2,
  chainId: FIXTURE_PAIR.second.chainId,
  slot: 14_100_000n,
  headerRoot: `0x${"1".repeat(64)}`,
  executionBlockHash: `0x${"2".repeat(64)}`,
  executionBlockNumber: 5n,
  transactionHash: `0x${"3".repeat(64)}`,
  blockNumber: 6n,
  timestamp: 1_792_929_000,
  gasUsed: 1n,
  effectiveGasPrice: 1n,
  costWei: 1n,
  poster: RECIPIENT,
  ...changes,
});

describe("contract names", () => {
  it("names the mediator the ERC-20 mediator, never a token mediator", () => {
    expect(CONTRACT_NAMES.tokenMediator).toBe("ERC-20 mediator");
    expect(Object.values(CONTRACT_NAMES).join(" ")).not.toMatch(/token ?mediator/i);
  });

  it("finds a deployment contract by address in any letter case, and nothing for another address or chain", () => {
    expect(contractKeyOf(FIXTURE_PAIR.first, FIXTURE_PAIR.first.contracts.tokenMediator.toLowerCase())).toBe("tokenMediator");
    expect(contractKeyOf(FIXTURE_PAIR.first, RECIPIENT)).toBeNull();
    expect(contractNameOf(FIXTURE_PAIR, FIXTURE_PAIR.second.chainId, FIXTURE_PAIR.second.contracts.gate!)).toBe("Gate");
    expect(contractNameOf(FIXTURE_PAIR, 56, FIXTURE_PAIR.second.contracts.gate!)).toBeNull();
  });

  it("leads an app of the deployment to its contract page and any other address to its address page", () => {
    expect(appOf(FIXTURE_PAIR, 1, FIXTURE_PAIR.first.contracts.tokenMediator)).toEqual({ name: "ERC-20 mediator", address: FIXTURE_PAIR.first.contracts.tokenMediator, href: `#/explore/contract/1/${FIXTURE_PAIR.first.contracts.tokenMediator}` });
    expect(appOf(FIXTURE_PAIR, 1, RECIPIENT)).toEqual({ name: null, address: RECIPIENT, href: `#/explore/address/${RECIPIENT}` });
  });
});

describe("the payload", () => {
  const call = (functionName: "handleNativeTokens" | "handleBridgedTokensAndCall" | "deployAndHandleBridgedTokens"): Hex => {
    if (functionName === "handleNativeTokens") return encodeFunctionData({ abi: tokenMediatorAbi, functionName, args: [RECIPIENT, RECIPIENT, 5_000_000n] });
    if (functionName === "handleBridgedTokensAndCall") return encodeFunctionData({ abi: tokenMediatorAbi, functionName, args: [RECIPIENT, RECIPIENT, 5_000_000n, "0xab", 300_000n] });
    return encodeFunctionData({ abi: tokenMediatorAbi, functionName, args: [RECIPIENT, "Token", "TOK", 6, RECIPIENT, 5_000_000n] });
  };

  it("says what a mediator call asks, in the destination token", async () => {
    const transfer = (await detail()).transfer;
    expect(payloadSummary({ data: call("handleNativeTokens"), transfer })).toBe("release 5 USDC to 0x52908400…9ee7");
    expect(payloadSummary({ data: call("handleBridgedTokensAndCall"), transfer })).toBe("mint 5 USDC to 0x52908400…9ee7 and call it");
    expect(payloadSummary({ data: call("deployAndHandleBridgedTokens"), transfer })).toBe("deploy the copy and mint 5 USDC to 0x52908400…9ee7");
    expect(payloadSummary({ data: call("handleNativeTokens"), transfer: null })).toBe("release 5000000 base units to 0x52908400…9ee7");
  });

  it("says nothing for no payload or one that is not a mediator call", () => {
    expect(payloadSummary({ data: null, transfer: null })).toBeNull();
    expect(payloadSummary({ data: "0x12345678", transfer: null })).toBeNull();
  });

  it("names the called function by signature or selector, and nothing without one", () => {
    expect(calledFunction(call("handleNativeTokens"))).toEqual({ text: "handleNativeTokens(address token, address recipient, uint256 value)", known: true });
    expect(calledFunction("0x12345678ab")).toEqual({ text: "0x12345678", known: false });
    expect(calledFunction("0x1234")).toBeNull();
    expect(calledFunction(null)).toBeNull();
  });
});

describe("the steps", () => {
  it("finds the proof posted to the destination at the covering slot", () => {
    const covered = { destinationChainId: FIXTURE_PAIR.second.chainId, coveredByHeadSlot: 14_100_000 };
    expect(coveringProof(covered, [proof({ chainId: 1 }), proof({ slot: 1n }), proof({})])?.number).toBe(2);
    expect(coveringProof({ ...covered, coveredByHeadSlot: null }, [proof({})])).toBeNull();
    expect(coveringProof(covered, [])).toBeNull();
  });

  it("goes sent, block final, proof posted (by number when known), delivered", async () => {
    const steps = messageSteps(await detail(), FIXTURE_PAIR, [proof({})]);
    expect(steps.map((step) => step.label)).toEqual(["Sent on Ethereum", "Block final on Ethereum", "Proof #2 posted to PulseChain", "Delivered on PulseChain"]);
    expect(steps.every((step) => step.done)).toBe(true);
    expect(steps[2]).toMatchObject({ at: 1_792_929_000, href: `#/explore/proof/${FIXTURE_PAIR.second.chainId}/2` });
    expect(steps[1]!.detail).toMatchObject({ kind: "block", hash: null, slot: null });
    expect(steps[3]!.tone).toBeUndefined();
  });

  it("stops a failed release at the delivery with the error tone, names a failed callback without stopping, and leaves undelivered steps open", async () => {
    const base = await detail();
    const failed = messageSteps({ ...base, releaseFailed: true }, FIXTURE_PAIR, []);
    expect(failed[3]).toMatchObject({ label: "Release failed on PulseChain", done: false, tone: "error", detail: { kind: "delivery", reverted: true } });
    const callback = messageSteps({ ...base, callbackFailed: true }, FIXTURE_PAIR, []);
    expect(callback[3]).toMatchObject({ label: "Delivered on PulseChain, the call after it failed", done: true });
    expect(callback[3]!.tone).toBeUndefined();
    const pending = messageSteps({ ...base, coveredByHeadSlot: null, coveredAt: null, deliveredAt: null }, FIXTURE_PAIR, []);
    expect(pending.map((step) => step.done)).toEqual([true, false, false, false]);
    expect(pending[3]!.detail).toBeUndefined();
  });
});

describe("a step's cost", () => {
  const cost = (changes: Record<string, unknown> = {}) => ({ chainId: 1, hash: `0x${"ab".repeat(32)}` as const, block: "12", gasUsed: "120000", effectiveGasPriceWei: "7000000000", costWei: "840000000000000", costUsd: "2520000000000000000", nativeUsd: { usd: "3000000000000000000000", source: "pulsex-weth-copy" as const, priceBlock: "90" }, ...changes });
  it("is the native coin and its dollars at the price block", () => {
    expect(stepCostText(cost(), FIXTURE_PAIR)).toBe("0.0₃84 ETH · $2.52");
  });
  it("says a proof's cost is shared, with how many transfers it covered", () => {
    expect(stepCostText({ ...cost({ chainId: 369, costWei: "2000000000000000000", costUsd: "60000000000000" }), coveredMessages: 4 }, FIXTURE_PAIR)).toBe("shared · 2 PLS · $0.0₄6 over 4 transfers");
    expect(stepCostText({ ...cost(), coveredMessages: 1 }, FIXTURE_PAIR)).toBe("shared · 0.0₃84 ETH · $2.52 over 1 transfer");
  });
  it("keeps the leading-zeros rule for a tiny cost, never an exponent", () => {
    expect(stepCostText(cost({ costWei: "315000000000" }), FIXTURE_PAIR)).toBe("0.0₆315 ETH · $2.52");
    expect(stepCostText(cost({ costWei: "315999999999" }), FIXTURE_PAIR)).toBe("0.0₆315 ETH · $2.52");
    expect(stepCostText(cost({ costWei: "1" }), FIXTURE_PAIR)).toBe("0.0₁₇1 ETH · $2.52");
  });
  it("shows — for the dollars on a testnet, and nothing without a cost", () => {
    expect(stepCostText(cost({ chainId: 11155111, costUsd: null, nativeUsd: null }), FIXTURE_PAIR)).toBe("0.0₃84 · —");
    expect(stepCostText(cost({ costUsd: "0" }), FIXTURE_PAIR)).toBe("0.0₃84 ETH · $0");
    expect(stepCostText(null, FIXTURE_PAIR)).toBeNull();
  });
});

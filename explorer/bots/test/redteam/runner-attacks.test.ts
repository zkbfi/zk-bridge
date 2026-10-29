/**
 * Red team, 2026-10-29: attacks on the delivery runner and its proof intake. Report only: no production code changes.
 * "ATTACK" tests assert a refusal; "ATTACK SUCCEEDS" tests assert that the attack works today.
 */
import { decodeFunctionData, toHex, type Hex } from "viem";
import { encodeProofMessage, messageBridgeAbi, ORACLE_PROOF_MESSAGE_VERSION } from "@zk-bridge/shared";
import { assessProofPayload } from "@zk-bridge/shared/prover";
import { describe, expect, it } from "vitest";
import { sendBatch } from "../../src/runner/batch.ts";
import { prepareItem, quoteFee, type DeliveryDependencies, type ReadyDelivery } from "../../src/runner/delivery.ts";
import { decideDelivery, valueFeeInWei } from "../../src/runner/fee.ts";
import type { PrerequisiteLedger } from "../../src/runner/prerequisite-ledger.ts";
import {
  DELIVERY_ROUTER,
  FEED_REQUIRED_GAS,
  MULTICALL,
  REWARD_ADDRESS,
  TEST_PROOF_CHECK_GAS,
  WRAPPED_NATIVE,
  address,
  affirmationLog,
  emptyExecuteMessage,
  evidenceFor,
  fakeChain,
  fakeIndexer,
  fakeLightClient,
  fakeProver,
  feeOfferData,
  feedItem,
  memoryLogger,
  proofMessage,
  proofPayload,
  word,
} from "../support/builders.ts";

const DIRECTOR = { recipient: REWARD_ADDRESS, settings: 1n, limit: 10n ** 18n, multiplier: 0n };

function ledger(): PrerequisiteLedger & { losses: bigint[] } {
  const losses: bigint[] = [];
  return {
    losses,
    capWei: 10n ** 18n,
    spentWei: 0n,
    refusal: async () => null,
    reserve: async (wei: bigint) => ({ ok: true, reservation: { id: "r", wei } }) as never,
    settle: async () => {},
    recordLoss: async (wei: bigint) => {
      losses.push(wei);
    },
    reserveDelivery: async (wei: bigint) => ({ id: "d", wei }),
    settleDelivery: async () => {},
    deliverySpendWei: async () => 0n,
  } as never;
}

function dependencies(overrides: Partial<DeliveryDependencies> = {}): DeliveryDependencies & { chain: ReturnType<typeof fakeChain> } {
  const chain = fakeChain();
  chain.feeTokens = 10n ** 17n;
  return {
    direction: "first-to-second",
    chain,
    prover: fakeProver(),
    indexer: fakeIndexer([], {}),
    source: { findMessageLogIndex: async () => 0 },
    deliveryRouter: DELIVERY_ROUTER,
    multicall: MULTICALL,
    rewardAddress: REWARD_ADDRESS,
    wrappedNative: WRAPPED_NATIVE,
    tokenFactory: null,
    settings: {
      maximumLossPercent: 20,
      deliverWithoutOffer: false,
      tokenValuationsWei: {},
      proofCheckGas: TEST_PROOF_CHECK_GAS,
      maximumPrerequisiteRounds: 3,
      prerequisiteGasFallback: 300_000n,
      maximumPrerequisiteSpendPerSweepWei: 10n ** 18n,
      maximumPrerequisiteSpendPerDayWei: 10n ** 18n,
      maximumUnrecoveredPrerequisiteLossWei: 10n ** 18n,
      maximumBatchSize: 5,
      maximumBatchGas: 6_000_000n,
    },
    logger: memoryLogger().logger,
    ...overrides,
  } as DeliveryDependencies & { chain: ReturnType<typeof fakeChain> };
}

describe("red team: proof intake of the runner (malicious msgboard content)", () => {
  const assess = (payload: Hex, options: { acceptOracleProof?: boolean; verify?: () => void; pairName?: string; direction?: "first-to-second" | "second-to-first" } = {}) => {
    const prover = fakeProver({ verify: options.verify });
    return {
      prover,
      result: assessProofPayload({
        payload,
        pairName: options.pairName ?? "eth-pls",
        direction: options.direction ?? "first-to-second",
        lightClient: fakeLightClient(),
        prover,
        acceptOracleProof: options.acceptOracleProof,
      }),
    };
  };

  it("ATTACK oracle-form proof message on a strict runner is refused before any read", async () => {
    const message = { ...proofMessage(), version: ORACLE_PROOF_MESSAGE_VERSION, proof: `0x${"11".repeat(65)}` as Hex } as const;
    const payload = encodeProofMessage(message as never, { acceptOracleProof: true });
    const { result, prover } = assess(payload);
    expect(await result).toEqual({ accept: false, reason: "oracle-proof-not-accepted" });
    expect(prover.verifications).toBe(0);
  });

  it("ATTACK oracle form with a truthy non-boolean option (\"yes\" from a loose config) is still refused", async () => {
    const message = { ...proofMessage(), version: ORACLE_PROOF_MESSAGE_VERSION, proof: `0x${"11".repeat(65)}` as Hex } as const;
    const payload = encodeProofMessage(message as never, { acceptOracleProof: true });
    const { result } = assess(payload, { acceptOracleProof: "yes" as never });
    expect((await result).accept).toBe(false);
  });

  it("ATTACK proof of another direction posted under this category is refused", async () => {
    const { result } = assess(proofPayload({ direction: "second-to-first" }));
    expect(await result).toMatchObject({ accept: false, reason: "wrong-direction" });
  });

  it("ATTACK proof of another pair (sepolia-pls943) is refused", async () => {
    const { result } = assess(proofPayload(), { pairName: "sepolia-pls943" });
    expect(await result).toMatchObject({ accept: false, reason: "wrong-pair" });
  });

  it("ATTACK garbage, truncated, oversized and trailing-byte payloads are refused as undecodable", async () => {
    const good = proofPayload();
    for (const payload of ["0x", "0xzz", `${good}00`, good.slice(0, -2), `0x${"ff".repeat(100_000)}`] as Hex[]) {
      const { result, prover } = assess(payload);
      expect((await result).accept).toBe(false);
      expect(prover.verifications).toBe(0);
    }
  });

  it("ATTACK header slots that disagree with the public values are refused", async () => {
    const good = proofPayload();
    // Byte 75..82 is the new slot of the header. Change it so it no longer matches the public values.
    const bytes = good.slice(2);
    const tampered = `0x${bytes.slice(0, 150)}${toHex(999n, { size: 8 }).slice(2)}${bytes.slice(166)}` as Hex;
    const { result } = assess(tampered);
    expect(await result).toMatchObject({ accept: false, reason: "undecodable", detail: "inconsistent-public-values" });
  });

  it("ATTACK stale proof (new slot at or below the head) is refused before the prover runs", async () => {
    const prover = fakeProver();
    const result = await assessProofPayload({ payload: proofPayload({ startSlot: 36n, newSlot: 100n }), pairName: "eth-pls", direction: "first-to-second", lightClient: fakeLightClient(), prover });
    expect(result).toMatchObject({ accept: false, reason: "already-stored" });
    expect(prover.verifications).toBe(0);
  });

  it("ATTACK proof for another program key is refused", async () => {
    const { result } = assess(proofPayload({ programKey: `0x${"de".repeat(32)}` as Hex }));
    expect(await result).toMatchObject({ accept: false, reason: "program-key-mismatch" });
  });

  it("ATTACK forged Groth16 proof with the right head is refused by the local verify (no gas spent)", async () => {
    const { result } = assess(proofPayload(), {
      verify: () => {
        throw new Error("invalid proof");
      },
    });
    expect(await result).toMatchObject({ accept: false, reason: "proof-does-not-verify" });
  });

  it("ATTACK SUCCEEDS forged-proof flood: every distinct forgery that names the current head spawns one local verify", async () => {
    // The head (slot, root, program key) is public. Each byte change of the proof gives a new payload key, so the
    // runner's five-minute memory does not help: N forgeries cost N prover processes. msgboard proof-of-work is the only brake.
    let verifications = 0;
    for (let index = 0; index < 50; index += 1) {
      const prover = fakeProver({
        verify: () => {
          throw new Error("invalid proof");
        },
      });
      await assessProofPayload({ payload: proofPayload({ proofByte: index.toString(16).padStart(2, "0") }), pairName: "eth-pls", direction: "first-to-second", lightClient: fakeLightClient(), prover });
      verifications += prover.verifications;
    }
    expect(verifications).toBe(50);
  });
});

describe("red team: delivery decisions of the runner", () => {
  it("ATTACK lying indexer: a fee offer that is not in the proven message is skipped before any gas is spent (BLOCKED, was B-1)", async () => {
    // The indexer says message 1 relays tokens to the router with a large tip. The evidence that the prover builds from
    // the source chain carries the real message, whose data is empty (no tip).
    const item = feedItem({ id: 1, token: WRAPPED_NATIVE });
    const lie = feeOfferData({ director: DIRECTOR, value: 10n ** 18n, token: WRAPPED_NATIVE });
    const evidence = { ...evidenceFor(), message: { ...evidenceFor().message, gasLimit: Number(item.gasLimit) } };
    const deps = dependencies({ indexer: fakeIndexer([item], { [item.messageId]: lie }), prover: fakeProver({ evidence: () => evidence }) });
    const preparation = await prepareItem(deps, item, ledger());
    expect(evidence.message.data).toBe("0x");
    expect(preparation).toMatchObject({ kind: "outcome", outcome: { status: "skipped", reason: "indexer-disagrees-with-evidence" } });
    expect(deps.chain.log.filter((entry) => entry.kind === "send")).toHaveLength(0);
  });

  it("ATTACK lying indexer: a gas limit that is not the proven one is skipped (BLOCKED, was B-1)", async () => {
    const item = feedItem({ id: 1, token: WRAPPED_NATIVE });
    const offer = feeOfferData({ director: DIRECTOR, value: 10n ** 18n, token: WRAPPED_NATIVE });
    const evidence = { ...evidenceFor(), message: { ...evidenceFor().message, data: offer, gasLimit: Number(item.gasLimit) + 1 } };
    const deps = dependencies({ indexer: fakeIndexer([item], { [item.messageId]: offer }), prover: fakeProver({ evidence: () => evidence }) });
    const preparation = await prepareItem(deps, item, ledger());
    expect(preparation).toMatchObject({ kind: "outcome", outcome: { status: "skipped", reason: "indexer-disagrees-with-evidence" } });
  });

  it("ATTACK lying indexer: a valued destination token that the message does not release is skipped before pricing (BLOCKED, follow-up of B-1)", async () => {
    // The message releases a worthless token native on the destination; the indexer names a token with a valuation.
    const valued = address(0x66);
    const item = feedItem({ id: 1, token: valued });
    const data = feeOfferData({ director: DIRECTOR, value: 10n ** 18n, token: address(0x44) });
    const evidence = { ...evidenceFor(), message: { ...evidenceFor().message, data, gasLimit: Number(item.gasLimit) } };
    const deps = dependencies({
      indexer: fakeIndexer([item], { [item.messageId]: data }),
      prover: fakeProver({ evidence: () => evidence }),
      settings: { ...dependencies().settings, tokenValuationsWei: { [valued.toLowerCase()]: 10n ** 30n } },
    });
    const preparation = await prepareItem(deps, item, ledger());
    expect(preparation).toMatchObject({ kind: "outcome", outcome: { status: "skipped", reason: "indexer-disagrees-with-evidence" } });
    expect(deps.chain.log).toEqual([]);
  });

  it("ATTACK lying indexer: a bridged message priced in another token than the copy that the factory names is skipped (BLOCKED, follow-up of B-1)", async () => {
    const valued = address(0x66);
    const copy = address(0x45);
    const data = feeOfferData({ director: DIRECTOR, value: 10n ** 18n, token: address(0x55), handler: "bridged" });
    const run = async (token: typeof valued) => {
      const item = feedItem({ id: 1, token });
      const evidence = { ...evidenceFor(), message: { ...evidenceFor().message, data, gasLimit: Number(item.gasLimit) } };
      const deps = dependencies({
        indexer: fakeIndexer([item], { [item.messageId]: data }),
        prover: fakeProver({ evidence: () => evidence }),
        tokenFactory: address(0xfa),
        settings: { ...dependencies().settings, tokenValuationsWei: { [valued.toLowerCase()]: 10n ** 18n, [copy.toLowerCase()]: 10n ** 18n } },
      });
      deps.chain.predictedCopy = copy;
      return prepareItem(deps, item, ledger());
    };
    expect(await run(valued)).toMatchObject({ kind: "outcome", outcome: { status: "skipped", reason: "indexer-disagrees-with-evidence" } });
    // Control: the copy that the factory names is priced as usual.
    expect((await run(copy)).kind).toBe("ready");
  });

  it("ATTACK evidence for another message is skipped before any gas is spent (BLOCKED, was B-2)", async () => {
    const item = feedItem({ id: 7, token: WRAPPED_NATIVE });
    const offer = feeOfferData({ director: DIRECTOR, value: 10n ** 18n, token: WRAPPED_NATIVE });
    const evidence = { ...evidenceFor(), message: { ...evidenceFor().message, data: offer, gasLimit: Number(item.gasLimit) } }; // names message word(1), not word(7)
    const deps = dependencies({ indexer: fakeIndexer([item], { [item.messageId]: offer }), prover: fakeProver({ evidence: () => evidence }) });
    const preparation = await prepareItem(deps, item, ledger());
    expect(evidence.message.messageId).not.toBe(item.messageId);
    expect(preparation).toMatchObject({ kind: "outcome", outcome: { status: "skipped", reason: "evidence-for-another-message" } });
    expect(deps.chain.log.filter((entry) => entry.kind === "send")).toHaveLength(0);
  });

  it("ATTACK already-delivered evidence is skipped before any gas is spent", async () => {
    const item = feedItem({ id: 1, token: WRAPPED_NATIVE });
    const offer = feeOfferData({ director: DIRECTOR, value: 10n ** 18n, token: WRAPPED_NATIVE });
    const deps = dependencies({ indexer: fakeIndexer([item], { [item.messageId]: offer }), prover: fakeProver({ evidence: () => evidenceFor({ alreadyDelivered: true }) }) });
    const preparation = await prepareItem(deps, item, ledger());
    expect(preparation).toMatchObject({ kind: "outcome", outcome: { status: "skipped", reason: "already-delivered" } });
    expect(deps.chain.log.filter((entry) => entry.kind === "send")).toHaveLength(0);
  });

  it("ATTACK proof that would revert is dropped in simulation, nothing is sent", async () => {
    const deps = dependencies();
    deps.chain.batchResult = () => ({ success: false, returnData: "0x" });
    const decoded = decodeFunctionData({ abi: messageBridgeAbi, data: emptyExecuteMessage(1n) });
    if (decoded.functionName !== "executeMessage") throw new Error("unreachable");
    const ready: ReadyDelivery = {
      item: feedItem({ id: 1, token: WRAPPED_NATIVE }),
      messageId: word(1),
      offer: { kind: "offer", director: DIRECTOR, value: 1000n, call: null },
      proof: decoded.args[0],
      requiredGas: FEED_REQUIRED_GAS,
      assumedGas: 300_000n,
      prerequisiteCostWei: 0n,
    };
    const report = await sendBatch(deps, ledger(), { readies: [ready], update: null });
    expect(report.outcomes[0]).toMatchObject({ status: "skipped", reason: "simulation-reverted" });
    expect(deps.chain.log.filter((entry) => entry.kind === "send")).toHaveLength(0);
  });

  it("ATTACK SUCCEEDS forged AffirmationCompleted from a target contract marks a failed item as delivered", async () => {
    // Item 2 fails in the mined block (it simulated fine: a race). Item 1's target, an attacker contract, emits an
    // event with the AffirmationCompleted signature naming message 2. readReceipt does not check the log address,
    // so the runner records message 2 as delivered and the runner writes it to `finished`: never tried again.
    const deps = dependencies();
    deps.chain.feeTokens = 10n ** 17n;
    deps.chain.receiptResult = (position) => (position === 1 ? { success: false, returnData: "0x" } : { success: true, returnData: "0x" });
    deps.chain.receiptLogsOfItem = (position) => (position === 0 ? [{ ...affirmationLog(word(2)), address: address(0xbad) }] : []);
    const readies = [1, 2].map((id): ReadyDelivery => {
      const decoded = decodeFunctionData({ abi: messageBridgeAbi, data: emptyExecuteMessage(BigInt(id)) });
      if (decoded.functionName !== "executeMessage") throw new Error("unreachable");
      return {
        item: feedItem({ id, token: WRAPPED_NATIVE }),
        messageId: word(id),
        offer: { kind: "offer", director: DIRECTOR, value: 1000n, call: null },
        proof: decoded.args[0],
        requiredGas: FEED_REQUIRED_GAS,
        assumedGas: 300_000n,
        prerequisiteCostWei: 0n,
      };
    });
    const report = await sendBatch(deps, ledger(), { readies, update: null });
    expect(report.outcomes[1]).toMatchObject({ status: "delivered", messageId: word(2) });
  });
});

describe("red team: tip accounting", () => {
  it("ATTACK zero-cost or negative-cost inputs do not flip the decision into paying for a loss", () => {
    expect(decideDelivery({ feeWei: 0n, costWei: 1n, maximumLossPercent: 20 }).deliver).toBe(false);
    expect(decideDelivery({ feeWei: 0n, costWei: 1n, maximumLossPercent: 100 }).deliver).toBe(false); // a full loss is refused even at 100 percent
    expect(decideDelivery({ feeWei: 10n ** 30n, costWei: 10n ** 30n + 1n, maximumLossPercent: 0 }).deliver).toBe(false);
  });

  it("ATTACK a fee token without a valuation, or with a zero/negative valuation, is never priced", () => {
    const base = { fee: 10n ** 30n, token: address(0x66), decimals: 18, director: DIRECTOR, wrappedNative: WRAPPED_NATIVE };
    expect(valueFeeInWei({ ...base, valuationsWei: {} }).ok).toBe(false);
    expect(valueFeeInWei({ ...base, valuationsWei: { [address(0x66).toLowerCase()]: 0n } }).ok).toBe(false);
    expect(valueFeeInWei({ ...base, valuationsWei: { [address(0x66).toLowerCase()]: -5n } }).ok).toBe(false);
  });

  it("ATTACK lying indexer decimals: the runner values the tip with the decimals that the token reports on chain (BLOCKED, was B-1)", async () => {
    // The feed item claims 0 decimals for an 18-decimal token. A lie of 0 would multiply the value by 10^18.
    const token = address(0x66);
    const deps = dependencies({ settings: { ...dependencies().settings, tokenValuationsWei: { [token.toLowerCase()]: 10n ** 18n } } });
    deps.chain.feeTokens = 10n ** 17n;
    const item = feedItem({ id: 1, token, decimals: 0 });
    const quoted = await quoteFee(deps, item, { kind: "offer", director: DIRECTOR, value: 1000n, call: null }, 300_000n, 300_000n);
    expect(quoted).toMatchObject({ ok: true, feeWei: 10n ** 17n });
    // valueFeeInWei itself trusts the decimals that it is given.
    expect(valueFeeInWei({ fee: 1n, token, director: DIRECTOR, wrappedNative: WRAPPED_NATIVE, valuationsWei: { [token.toLowerCase()]: 10n ** 18n }, decimals: 0 })).toEqual({ ok: true, wei: 10n ** 18n });
  });
});

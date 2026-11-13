import { describe, expect, it } from "vitest";
import { encodeAbiParameters, encodeFunctionData, type Address, type Hex } from "viem";
import { PROOF_COST_USD, PULSEX_FACTORIES, STABLES, USD, WAD, WPLS, tokenMediatorAbi, batchCostUsd, marginWadOf } from "@zk-bridge/shared";
import { makeConfig } from "./support.ts";
import { batchRuleFor, deprecatedBatchKeys, planBatch, usdText, type BatchMessage, type BatchRule, type Economics } from "../src/watch/batch.ts";
import { createEconomicsReader, type DestinationToken } from "../src/watch/economics.ts";

/** The gas of one delivery that these tests count at. */
const DELIVERY_GAS = 500_000n;
const RULE: BatchRule = { minIntervalSeconds: 3600, lookaheadSeconds: 384, marginWad: WAD, unpricedAtMaximumPays: true };
const NOW = 1_000_000;
const FINALIZED = 500;
/** The direction's last proof started ten minutes ago: well inside the hour. */
const RECENT = NOW - 600;
const msg = (messageId: string, slot: number, finalAt: number): BatchMessage => ({ messageId, slot, finalAt });
const known = (fees: Record<string, bigint>, deliveryUsd = 0n): Economics => ({ kind: "known", feesUsd: new Map(Object.entries(fees)), deliveryUsd, unpriced: 0, atMaximum: new Set(), why: null, block: "1" });
const cents = (value: number) => (BigInt(value) * USD) / 100n;

describe("batchRuleFor", () => {
  it("takes a direction's field over its pair's, and the pair's over the global one", () => {
    const watch = makeConfig({
      watch: { minIntervalSeconds: 60, profitMargin: 1.5, pairs: { "sepolia-pls943": { minIntervalSeconds: 3600, lookaheadSeconds: 100, directions: { "first-to-second": { minIntervalSeconds: 1800 } } } } },
    }).watch;
    expect(batchRuleFor(watch, "sepolia-pls943", "first-to-second", 384)).toEqual({ minIntervalSeconds: 1800, lookaheadSeconds: 100, marginWad: (WAD * 3n) / 2n, unpricedAtMaximumPays: true });
    expect(batchRuleFor(watch, "sepolia-pls943", "second-to-first", 320)).toEqual({ minIntervalSeconds: 3600, lookaheadSeconds: 100, marginWad: (WAD * 3n) / 2n, unpricedAtMaximumPays: true });
    expect(batchRuleFor(watch, "eth-pls", "first-to-second", 384)).toEqual({ minIntervalSeconds: 60, lookaheadSeconds: 384, marginWad: (WAD * 3n) / 2n, unpricedAtMaximumPays: true });
    // A direction's 0 beats its pair's hour: no minimum.
    const zero = makeConfig({ watch: { pairs: { "sepolia-pls943": { minIntervalSeconds: 3600, directions: { "second-to-first": { minIntervalSeconds: 0 } } } } } }).watch;
    expect(batchRuleFor(zero, "sepolia-pls943", "second-to-first", 320).minIntervalSeconds).toBe(0);
  });

  it("reads the deprecated maxWaitSeconds as minIntervalSeconds, level by level, and names where it is used", () => {
    // The server's backend.json of 2026-11-01.
    const server = makeConfig({ watch: { pairs: { "sepolia-pls943": { maxWaitSeconds: 3600 } } } }).watch;
    expect(batchRuleFor(server, "sepolia-pls943", "first-to-second", 384).minIntervalSeconds).toBe(3600);
    expect(deprecatedBatchKeys(server)).toEqual(["watch.pairs.sepolia-pls943.maxWaitSeconds"]);
    const mixed = makeConfig({
      watch: { maxWaitSeconds: 60, pairs: { "sepolia-pls943": { minIntervalSeconds: 900, maxWaitSeconds: 7200, directions: { "first-to-second": { maxWaitSeconds: 1800 }, "second-to-first": { lookaheadSeconds: 5 } } } } },
    }).watch;
    // On one level the new name wins; a deeper level wins whatever its name.
    expect(batchRuleFor(mixed, "sepolia-pls943", "second-to-first", 384).minIntervalSeconds).toBe(900);
    expect(batchRuleFor(mixed, "sepolia-pls943", "first-to-second", 384).minIntervalSeconds).toBe(1800);
    expect(batchRuleFor(mixed, "eth-pls", "first-to-second", 384).minIntervalSeconds).toBe(60);
    expect(deprecatedBatchKeys(mixed)).toEqual(["watch.maxWaitSeconds", "watch.pairs.sepolia-pls943.maxWaitSeconds", "watch.pairs.sepolia-pls943.directions.first-to-second.maxWaitSeconds"]);
    expect(deprecatedBatchKeys(makeConfig({ watch: { minIntervalSeconds: 5 } }).watch)).toEqual([]);
  });

  it("defaults to no minimum interval, one epoch of lookahead and a margin of 1", () => {
    expect(batchRuleFor(makeConfig().watch, "eth-pls", "first-to-second", 320)).toEqual({ minIntervalSeconds: 0, lookaheadSeconds: 320, marginWad: WAD, unpricedAtMaximumPays: true });
    expect(marginWadOf(1.25)).toBe((WAD * 5n) / 4n);
  });

  it("resolves unpricedAtMaximumPays like the interval: the direction's own, else its pair's, else the global one, else true", () => {
    const watch = makeConfig({
      watch: { unpricedAtMaximumPays: false, pairs: { "sepolia-pls943": { unpricedAtMaximumPays: true, directions: { "second-to-first": { unpricedAtMaximumPays: false } } }, "eth-pls": {} } },
    }).watch;
    expect(batchRuleFor(watch, "sepolia-pls943", "first-to-second", 384).unpricedAtMaximumPays).toBe(true);
    expect(batchRuleFor(watch, "sepolia-pls943", "second-to-first", 320).unpricedAtMaximumPays).toBe(false);
    expect(batchRuleFor(watch, "eth-pls", "first-to-second", 384).unpricedAtMaximumPays).toBe(false);
    const testnetOnly = makeConfig({ watch: { pairs: { "sepolia-pls943": { unpricedAtMaximumPays: false } } } }).watch;
    expect(batchRuleFor(testnetOnly, "sepolia-pls943", "first-to-second", 384).unpricedAtMaximumPays).toBe(false);
    expect(batchRuleFor(testnetOnly, "eth-pls", "first-to-second", 384).unpricedAtMaximumPays).toBe(true);
    expect(() => makeConfig({ watch: { unpricedAtMaximumPays: "no" } })).toThrow(/unpricedAtMaximumPays/);
  });

  it("refuses an unknown pair or direction and a negative interval", () => {
    expect(() => makeConfig({ watch: { pairs: { "nowhere-pair": { minIntervalSeconds: 1 } } } })).toThrow(/watch\.pairs/);
    expect(() => makeConfig({ watch: { pairs: { "eth-pls": { directions: { sideways: { minIntervalSeconds: 1 } } } } } })).toThrow(/watch\.pairs\.eth-pls\.directions/);
    expect(() => makeConfig({ watch: { minIntervalSeconds: -1 } })).toThrow(/watch\.minIntervalSeconds/);
    expect(() => makeConfig({ watch: { maxWaitSeconds: -1 } })).toThrow(/watch\.maxWaitSeconds/);
    expect(() => makeConfig({ watch: { pairs: { "eth-pls": { directions: { "first-to-second": { lookaheadSeconds: -5 } } } } } })).toThrow(/lookaheadSeconds/);
    expect(() => makeConfig({ watch: { profitMargin: 0 } })).toThrow(/profitMargin/);
    expect(() => makeConfig({ watch: { pairs: { "eth-pls": { other: 1 } } } })).toThrow(/watch\.pairs\.eth-pls/);
  });
});

describe("the cost of a batch", () => {
  it("is the proof plus a delivery per message, times the margin, rounded up", () => {
    expect(batchCostUsd(0, 0n, WAD)).toBe(PROOF_COST_USD);
    expect(batchCostUsd(2, cents(1), WAD)).toBe(PROOF_COST_USD + cents(2));
    expect(batchCostUsd(1, 1n, WAD / 3n)).toBe(((PROOF_COST_USD + 1n) * (WAD / 3n) + WAD - 1n) / WAD);
    expect(usdText(PROOF_COST_USD)).toBe("0.025000");
    expect(usdText(12n * USD + 1n)).toBe("12.000000");
  });
});

describe("planBatch: is there a bridge? is it profitable? has it been an hour since the last proof?", () => {
  it("is null when nothing waits, however long ago the last proof was, or with none at all", () => {
    expect(planBatch({ messages: [], finalizedSlot: FINALIZED, nowSeconds: NOW, rule: RULE, economics: known({}), lastProofAt: NOW - 5 * 3600 })).toBeNull();
    expect(planBatch({ messages: [], finalizedSlot: FINALIZED, nowSeconds: NOW, rule: RULE, economics: known({}), lastProofAt: null })).toBeNull();
  });

  it("with no minimum interval, proves the final messages at once, whatever they pay", () => {
    const plan = planBatch({ messages: [msg("a", 400, NOW - 10), msg("b", 600, NOW + 300)], finalizedSlot: FINALIZED, nowSeconds: NOW, rule: { ...RULE, minIntervalSeconds: 0 }, economics: { kind: "unknown", why: "test" }, lastProofAt: RECENT });
    expect(plan).toEqual({ due: true, trigger: "interval", messageIds: ["a"], feesUsd: null, costUsd: null, atMaximum: 0, waitedSeconds: 10 });
  });

  it("a batch that pays proves at once, inside the interval, and the proof covers every final message", () => {
    const plan = planBatch({ messages: [msg("a", 400, NOW - 10), msg("b", 450, NOW - 5)], finalizedSlot: FINALIZED, nowSeconds: NOW, rule: RULE, economics: known({ a: cents(2), b: cents(1) }), lastProofAt: RECENT });
    expect(plan).toEqual({ due: true, trigger: "profit", messageIds: ["a", "b"], feesUsd: cents(3), costUsd: PROOF_COST_USD, atMaximum: 0, waitedSeconds: 10 });
  });

  it("a batch that does not pay proves at its finality when the last proof is an interval or more ago, or there is none", () => {
    const messages = [msg("a", 400, NOW - 10)];
    // The owner's case: a message long after the last proof waits no extra hour.
    expect(planBatch({ messages, finalizedSlot: FINALIZED, nowSeconds: NOW, rule: RULE, economics: known({ a: cents(1) }), lastProofAt: NOW - 5 * 3600 })).toEqual({ due: true, trigger: "interval", messageIds: ["a"], feesUsd: cents(1), costUsd: PROOF_COST_USD, atMaximum: 0, waitedSeconds: 10 });
    expect(planBatch({ messages, finalizedSlot: FINALIZED, nowSeconds: NOW, rule: RULE, economics: known({}), lastProofAt: NOW - 3600 })).toMatchObject({ due: true, trigger: "interval" });
    expect(planBatch({ messages, finalizedSlot: FINALIZED, nowSeconds: NOW, rule: RULE, economics: known({}), lastProofAt: null })).toMatchObject({ due: true, trigger: "interval" });
  });

  it("inside the interval, waits until the last proof plus the interval, then proves", () => {
    const messages = [msg("a", 400, NOW - 10)];
    const waiting = planBatch({ messages, finalizedSlot: FINALIZED, nowSeconds: NOW, rule: RULE, economics: known({ a: cents(1) }), lastProofAt: RECENT });
    expect(waiting).toEqual({ due: false, startAt: RECENT + 3600, startWhy: "interval", dueAt: RECENT + 3600, lastProofAt: RECENT, ready: 1, oldestFinalAt: NOW - 10, feesUsd: cents(1), costUsd: PROOF_COST_USD, unknownWhy: null });
    expect(planBatch({ messages, finalizedSlot: FINALIZED, nowSeconds: RECENT + 3600 - 1, rule: RULE, economics: known({ a: cents(1) }), lastProofAt: RECENT })).toMatchObject({ due: false });
    expect(planBatch({ messages, finalizedSlot: FINALIZED, nowSeconds: RECENT + 3600, rule: RULE, economics: known({ a: cents(1) }), lastProofAt: RECENT })).toMatchObject({ due: true, trigger: "interval", waitedSeconds: 3010 });
  });

  it("expects the proof at the finality at which the fees of the final and the soon final messages cover the cost", () => {
    // Two cents now, one more cent final in 100 s, another in 200 s: the batch pays at the second.
    const messages = [msg("a", 400, NOW - 10), msg("c", 700, NOW + 200), msg("b", 600, NOW + 100)];
    const plan = planBatch({ messages, finalizedSlot: FINALIZED, nowSeconds: NOW, rule: RULE, economics: known({ a: cents(1), b: cents(1), c: cents(1) }), lastProofAt: RECENT });
    expect(plan).toMatchObject({ due: false, startAt: NOW + 200, startWhy: "profit", ready: 1, feesUsd: cents(1) });
    // The deliveries count: with a cent of gas each, three cents never cover 2.5 + 3.
    expect(planBatch({ messages, finalizedSlot: FINALIZED, nowSeconds: NOW, rule: RULE, economics: known({ a: cents(1), b: cents(1), c: cents(1) }, cents(1)), lastProofAt: RECENT })).toMatchObject({ due: false, startWhy: "interval" });
  });

  it("counts no message beyond the lookahead, and no profit after the interval ends", () => {
    const economics = known({ a: cents(1), b: cents(5) });
    expect(planBatch({ messages: [msg("a", 400, NOW - 10), msg("b", 600, NOW + 400)], finalizedSlot: FINALIZED, nowSeconds: NOW, rule: RULE, economics, lastProofAt: RECENT })).toMatchObject({ due: false, startWhy: "interval" });
    expect(planBatch({ messages: [msg("a", 400, NOW - 10), msg("b", 600, NOW + 300)], finalizedSlot: FINALIZED, nowSeconds: NOW, rule: RULE, economics, lastProofAt: RECENT })).toMatchObject({ due: false, startWhy: "profit", startAt: NOW + 300 });
    // The interval ends first.
    expect(planBatch({ messages: [msg("a", 400, NOW - 10), msg("b", 600, NOW + 300)], finalizedSlot: FINALIZED, nowSeconds: NOW, rule: { ...RULE, minIntervalSeconds: 660 }, economics, lastProofAt: RECENT })).toMatchObject({ due: false, startWhy: "interval", startAt: NOW + 60 });
  });

  it("never proves early on unknown prices, and counts an unpriced message as nothing", () => {
    expect(planBatch({ messages: [msg("a", 400, NOW - 10), msg("b", 600, NOW + 10)], finalizedSlot: FINALIZED, nowSeconds: NOW, rule: RULE, economics: { kind: "unknown", why: "testnet tokens have no price" }, lastProofAt: RECENT })).toMatchObject({
      due: false,
      startWhy: "interval",
      feesUsd: null,
      costUsd: null,
      unknownWhy: "testnet tokens have no price",
    });
    expect(planBatch({ messages: [msg("a", 400, NOW - 10)], finalizedSlot: FINALIZED, nowSeconds: NOW, rule: RULE, economics: known({}), lastProofAt: RECENT })).toMatchObject({ due: false, feesUsd: 0n });
  });

  it("proves at finality a batch with a message whose token has no price and whose tip is at the automatic maximum, also on a testnet", () => {
    // A testnet: no coin price, so no fee is valued; a 1% tip pays all the same (owner, 2026-11-09).
    const testnet = (atMaximum: string[]): Economics => ({ kind: "known", feesUsd: new Map(), deliveryUsd: null, unpriced: 1, atMaximum: new Set(atMaximum), why: "testnet tokens have no price", block: null });
    const messages = [msg("a", 400, NOW - 10), msg("b", 450, NOW - 5)];
    expect(planBatch({ messages, finalizedSlot: FINALIZED, nowSeconds: NOW, rule: RULE, economics: testnet(["b"]), lastProofAt: RECENT })).toEqual({ due: true, trigger: "profit", messageIds: ["a", "b"], feesUsd: null, costUsd: null, atMaximum: 1, waitedSeconds: 10 });
    // Below the maximum: it waits for the interval, and says why the fees cannot be valued.
    expect(planBatch({ messages, finalizedSlot: FINALIZED, nowSeconds: NOW, rule: RULE, economics: testnet([]), lastProofAt: RECENT })).toMatchObject({ due: false, startWhy: "interval", feesUsd: null, costUsd: null, unknownWhy: "testnet tokens have no price" });
    // Not final yet: the proof is expected at its finality.
    expect(planBatch({ messages: [msg("a", 400, NOW - 10), msg("c", 600, NOW + 100)], finalizedSlot: FINALIZED, nowSeconds: NOW, rule: RULE, economics: testnet(["c"]), lastProofAt: RECENT })).toMatchObject({ due: false, startWhy: "profit", startAt: NOW + 100 });
    // On a priced chain it pays its batch beside the fees of the others.
    const mixed: Economics = { kind: "known", feesUsd: new Map([["a", 1n]]), deliveryUsd: 0n, unpriced: 0, atMaximum: new Set(["b"]), why: null, block: "1" };
    expect(planBatch({ messages, finalizedSlot: FINALIZED, nowSeconds: NOW, rule: RULE, economics: mixed, lastProofAt: RECENT })).toMatchObject({ due: true, trigger: "profit", feesUsd: 1n, costUsd: PROOF_COST_USD, atMaximum: 1 });
  });

  it("with unpricedAtMaximumPays false, a tip at the maximum no longer pays: the batch waits for the interval, priced fees still count", () => {
    const rule: BatchRule = { ...RULE, unpricedAtMaximumPays: false };
    const testnet: Economics = { kind: "known", feesUsd: new Map(), deliveryUsd: null, unpriced: 1, atMaximum: new Set(["b"]), why: "testnet tokens have no price", block: null };
    const messages = [msg("a", 400, NOW - 10), msg("b", 450, NOW - 5)];
    expect(planBatch({ messages, finalizedSlot: FINALIZED, nowSeconds: NOW, rule, economics: testnet, lastProofAt: RECENT })).toMatchObject({ due: false, startWhy: "interval", dueAt: RECENT + 3600 });
    // The interval ends: it is due for that reason, with no message counted at the maximum.
    expect(planBatch({ messages, finalizedSlot: FINALIZED, nowSeconds: NOW, rule, economics: testnet, lastProofAt: NOW - 3600 })).toMatchObject({ due: true, trigger: "interval", atMaximum: 0 });
    // Not final yet: it does not pull the expected start forward either.
    expect(planBatch({ messages: [msg("a", 400, NOW - 10), msg("b", 600, NOW + 100)], finalizedSlot: FINALIZED, nowSeconds: NOW, rule, economics: testnet, lastProofAt: RECENT })).toMatchObject({ due: false, startWhy: "interval" });
    // Priced fees that cover the cost still pay.
    const mixed: Economics = { kind: "known", feesUsd: new Map([["a", PROOF_COST_USD]]), deliveryUsd: 0n, unpriced: 0, atMaximum: new Set(["b"]), why: null, block: "1" };
    expect(planBatch({ messages, finalizedSlot: FINALIZED, nowSeconds: NOW, rule, economics: mixed, lastProofAt: RECENT })).toMatchObject({ due: true, trigger: "profit", atMaximum: 0 });
  });

  it("with nothing final yet, expects the proof no earlier than the first finality, ordering equal times by identifier", () => {
    const plan = planBatch({ messages: [msg("b", 600, NOW + 100), msg("a", 610, NOW + 100), msg("c", 620, NOW + 100)], finalizedSlot: FINALIZED, nowSeconds: NOW, rule: RULE, economics: known({ c: cents(3) }), lastProofAt: RECENT });
    expect(plan).toMatchObject({ due: false, ready: 0, oldestFinalAt: NOW + 100, startAt: NOW + 100, startWhy: "profit", feesUsd: 0n });
    // Long after the last proof, the expected start is the first finality itself.
    expect(planBatch({ messages: [msg("b", 600, NOW + 100)], finalizedSlot: FINALIZED, nowSeconds: NOW, rule: RULE, economics: known({}), lastProofAt: NOW - 5 * 3600 })).toMatchObject({ due: false, ready: 0, startAt: NOW + 100, dueAt: NOW + 100, startWhy: "interval" });
  });
});

// PulseChain at one block: PLS at one cent (a USDC pool), a fee token at one dollar (100 PLS), WPLS itself.
const ROUTER: Address = "0x00000000000000000000000000000000000000d1";
const FEE_TOKEN: Address = "0x00000000000000000000000000000000000000f1";
const POOL_USDC: Address = "0x0000000000000000000000000000000000000a01";
const POOL_TOKEN: Address = "0x0000000000000000000000000000000000000a02";
const ZERO = "0x0000000000000000000000000000000000000000";
const USDC = STABLES[0]!.address;

function pulsechain(options: { usdc?: boolean; failBlock?: boolean } = {}) {
  const calls: string[] = [];
  const pools: Record<string, { token0: Address; reserves: [bigint, bigint] }> = {
    [POOL_USDC.toLowerCase()]: { token0: USDC, reserves: [10n ** 12n, 10n ** 26n] },
    [POOL_TOKEN.toLowerCase()]: { token0: FEE_TOKEN, reserves: [10n ** 24n, 10n ** 26n] },
  };
  const pairOf = (a: string, b: string) => {
    const pairKey = [a.toLowerCase(), b.toLowerCase()].sort().join("/");
    if (options.usdc !== false && pairKey === [USDC.toLowerCase(), WPLS.toLowerCase()].sort().join("/")) return POOL_USDC;
    if (pairKey === [FEE_TOKEN.toLowerCase(), WPLS.toLowerCase()].sort().join("/")) return POOL_TOKEN;
    return ZERO;
  };
  return {
    calls,
    getBlockNumber: async () => {
      if (options.failBlock === true) throw new Error("rpc down");
      return 77n;
    },
    readContract: async (call: { address: Address; functionName: string; args?: readonly unknown[]; blockNumber?: bigint }) => {
      calls.push(`${call.functionName}@${call.blockNumber}`);
      if (call.functionName === "getPair") return call.address === PULSEX_FACTORIES[0] ? pairOf(call.args![0] as string, call.args![1] as string) : ZERO;
      if (call.functionName === "bridgedTokenAddress") return ZERO;
      const pool = pools[call.address.toLowerCase()]!;
      return call.functionName === "token0" ? pool.token0 : [pool.reserves[0], pool.reserves[1], 0];
    },
  };
}

/** A relay of `value` to the router, with a fixed fee of `fee`, as the mediator call of a message. */
function relay(fee: bigint, recipient: Address = ROUTER, value = 10n ** 20n): Hex {
  const director = encodeAbiParameters([{ type: "address" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }], ["0x00000000000000000000000000000000000000e1", 1n, fee, 0n, 0n]);
  return encodeFunctionData({ abi: tokenMediatorAbi, functionName: "handleNativeTokensAndCall", args: [FEE_TOKEN, recipient, value, director, 400_000n] });
}

const token = (overrides: Partial<DestinationToken> = {}): DestinationToken => ({ address: FEE_TOKEN, decimals: 18, isBridgedCopy: false, homeChainId: 369, homeToken: FEE_TOKEN, ...overrides });
const id = (digit: string): Hex => `0x${digit.repeat(64)}`;

describe("createEconomicsReader", () => {
  function reader(data: Record<string, Hex>, options: { chainId?: number; router?: Address | null; pulse?: ReturnType<typeof pulsechain> | null } = {}) {
    const reads: Hex[] = [];
    const pulse = options.pulse === undefined ? pulsechain() : options.pulse;
    const read = createEconomicsReader({
      destinationChainId: options.chainId ?? 369,
      deliveryRouter: options.router === undefined ? ROUTER : options.router,
      wrappedNative: WPLS,
      dependencies: {
        readMessageData: async (messageId) => {
          reads.push(messageId);
          return data[messageId] as Hex;
        },
        pulsechain: pulse,
        destinationBaseFee: async () => 10n ** 9n,
        deliveryGas: async () => DELIVERY_GAS,
      },
    });
    return { read, reads, pulse };
  }

  it("values each fee for the fee address in dollars at one PulseChain block, and the delivery gas of one message", async () => {
    const { read, reads, pulse } = reader({ [id("a")]: relay(2n * 10n ** 18n), [id("b")]: relay(10n ** 17n) });
    const economics = await read([{ messageId: id("a"), destinationToken: token() }, { messageId: id("b"), destinationToken: token({ isBridgedCopy: true }) }]);
    // Two tokens at a dollar, a tenth at a dollar; one delivery at 1 gwei plus the 0.01 gwei floor, PLS at one cent.
    expect(economics).toEqual({
      kind: "known",
      feesUsd: new Map([[id("a"), 2n * USD], [id("b"), USD / 10n]]),
      deliveryUsd: (DELIVERY_GAS * (10n ** 9n + 10n ** 7n) * 10n ** 16n) / 10n ** 18n,
      unpriced: 0,
      atMaximum: new Set(),
      why: null,
      block: "77",
    });
    expect(pulse!.calls.every((call) => call.endsWith("@77"))).toBe(true);
    // The call data of a message is read once while it waits, and forgotten once it is gone.
    await read([{ messageId: id("a"), destinationToken: token() }]);
    await read([{ messageId: id("b"), destinationToken: token() }]);
    expect(reads).toEqual([id("a"), id("b"), id("b")]);
  });

  it("counts nothing for a message that pays no fee; a token with no price pays only at the automatic maximum", async () => {
    const plain = encodeFunctionData({ abi: tokenMediatorAbi, functionName: "handleNativeTokens", args: [FEE_TOKEN, ROUTER, 1n] });
    const legacy = encodeFunctionData({ abi: tokenMediatorAbi, functionName: "handleNativeTokensAndCall", args: [FEE_TOKEN, ROUTER, 1n, "0x00000000000000000000000000000000000000e1", 400_000n] });
    const overflow = (() => {
      const director = encodeAbiParameters([{ type: "address" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }], ["0x00000000000000000000000000000000000000e1", 0n, 1n, 2n ** 255n, 0n]);
      return encodeFunctionData({ abi: tokenMediatorAbi, functionName: "handleNativeTokensAndCall", args: [FEE_TOKEN, ROUTER, 10n ** 30n, director, 400_000n] });
    })();
    // 0.1% of the 100 tokens sent, and 1%.
    const below = relay(10n ** 17n);
    const atMaximum = relay(10n ** 18n);
    const data = { [id("1")]: "0x12345678" as Hex, [id("2")]: plain, [id("3")]: relay(5n, "0x00000000000000000000000000000000000000c3"), [id("4")]: legacy, [id("5")]: overflow, [id("6")]: below, [id("7")]: below, [id("8")]: below, [id("9")]: below, [id("c")]: atMaximum };
    const { read } = reader(data);
    const economics = await read([
      { messageId: id("1"), destinationToken: token() },
      { messageId: id("2"), destinationToken: token() },
      { messageId: id("3"), destinationToken: token() },
      { messageId: id("4"), destinationToken: token() },
      { messageId: id("5"), destinationToken: token() },
      // No token, no decimals, a token without pools, a testnet origin: no price.
      { messageId: id("6") },
      { messageId: id("7"), destinationToken: token({ decimals: null }) },
      { messageId: id("8"), destinationToken: token({ address: "0x00000000000000000000000000000000000000f9", homeToken: null }) },
      { messageId: id("9"), destinationToken: token({ isBridgedCopy: true, homeChainId: 943, homeToken: FEE_TOKEN }) },
      { messageId: id("c"), destinationToken: token({ address: "0x00000000000000000000000000000000000000f9", homeToken: null }) },
    ]);
    expect(economics).toMatchObject({ kind: "known", feesUsd: new Map(), unpriced: 4, atMaximum: new Set([id("c")]) });
    // A deployment without a delivery router takes no fee at all.
    expect(await reader({ [id("6")]: relay(10n ** 18n) }, { router: null }).read([{ messageId: id("6"), destinationToken: token() }])).toMatchObject({ feesUsd: new Map(), atMaximum: new Set() });
  });

  it("values no fee on a testnet, without a PulseChain endpoint, or without a price of the destination's coin, and still finds the tips at the automatic maximum", async () => {
    const testnet = await reader({ [id("a")]: relay(10n ** 18n) }, { chainId: 943, pulse: null }).read([{ messageId: id("a"), destinationToken: token({ isBridgedCopy: true, homeChainId: 11155111 }) }]);
    expect(testnet).toEqual({ kind: "known", feesUsd: new Map(), deliveryUsd: null, unpriced: 0, atMaximum: new Set([id("a")]), why: "testnet tokens have no price", block: null });
    expect(await reader({}, { pulse: null }).read([])).toMatchObject({ deliveryUsd: null, why: "the prices could not be read" });
    expect(await reader({}, { pulse: pulsechain({ usdc: false }) }).read([])).toMatchObject({ deliveryUsd: null, why: "no price for the destination's coin" });
    expect(await reader({}, { pulse: pulsechain({ failBlock: true }) }).read([])).toMatchObject({ deliveryUsd: null, why: "the prices could not be read" });
  });

  it("keeps a recent price when PulseChain stops answering, by the dapp's stale rule", async () => {
    let failBlock = false;
    const base = pulsechain();
    const flaky = { ...base, getBlockNumber: async () => (failBlock ? Promise.reject(new Error("rpc down")) : base.getBlockNumber()) };
    let now = 0;
    const read = createEconomicsReader({
      destinationChainId: 369,
      deliveryRouter: ROUTER,
      wrappedNative: WPLS,
      now: () => now,
      dependencies: { readMessageData: async () => relay(2n * 10n ** 18n), pulsechain: flaky, destinationBaseFee: async () => 10n ** 9n, deliveryGas: async () => DELIVERY_GAS },
    });
    const messages = [{ messageId: id("a"), destinationToken: token() }];
    expect(await read(messages)).toMatchObject({ feesUsd: new Map([[id("a"), 2n * USD]]) });
    failBlock = true;
    now = 300_000;
    expect(await read(messages)).toMatchObject({ feesUsd: new Map([[id("a"), 2n * USD]]), why: null });
    now = 700_000;
    expect(await read(messages)).toMatchObject({ feesUsd: new Map(), unpriced: 0, atMaximum: new Set([id("a")]), why: "the prices could not be read" });
  });
});

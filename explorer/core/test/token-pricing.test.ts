import { describe, expect, it } from "vitest";
import type { Address } from "viem";
import {
  STALE_PRICE_MAX_SECONDS,
  countingCaller,
  createPriceKeeper,
  holdingAfterFailure,
  holdingAfterRead,
  isChainAnswer,
  isUsablePrice,
  nativePriceKey,
  poolReaderAtLatest,
  poolReaderOver,
  priceProblemOf,
  readPrices,
  tokenValuationIn,
  tokenValuationOf,
  worsePriceState,
  type PriceState,
  type PriceSubject,
} from "../src/index.js";
import { FIXTURE_BLOCK, fixtureClient, tipVectors } from "./fixtures/pool-caller.js";

const A = tipVectors.tokens.A.address as Address;
const B = tipVectors.tokens.B.address as Address;
const T = tipVectors.tokens.T;
const PLS = BigInt(tipVectors.prices.plsUsdE18);
const A_USD = BigInt(tipVectors.prices.tokenAUsdE18);
const subjectA: PriceSubject = { key: "a", token: { chainId: 369, address: A }, decimals: 18 };
const subjectB: PriceSubject = { key: "b", token: { chainId: 369, address: B }, decimals: 18 };
const subjectT: PriceSubject = { key: "t", token: { chainId: 943, address: T.address as Address, origin: T.origin as { chainId: number; address: Address } }, decimals: 18 };
const known: PriceState = { kind: "known" };

describe("telling a chain's answer from a failure to reach it", () => {
  it("reads a revert or an empty answer, also as a cause, as the chain's answer", () => {
    const named = (name: string, cause?: unknown) => Object.assign(new Error(name), { name, cause });
    expect(isChainAnswer(named("ContractFunctionRevertedError"))).toBe(true);
    expect(isChainAnswer(named("ContractFunctionExecutionError", named("ContractFunctionZeroDataError")))).toBe(true);
    expect(isChainAnswer(named("HttpRequestError"))).toBe(false);
    expect(isChainAnswer("not an error")).toBe(false);
  });

  it("counts only the failures that are not answers", async () => {
    let fail: Error | null = null;
    const { caller, failures } = countingCaller({ readContract: async (_call: unknown) => {
      if (fail !== null) throw fail;
      return 1;
    } });
    expect(await caller.readContract({ address: A, abi: [], functionName: "x" })).toBe(1);
    fail = Object.assign(new Error("reverted"), { name: "ContractFunctionRevertedError" });
    await expect(caller.readContract({ address: A, abi: [], functionName: "x" })).rejects.toThrow();
    expect(failures()).toBe(0);
    fail = new Error("fetch failed");
    await expect(caller.readContract({ address: A, abi: [], functionName: "x" })).rejects.toThrow();
    expect(failures()).toBe(1);
  });

  it("gives a pool reader that counts its failures, and one at the latest block", async () => {
    const down = poolReaderOver(fixtureClient({ unreachable: true }), 1n);
    expect(await down.pairOf(A, A, A)).toBeNull();
    expect(down.failures()).toBe(1);
    expect((await poolReaderAtLatest(fixtureClient())).block).toBe(FIXTURE_BLOCK);
    await expect(poolReaderAtLatest(fixtureClient({ unreachable: true }))).rejects.toThrow("fetch failed");
  });
});

describe("reading prices", () => {
  const reader = () => poolReaderAtLatest(fixtureClient());

  it("prices tokens and native coins at one block: a deep pool is a price, a thin one none, a testnet's none", async () => {
    const prices = await readPrices([subjectA, subjectB, subjectT], [369, 943, 369], reader);
    expect(prices.get("a")).toEqual({ usdE18: A_USD, block: FIXTURE_BLOCK, pool: "0x00000000000000000000000000000000000000a2" });
    expect(prices.get("b")).toBeNull();
    expect(prices.get("t")).toBeNull();
    expect(prices.get(nativePriceKey(369))?.usdE18).toBe(PLS);
    expect(prices.get(nativePriceKey(943))).toBeNull();
    expect(prices.size).toBe(5);
  });

  it("reads nothing when nothing can have a price (a testnet)", async () => {
    let asked = 0;
    const prices = await readPrices([subjectT], [943, 11155111], async () => {
      asked += 1;
      return reader();
    });
    expect(asked).toBe(0);
    expect([...prices.values()]).toEqual([null, null, null]);
  });

  it("gives no price to an Ethereum token that has no PulseChain copy", async () => {
    const unknownCopy: PriceSubject = { key: "e", token: { chainId: 1, address: "0x00000000000000000000000000000000000000e1" }, decimals: 18 };
    expect((await readPrices([unknownCopy], [], reader)).get("e")).toBeNull();
  });

  it("gives no token price without a PLS price", async () => {
    const empty = { block: 1n, pairOf: async () => null, reservesOf: async () => null };
    expect((await readPrices([subjectA], [], async () => empty)).get("a")).toBeNull();
  });

  it("throws when the source failed while reading, or cannot be reached", async () => {
    let calls = 0;
    const flaky = fixtureClient();
    const half = { ...flaky, readContract: async (call: Parameters<typeof flaky.readContract>[0]) => {
      calls += 1;
      if (calls === 1) throw new Error("fetch failed");
      return flaky.readContract(call);
    } };
    await expect(readPrices([subjectA], [369], () => poolReaderAtLatest(half))).rejects.toThrow("the price source failed");
    await expect(readPrices([subjectA], [], () => poolReaderAtLatest(fixtureClient({ unreachable: true })))).rejects.toThrow("fetch failed");
  });
});

describe("the state of a price", () => {
  const quote = { usdE18: 5n, block: 1n, pool: null };

  it("knows a price read, and marks a missing one as no market", () => {
    const held = holdingAfterRead(new Map([["a", quote], ["b", null]]), 1_000);
    expect(held.states).toEqual(new Map([["a", known], ["b", { kind: "no-market" }]]));
    expect(held.seenAt).toEqual(new Map([["a", 1_000]]));
  });

  it("after a failure keeps a price up to the stale limit, keeps a missing market, and is unreachable otherwise", () => {
    const before = holdingAfterRead(new Map([["a", quote], ["b", null]]), 0);
    const atLimit = holdingAfterFailure(before, ["a", "b", "c"], STALE_PRICE_MAX_SECONDS * 1000, "down");
    expect(atLimit.states).toEqual(new Map<string, PriceState>([["a", { kind: "stale", ageSeconds: STALE_PRICE_MAX_SECONDS }], ["b", { kind: "no-market" }], ["c", { kind: "unreachable" }]]));
    expect(atLimit.data?.get("a")).toEqual(quote);
    expect(atLimit.error).toBe("down");
    const past = holdingAfterFailure(before, ["a"], (STALE_PRICE_MAX_SECONDS + 1) * 1000, "down");
    expect(past.states.get("a")).toEqual({ kind: "unreachable" });
    expect(past.data).toBeUndefined();
    // A clock that went back reads as age 0; nothing held at all is unreachable.
    expect(holdingAfterFailure(holdingAfterRead(new Map([["a", quote]]), 5_000), ["a"], 0, null).states.get("a")).toEqual({ kind: "stale", ageSeconds: 0 });
    expect(holdingAfterFailure(undefined, ["a"], 0, null).states.get("a")).toEqual({ kind: "unreachable" });
  });

  it("names the problem among the prices asked about: unreachable, then no market, then stale", () => {
    const states = new Map<string, PriceState>([["k", known], ["s", { kind: "stale", ageSeconds: 3 }], ["n", { kind: "no-market" }], ["u", { kind: "unreachable" }]]);
    expect(priceProblemOf(states, ["k", "s", "n", "u"])).toEqual({ key: "u", state: { kind: "unreachable" } });
    expect(priceProblemOf(states, ["k", "s", "n"])?.key).toBe("n");
    expect(priceProblemOf(states, ["k", "s"])?.key).toBe("s");
    expect(priceProblemOf(states, ["k", "missing"])).toBeNull();
  });

  it("uses a known or stale price only", () => {
    expect(isUsablePrice(known)).toBe(true);
    expect(isUsablePrice({ kind: "stale", ageSeconds: 1 })).toBe(true);
    expect(isUsablePrice({ kind: "no-market" })).toBe(false);
    expect(isUsablePrice({ kind: "unreachable" })).toBe(false);
  });
});

describe("the price keeper of a server", () => {
  it("reads, then falls back to the last good prices by the stale rule, and remembers keys across reads", async () => {
    let now = 0;
    let unreachable = false;
    const keeper = createPriceKeeper({ poolReader: () => poolReaderAtLatest(fixtureClient({ unreachable })), now: () => now });
    const first = await keeper.read([subjectA, subjectB], [369]);
    expect(first.states).toEqual(new Map<string, PriceState>([["a", known], ["b", { kind: "no-market" }], [nativePriceKey(369), known]]));
    unreachable = true;
    now = 60_000;
    const failed = await keeper.read([subjectA, subjectB], [369, 369]);
    expect(failed.states).toEqual(new Map<string, PriceState>([["a", { kind: "stale", ageSeconds: 60 }], ["b", { kind: "no-market" }], [nativePriceKey(369), { kind: "stale", ageSeconds: 60 }]]));
    expect(failed.data?.get("a")?.usdE18).toBe(A_USD);
    now = (STALE_PRICE_MAX_SECONDS + 1) * 1000;
    expect((await keeper.read([subjectA], [])).states.get("a")).toEqual({ kind: "unreachable" });
  });

  it("without an endpoint: a testnet price is no market without a read, any other is unreachable", async () => {
    const keeper = createPriceKeeper({ poolReader: null, now: () => 0 });
    expect((await keeper.read([subjectT], [943])).states).toEqual(new Map<string, PriceState>([["t", { kind: "no-market" }], [nativePriceKey(943), { kind: "no-market" }]]));
    const mainnet = await keeper.read([subjectA], [369]);
    expect(mainnet.states.get("a")).toEqual({ kind: "unreachable" });
    expect(String(mainnet.error)).toMatch(/no PulseChain endpoint/);
  });
});

describe("a token's valuation for a tip", () => {
  const quote = (usdE18: bigint) => ({ usdE18, block: 1n, pool: null });

  it("takes the worse of two states, the older of two stale ones", () => {
    const stale = (ageSeconds: number): PriceState => ({ kind: "stale", ageSeconds });
    expect(worsePriceState(known, { kind: "unreachable" })).toEqual({ kind: "unreachable" });
    expect(worsePriceState({ kind: "no-market" }, stale(1))).toEqual({ kind: "no-market" });
    expect(worsePriceState(stale(5), stale(9))).toEqual(stale(9));
    expect(worsePriceState(stale(9), stale(5))).toEqual(stale(9));
    expect(worsePriceState(known, known)).toEqual(known);
  });

  it("values a token in USD and in wei of the destination's coin, the wrapped coin at exactly 1e18", () => {
    expect(tokenValuationOf({ quote: quote(A_USD), state: known }, { quote: quote(PLS), state: known }, false)).toEqual({ state: known, usdE18: A_USD, nativeUsdE18: PLS, weiPerToken: BigInt(tipVectors.prices.tokenAWeiPerToken) });
    expect(tokenValuationOf({ quote: quote(PLS - 1n), state: known }, { quote: quote(PLS), state: known }, true).weiPerToken).toBe(10n ** 18n);
  });

  it("values nothing unless both prices are usable; a usable state without a quote is no market", () => {
    expect(tokenValuationOf({ quote: quote(1n), state: known }, { quote: null, state: { kind: "no-market" } }, false)).toEqual({ state: { kind: "no-market" }, usdE18: null, nativeUsdE18: null, weiPerToken: null });
    expect(tokenValuationOf({ quote: null, state: known }, { quote: quote(1n), state: known }, false).state).toEqual({ kind: "no-market" });
    expect(tokenValuationOf({ quote: quote(0n), state: known }, { quote: quote(1n), state: known }, false).state).toEqual({ kind: "no-market" });
    expect(tokenValuationOf({ quote: quote(1n), state: undefined }, { quote: quote(1n), state: known }, false).state).toEqual({ kind: "unreachable" });
  });

  it("reads a valuation from a holding", async () => {
    const holding = await createPriceKeeper({ poolReader: () => poolReaderAtLatest(fixtureClient()), now: () => 0 }).read([subjectA], [369]);
    expect(tokenValuationIn(holding, "a", 369, false).usdE18).toBe(A_USD);
    expect(tokenValuationIn({ data: undefined, states: new Map() }, "a", 369, false).state).toEqual({ kind: "unreachable" });
  });
});

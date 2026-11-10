import { describe, expect, it } from "vitest";
import type { PriceState } from "@zkb/react";
import type { ContractCaller } from "@zk-bridge/shared";
import { priceNotice, ageText } from "../../src/bridge/price-notice";
import { countingCaller, isChainAnswer } from "../../src/bridge/use-prices";

const names = (key: string): string => (key.startsWith("native") ? "tPLS" : "tUSD");
const notice = (state: PriceState | undefined, unpriced = true) =>
  priceNotice({ states: new Map(state === undefined ? [] : [["second:0xT", state]]), keys: ["second:0xT", "native:943"], nameOf: names, unpriced, maximumText: "1%" });

describe("the price line", () => {
  it("says what happens in each state", () => {
    expect(notice({ kind: "no-market" })).toBe("1% maximum: tUSD has no market price");
    expect(notice({ kind: "unreachable" })).toBe("1% maximum: prices unreachable, read again every 30 s");
    expect(notice({ kind: "stale", ageSeconds: 45 })).toBe("Price from 45 s ago");
  });
  it("is silent when prices are known or not read yet, and when the fee does not fall back", () => {
    expect(notice({ kind: "known" })).toBeNull();
    expect(notice(undefined)).toBeNull();
    expect(notice({ kind: "no-market" }, false)).toBeNull();
  });
  it("names the coin when the coin is the one missing", () => {
    const states = new Map<string, PriceState>([["native:943", { kind: "no-market" }]]);
    expect(priceNotice({ states, keys: ["second:0xT", "native:943"], nameOf: names, unpriced: true, maximumText: "2%" })).toBe("2% maximum: tPLS has no market price");
  });
  it("words an age in seconds or whole minutes", () => {
    expect([ageText(0), ageText(59), ageText(60), ageText(125), ageText(600)]).toEqual(["0 s", "59 s", "1 min", "2 min", "10 min"]);
  });
});

describe("telling a failed request from the chain's answer", () => {
  const named = (name: string, cause?: unknown) => Object.assign(new Error(name, { cause }), { name });
  it("takes a revert or empty data, however deep, as an answer, and anything else as a failure", () => {
    expect(isChainAnswer(named("ContractFunctionExecutionError", named("ContractFunctionRevertedError")))).toBe(true);
    expect(isChainAnswer(named("ContractFunctionZeroDataError"))).toBe(true);
    expect(isChainAnswer(named("ContractFunctionExecutionError", named("HttpRequestError")))).toBe(false);
    expect(isChainAnswer("timeout")).toBe(false);
  });
  it("counts the reads that did not get through, and passes results and answers on", async () => {
    const reads: Array<() => unknown> = [() => 7, () => { throw named("ContractFunctionRevertedError"); }, () => { throw named("TimeoutError"); }];
    const client = { readContract: async () => reads.shift()!() } as unknown as ContractCaller;
    const { caller, failures } = countingCaller(client);
    const call = {} as Parameters<ContractCaller["readContract"]>[0];
    expect(await caller.readContract(call)).toBe(7);
    await expect(caller.readContract(call)).rejects.toThrow();
    expect(failures()).toBe(0);
    await expect(caller.readContract(call)).rejects.toThrow();
    expect(failures()).toBe(1);
  });
});

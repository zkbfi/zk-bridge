import { decodeFunctionData, encodeErrorResult, erc20Abi, getAddress, maxUint256, type Address, type PublicClient } from "viem";
import { describe, expect, it, vi } from "vitest";
import { beaconForkGateAbi, messageBridgeAbi, tokenMediatorAbi } from "@zk-bridge/shared";
import { approvalData, createTrafficReader, messageIdOf, relayData, relayRefusalOf } from "../../src/traffic/chain.ts";
import { DOLLAR, requestLog } from "../support/traffic.ts";

const WALLET = getAddress("0x70997970C51812dc3A010C7d01b50e0d17dc79C8");
const MEDIATOR = getAddress("0x2222222222222222222222222222222222222222");
const BRIDGE = getAddress("0x3333333333333333333333333333333333333333");
const FACTORY = getAddress("0x4444444444444444444444444444444444444444");
const ROUTER = getAddress("0x5555555555555555555555555555555555555555");
const COPY = getAddress("0x6666666666666666666666666666666666666666");
const MESSAGE_ID = `0x${"ab".repeat(32)}` as const;

function client(code: string | undefined) {
  const readContract = vi.fn(async ({ functionName }: { functionName: string }) => (functionName === "predictAddress" ? COPY : 77n));
  return {
    getBalance: vi.fn(async () => 5n),
    getCode: vi.fn(async () => code),
    readContract,
  } as unknown as Pick<PublicClient, "getBalance" | "getCode" | "readContract"> & { readContract: typeof readContract };
}

describe("the traffic reader", () => {
  it("reads balances, allowances and the copy address", async () => {
    const answers = client("0x6080");
    const reader = createTrafficReader(answers);
    expect(await reader.nativeBalance(WALLET)).toBe(5n);
    expect(await reader.hasCode(DOLLAR)).toBe(true);
    expect(await reader.tokenBalance(DOLLAR, WALLET)).toBe(77n);
    expect(await reader.allowance(DOLLAR, WALLET, MEDIATOR)).toBe(77n);
    expect(await reader.copyAddress({ tokenFactory: FACTORY, homeChainId: 943, nativeToken: DOLLAR })).toBe(COPY);
    expect(answers.readContract).toHaveBeenCalledWith(expect.objectContaining({ address: FACTORY, functionName: "predictAddress", args: [943n, DOLLAR] }));
    expect(answers.readContract).toHaveBeenCalledWith(expect.objectContaining({ address: DOLLAR, functionName: "allowance", args: [WALLET, MEDIATOR] }));
  });

  it("reads zero for a token that has no code yet", async () => {
    for (const code of [undefined, "0x"]) {
      const answers = client(code);
      const reader = createTrafficReader(answers);
      expect(await reader.hasCode(COPY)).toBe(false);
      expect(await reader.tokenBalance(COPY, WALLET)).toBe(0n);
      expect(await reader.allowance(COPY, WALLET, MEDIATOR)).toBe(0n);
      expect(answers.readContract).not.toHaveBeenCalled();
    }
  });
});

describe("the traffic calls", () => {
  it("approves the mediator for the largest amount", () => {
    const decoded = decodeFunctionData({ abi: erc20Abi, data: approvalData(MEDIATOR) });
    expect(decoded).toEqual({ functionName: "approve", args: [MEDIATOR, maxUint256] });
  });

  it("relays with the fee terms to the router", () => {
    const decoded = decodeFunctionData({ abi: tokenMediatorAbi, data: relayData({ token: DOLLAR, router: ROUTER, amount: 25n, terms: "0x1234" }) });
    expect(decoded.functionName).toBe("relayTokensAndCall");
    expect(decoded.args).toEqual([DOLLAR, ROUTER, 25n, "0x1234"]);
    expect(relayData({ token: DOLLAR, router: ROUTER, amount: 25n, terms: "0x1234", gasLimit: null })).toBe(relayData({ token: DOLLAR, router: ROUTER, amount: 25n, terms: "0x1234" }));
    const withLimit = decodeFunctionData({ abi: tokenMediatorAbi, data: relayData({ token: DOLLAR, router: ROUTER, amount: 25n, terms: "0x1234", gasLimit: 9_000_000n }) });
    expect(withLimit.args).toEqual([DOLLAR, ROUTER, 25n, "0x1234", 9_000_000n]);
  });

  it("finds the message identifier of the bridge's log", () => {
    const other = { address: COPY as Address, topics: requestLog(COPY, MESSAGE_ID).topics, data: requestLog(COPY, MESSAGE_ID).data };
    const unrelated = { address: BRIDGE as Address, topics: [`0x${"00".repeat(32)}`] as `0x${string}`[], data: "0x" as const };
    expect(messageIdOf([other, unrelated, requestLog(BRIDGE, MESSAGE_ID)], BRIDGE)).toBe(MESSAGE_ID);
    expect(messageIdOf([other, unrelated], BRIDGE)).toBeNull();
  });

  it("finds no message identifier in another event of the bridge", () => {
    const completed = requestLog(BRIDGE, MESSAGE_ID);
    const topics = [`0x${"11".repeat(32)}`, ...completed.topics.slice(1)] as `0x${string}`[];
    expect(messageIdOf([{ ...completed, topics }], BRIDGE)).toBeNull();
  });
});

describe("relayRefusalOf", () => {
  const selectorOf = (data: `0x${string}`) => data.slice(0, 10);

  it("names a gate that has not confirmed the epoch", () => {
    const data = encodeErrorResult({ abi: beaconForkGateAbi, errorName: "ForkNotConfirmed", args: [12n] });
    expect(relayRefusalOf(`Execution reverted (revert data ${selectorOf(data)})`)).toEqual({ refusal: "gate-not-confirmed", error: "ForkNotConfirmed" });
  });

  it("names a locked bridge", () => {
    const data = encodeErrorResult({ abi: messageBridgeAbi, errorName: "DepositsNotOpen" });
    expect(relayRefusalOf(`reverted (revert data ${selectorOf(data)})`)).toEqual({ refusal: "deposits-not-open", error: "DepositsNotOpen" });
  });

  it("keeps the name or the selector of any other error", () => {
    const data = encodeErrorResult({ abi: tokenMediatorAbi, errorName: "ZeroAmount" });
    expect(relayRefusalOf(`reverted (revert data ${selectorOf(data)})`)).toEqual({ refusal: "relay-simulation-reverted", error: "ZeroAmount" });
    expect(relayRefusalOf("reverted (revert data 0xdeadbeef)")).toEqual({ refusal: "relay-simulation-reverted", error: "0xdeadbeef" });
    expect(relayRefusalOf("insufficient funds")).toEqual({ refusal: "relay-simulation-reverted", error: null });
  });
});

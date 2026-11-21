import { describe, expect, it } from "vitest";
import { encodeAbiParameters, encodeEventTopics, encodeFunctionData, parseAbi, parseAbiParameters, type Hex } from "viem";
import { deliveryRouterAbi, tokenMediatorAbi } from "../src/abis/index.js";
import { resolveTermsFee, routerDeliveryFromLogs, type DeliveryFeeFacts, type DeliveryLog, type RouterDeliveryInput } from "../src/router-delivery.js";

const at = (byte: string): Hex => `0x${byte.repeat(20)}`;
const ROUTER = at("e7");
const TOKEN = at("33");
const WRAPPED = at("e2");
const REWARD = at("77");
const RECIPIENT = at("88");
const FAILED = at("99");
const BRIDGE = at("b2");
const MEDIATOR = at("d2");
const ONE = 10n ** 18n;

const ERC20 = parseAbi([
  "event Transfer(address indexed from, address indexed to, uint256 value)",
  "event Withdrawal(address indexed src, uint256 wad)",
  "event Deposit(address indexed dst, uint256 wad)",
  "event TokensBridged(address indexed token, address indexed recipient, uint256 value, bytes32 indexed messageId)",
  "event AffirmationCompleted(address indexed sender, address indexed executor, bytes32 indexed messageId, bool status)",
]);

let nextIndex = 0;
const log = (address: Hex, topics: readonly Hex[], data: Hex = "0x"): DeliveryLog => ({ address, topics, data, logIndex: nextIndex++ });
const amount = (value: bigint): Hex => encodeAbiParameters(parseAbiParameters("uint256"), [value]);

const transfer = (token: Hex, from: Hex, to: Hex, value: bigint) =>
  log(token, encodeEventTopics({ abi: ERC20, eventName: "Transfer", args: { from, to } }) as Hex[], amount(value));
const tokensBridged = (recipient: Hex, value: bigint) =>
  log(MEDIATOR, encodeEventTopics({ abi: ERC20, eventName: "TokensBridged", args: { token: TOKEN, recipient, messageId: `0x${"ab".repeat(32)}` } }) as Hex[], amount(value));
const affirmation = () =>
  log(BRIDGE, encodeEventTopics({ abi: ERC20, eventName: "AffirmationCompleted", args: { sender: MEDIATOR, executor: MEDIATOR, messageId: `0x${"ab".repeat(32)}` } }) as Hex[], encodeAbiParameters(parseAbiParameters("bool"), [true]));
const withdrawal = (src: Hex, wad: bigint) => log(WRAPPED, encodeEventTopics({ abi: ERC20, eventName: "Withdrawal", args: { src } }) as Hex[], amount(wad));
const deposit = (dst: Hex, wad: bigint) => log(WRAPPED, encodeEventTopics({ abi: ERC20, eventName: "Deposit", args: { dst } }) as Hex[], amount(wad));
const delivered = (fields: { token?: Hex; recipient?: Hex; feeTo: Hex; amount: bigint; fee: bigint; paidOut: bigint; paidAs: number; callTarget?: Hex }) =>
  log(
    ROUTER,
    encodeEventTopics({ abi: deliveryRouterAbi, eventName: "Delivered", args: { token: fields.token ?? TOKEN, recipient: fields.recipient ?? RECIPIENT, feeTo: fields.feeTo } }) as Hex[],
    encodeAbiParameters(parseAbiParameters("uint256, uint256, uint256, uint8, address"), [fields.amount, fields.fee, fields.paidOut, fields.paidAs, fields.callTarget ?? at("00")]),
  );
const handOffRefused = (token: Hex, value: bigint) =>
  log(ROUTER, encodeEventTopics({ abi: deliveryRouterAbi, eventName: "HandOffRefused", args: { token } }) as Hex[], amount(value));
const callFailed = (target: Hex, recipient: Hex, gasGiven: bigint) =>
  log(ROUTER, encodeEventTopics({ abi: deliveryRouterAbi, eventName: "CallFailed", args: { target, recipient } }) as Hex[], amount(gasGiven));
const deliveryFailed = (token: Hex, recipient: Hex, value: bigint, reason = 0) =>
  log(ROUTER, encodeEventTopics({ abi: deliveryRouterAbi, eventName: "DeliveryFailed", args: { token, recipient } }) as Hex[], encodeAbiParameters(parseAbiParameters("uint256, uint8"), [value, reason]));

/** One delivery to the router: the mint to the router, `TokensBridged`, the router's logs, then the bridge's end. */
const deliveryLogs = (value: bigint, routerLogs: () => readonly DeliveryLog[]) => {
  nextIndex = 0;
  const mint = transfer(TOKEN, at("00"), ROUTER, value);
  const bridged = tokensBridged(ROUTER, value);
  const inner = routerLogs();
  return { logs: [mint, bridged, ...inner, affirmation()], tokensBridgedLogIndex: bridged.logIndex };
};

const input = (value: bigint, logs: { logs: readonly DeliveryLog[]; tokensBridgedLogIndex: number }, overrides: Partial<RouterDeliveryInput> = {}): RouterDeliveryInput => ({
  ...logs,
  router: ROUTER,
  token: TOKEN,
  value,
  wrappedNative: WRAPPED,
  rewardAddress: REWARD,
  boundaries: [BRIDGE, MEDIATOR],
  feePossible: true,
  ...overrides,
});

describe("routerDeliveryFromLogs: the Delivered event", () => {
  it("reads the testnet shape: 12.3 in, 0.0123 to the deliverer, 12.2877 to the recipient", () => {
    const value = (123n * ONE) / 10n;
    const logs = deliveryLogs(value, () => [
      transfer(TOKEN, ROUTER, REWARD, (123n * ONE) / 10_000n),
      transfer(TOKEN, ROUTER, RECIPIENT, (122_877n * ONE) / 10_000n),
      delivered({ feeTo: REWARD, amount: value, fee: (123n * ONE) / 10_000n, paidOut: (122_877n * ONE) / 10_000n, paidAs: 1 }),
    ]);
    expect(routerDeliveryFromLogs(input(value, logs))).toEqual({
      amount: value,
      fee: (123n * ONE) / 10_000n,
      received: (122_877n * ONE) / 10_000n,
      deliverer: REWARD,
      finalRecipient: RECIPIENT,
      feeSource: "event",
      payout: "token",
      handedOff: false,
      handOffReason: null,
      handOffRefused: false,
      callFailed: null,
    });
  });

  it("reads a native payout, a wrapped fallback, and a fee of zero with no deliverer", () => {
    const native = deliveryLogs(5n, () => [withdrawal(ROUTER, 5n), delivered({ token: WRAPPED, feeTo: REWARD, amount: 5n, fee: 1n, paidOut: 4n, paidAs: 2 })]);
    expect(routerDeliveryFromLogs(input(5n, native, { token: WRAPPED }))).toMatchObject({ payout: "native", fee: 1n, received: 4n, feeSource: "event" });
    const wrapped = deliveryLogs(5n, () => [delivered({ token: WRAPPED, feeTo: at("00"), amount: 5n, fee: 0n, paidOut: 5n, paidAs: 3 })]);
    expect(routerDeliveryFromLogs(input(5n, wrapped, { token: WRAPPED }))).toMatchObject({ payout: "wrapped", fee: 0n, received: 5n, deliverer: null });
  });
});

describe("routerDeliveryFromLogs: CallFailed after a delivery", () => {
  it("reads the target, the recipient and the gas of a call that failed; the recipient was paid", () => {
    const target = at("c1");
    const logs = deliveryLogs(100n, () => [delivered({ feeTo: at("00"), amount: 100n, fee: 0n, paidOut: 100n, paidAs: 1, callTarget: target }), callFailed(target, RECIPIENT, 50_000n)]);
    expect(routerDeliveryFromLogs(input(100n, logs))).toMatchObject({ received: 100n, handedOff: false, handOffRefused: false, callFailed: { target, recipient: RECIPIENT, gasGiven: 50_000n } });
  });
});

describe("routerDeliveryFromLogs: a router without the event (transfer logs)", () => {
  it("reads the fee to the reward address and the payout to the recipient", () => {
    const logs = deliveryLogs(100n, () => [transfer(TOKEN, ROUTER, REWARD, 3n), transfer(TOKEN, ROUTER, RECIPIENT, 97n)]);
    expect(routerDeliveryFromLogs(input(100n, logs))).toEqual({
      amount: 100n,
      fee: 3n,
      received: 97n,
      deliverer: REWARD,
      finalRecipient: RECIPIENT,
      feeSource: "logs",
      payout: "token",
      handedOff: false,
      handOffReason: null,
      handOffRefused: false,
      callFailed: null,
    });
  });

  it("without the reward address, takes the first of two transfers as the fee, and one transfer as no fee", () => {
    const two = deliveryLogs(100n, () => [transfer(TOKEN, ROUTER, REWARD, 3n), transfer(TOKEN, ROUTER, RECIPIENT, 97n)]);
    expect(routerDeliveryFromLogs(input(100n, two, { rewardAddress: null }))).toMatchObject({ fee: 3n, received: 97n, deliverer: REWARD });
    const one = deliveryLogs(100n, () => [transfer(TOKEN, ROUTER, RECIPIENT, 100n)]);
    expect(routerDeliveryFromLogs(input(100n, one, { rewardAddress: null }))).toMatchObject({ fee: 0n, received: 100n, deliverer: null, finalRecipient: RECIPIENT });
  });

  it("reads only its own delivery in a batch: the next delivery starts with the mediator", () => {
    nextIndex = 0;
    const first = tokensBridged(ROUTER, 100n);
    const own = [transfer(TOKEN, ROUTER, REWARD, 3n), transfer(TOKEN, ROUTER, RECIPIENT, 97n)];
    const end = affirmation();
    const second = tokensBridged(ROUTER, 50n);
    const theirs = [transfer(TOKEN, ROUTER, REWARD, 1n), transfer(TOKEN, ROUTER, at("aa"), 49n)];
    const logs = { logs: [second, ...theirs, first, ...own, end].sort((a, b) => a.logIndex - b.logIndex), tokensBridgedLogIndex: first.logIndex };
    expect(routerDeliveryFromLogs(input(100n, logs))).toMatchObject({ fee: 3n, received: 97n, finalRecipient: RECIPIENT });
    const later = { logs: logs.logs, tokensBridgedLogIndex: second.logIndex };
    expect(routerDeliveryFromLogs(input(50n, later))).toMatchObject({ fee: 1n, received: 49n, finalRecipient: at("aa") });
  });

  it("reads a hand-off: the fee before DeliveryFailed counts, the hand-off after it does not, and nothing was received", () => {
    const logs = deliveryLogs(100n, () => [transfer(TOKEN, ROUTER, REWARD, 3n), deliveryFailed(TOKEN, RECIPIENT, 97n), transfer(TOKEN, ROUTER, FAILED, 97n)]);
    expect(routerDeliveryFromLogs(input(100n, logs))).toEqual({
      amount: 100n,
      fee: 3n,
      received: 0n,
      deliverer: REWARD,
      finalRecipient: RECIPIENT,
      feeSource: "logs",
      payout: null,
      handedOff: true,
      handOffReason: "PayoutRefused",
      handOffRefused: false,
      callFailed: null,
    });
    const noFee = deliveryLogs(100n, () => [deliveryFailed(TOKEN, RECIPIENT, 100n), transfer(TOKEN, ROUTER, FAILED, 100n)]);
    expect(routerDeliveryFromLogs(input(100n, noFee))).toMatchObject({ fee: 0n, deliverer: null, handedOff: true });
  });

  it("reads the reason of a hand-off and a refusal by the failed delivery address", () => {
    const logs = deliveryLogs(100n, () => [deliveryFailed(TOKEN, RECIPIENT, 100n), handOffRefused(TOKEN, 100n)]);
    expect(routerDeliveryFromLogs(input(100n, logs))).toMatchObject({ handedOff: true, handOffReason: "PayoutRefused", handOffRefused: true, callFailed: null });
  });

  it("names each reason of the router's Reason enum, and no reason for a value the enum does not have", () => {
    const reasonOf = (reason: number) => routerDeliveryFromLogs(input(100n, deliveryLogs(100n, () => [deliveryFailed(TOKEN, RECIPIENT, 100n, reason), transfer(TOKEN, ROUTER, FAILED, 100n)])));
    expect(reasonOf(0)).toMatchObject({ handedOff: true, handOffReason: "PayoutRefused" });
    expect(reasonOf(1)).toMatchObject({ handedOff: true, handOffReason: "InvalidTerms" });
    expect(reasonOf(2)).toMatchObject({ handedOff: true, handOffReason: "Reentered" });
    // A router built later with a fourth reason: the hand-off still shows, with no reason rather than a wrong one.
    expect(reasonOf(3)).toMatchObject({ handedOff: true, handOffReason: null });
  });

  it("leaves a native fee to the terms: the amount is the wrapped token's Withdrawal", () => {
    const logs = deliveryLogs(5n, () => [withdrawal(ROUTER, 5n)]);
    expect(routerDeliveryFromLogs(input(5n, logs, { token: WRAPPED }))).toEqual({
      amount: 5n,
      fee: null,
      received: null,
      deliverer: REWARD,
      finalRecipient: null,
      feeSource: "terms",
      payout: "native",
      handedOff: false,
      handOffReason: null,
      handOffRefused: false,
      callFailed: null,
    });
    expect(routerDeliveryFromLogs(input(5n, logs, { token: WRAPPED, feePossible: false }))).toMatchObject({ deliverer: null });
  });

  it("sees a refused coin as a wrapped payout to the recipient", () => {
    const logs = deliveryLogs(5n, () => [withdrawal(ROUTER, 5n), deposit(ROUTER, 4n), transfer(WRAPPED, ROUTER, RECIPIENT, 4n)]);
    expect(routerDeliveryFromLogs(input(5n, logs, { token: WRAPPED }))).toMatchObject({ payout: "wrapped", finalRecipient: RECIPIENT, feeSource: "terms" });
  });

  it("leaves a native fee of a hand-off to the terms", () => {
    const logs = deliveryLogs(5n, () => [withdrawal(ROUTER, 5n), deposit(ROUTER, 4n), deliveryFailed(WRAPPED, RECIPIENT, 4n), transfer(WRAPPED, ROUTER, FAILED, 4n)]);
    expect(routerDeliveryFromLogs(input(5n, logs, { token: WRAPPED }))).toMatchObject({ amount: 5n, fee: null, received: 0n, deliverer: REWARD, feeSource: "terms", handedOff: true });
    expect(routerDeliveryFromLogs(input(5n, logs, { token: WRAPPED, feePossible: false }))).toMatchObject({ deliverer: null });
  });

  it("reads a fee that took the whole value: no payout, so no recipient in the logs", () => {
    const logs = deliveryLogs(100n, () => [transfer(TOKEN, ROUTER, REWARD, 100n)]);
    expect(routerDeliveryFromLogs(input(100n, logs))).toMatchObject({ amount: 100n, fee: 100n, received: 0n, deliverer: REWARD, finalRecipient: null });
  });

  it("reads a transfer log with no data as nothing moved, and an unknown PaidAs as no payout kind", () => {
    const empty = deliveryLogs(0n, () => [{ ...transfer(TOKEN, ROUTER, RECIPIENT, 0n), data: "0x" }]);
    expect(routerDeliveryFromLogs(input(0n, empty))).toMatchObject({ amount: 0n, fee: 0n, received: 0n, finalRecipient: RECIPIENT });
    const odd = deliveryLogs(5n, () => [delivered({ feeTo: REWARD, amount: 5n, fee: 1n, paidOut: 4n, paidAs: 0 })]);
    expect(routerDeliveryFromLogs(input(5n, odd))).toMatchObject({ payout: null, feeSource: "event" });
  });

  it("returns null when the router left no trace", () => {
    const logs = deliveryLogs(100n, () => []);
    expect(routerDeliveryFromLogs(input(100n, logs))).toBeNull();
  });
});

describe("resolveTermsFee", () => {
  const director = (settings: bigint, limit: bigint, multiplier: bigint): Hex =>
    encodeAbiParameters(parseAbiParameters("address, uint256, uint256, uint256, uint256"), [RECIPIENT, settings, limit, multiplier, 0n]);
  const message = (callback: Hex): Hex =>
    encodeFunctionData({ abi: tokenMediatorAbi, functionName: "handleNativeTokensAndCall", args: [WRAPPED, ROUTER, 1_000n, callback, 300_000n] });
  const facts: DeliveryFeeFacts = { deliveryRouter: ROUTER, routerAmount: 1_000n, fee: null, received: null, deliverer: REWARD, finalRecipient: null, feeSource: "terms" };

  it("completes a fixed fee, capped at the amount, and names the recipient of the terms", () => {
    expect(resolveTermsFee(facts, message(director(1n | 2n, 30n, 0n)))).toEqual({ ...facts, fee: 30n, received: 970n, finalRecipient: RECIPIENT });
    expect(resolveTermsFee(facts, message(director(1n | 2n, 5_000n, 0n)))).toMatchObject({ fee: 1_000n, received: 0n });
  });

  it("completes a share of the value (0.1%)", () => {
    expect(resolveTermsFee(facts, message(director(8n | 2n, 0n, ONE / 1_000n)))).toMatchObject({ fee: 1n, received: 999n, deliverer: REWARD });
    expect(resolveTermsFee(facts, message(director(8n | 2n, 0n, 0n)))).toMatchObject({ fee: 0n, received: 1_000n, deliverer: null });
  });

  it("leaves a gas based fee unknown, and keeps the facts when the send is not indexed yet", () => {
    expect(resolveTermsFee(facts, message(director(2n, 10n ** 30n, ONE)))).toEqual({ ...facts, finalRecipient: RECIPIENT });
    expect(resolveTermsFee(facts, null)).toEqual(facts);
  });

  it("takes no fee for the legacy receiver, and none for a direct execution", () => {
    expect(resolveTermsFee(facts, message(RECIPIENT))).toEqual({ ...facts, fee: 0n, received: 1_000n, deliverer: null, finalRecipient: RECIPIENT });
    expect(resolveTermsFee({ ...facts, deliverer: null }, message(director(1n | 2n, 30n, 0n)))).toMatchObject({ fee: 0n, received: 1_000n });
    expect(resolveTermsFee({ ...facts, received: 0n }, message(RECIPIENT))).toMatchObject({ fee: 0n, received: 0n });
  });

  it("keeps a hand-off at nothing received", () => {
    expect(resolveTermsFee({ ...facts, received: 0n }, message(director(1n | 2n, 30n, 0n)))).toMatchObject({ fee: 30n, received: 0n });
  });

  it("passes facts of the other sources, and complete facts, through unchanged", () => {
    const event = { ...facts, feeSource: "event", fee: 3n, received: 997n };
    expect(resolveTermsFee(event, message(director(1n, 30n, 0n)))).toBe(event);
    expect(resolveTermsFee({ ...facts, routerAmount: null }, null)).toEqual({ ...facts, routerAmount: null });
    expect(resolveTermsFee(facts, "0x1234")).toEqual(facts);
  });
});

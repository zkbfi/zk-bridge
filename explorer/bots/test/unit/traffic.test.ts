import { decodeFunctionData, encodeErrorResult, getAddress, type Address } from "viem";
import { describe, expect, it, vi } from "vitest";
import { beaconForkGateAbi, decodeFeeDirector, defaultTip, protectedAddressesOf, tokenMediatorAbi } from "@zk-bridge/shared";
import { boundsOf } from "../../src/traffic/plan.ts";
import { parseTestTokens } from "../../src/traffic/tokens-file.ts";
import { createTraffic, type TrafficSide } from "../../src/traffic/traffic.ts";
import { memoryLogger } from "../support/builders.ts";
import { DOLLAR, PLAIN, copyAddressOf, fakePort, fakeReader, requestLog, tokenFile, type FakePort, type FakeReaderState } from "../support/traffic.ts";

const WALLET = getAddress("0x70997970C51812dc3A010C7d01b50e0d17dc79C8");
const DOLLAR_UNIT = 10n ** 6n;
const MESSAGE_ID = `0x${"cd".repeat(32)}` as const;
const RATE = 10n ** 15n;

function contractsOf(seed: number, router: boolean) {
  const address = (offset: number) => getAddress(`0x${(seed + offset).toString(16).padStart(2, "0").repeat(20)}`);
  return { bridge: address(1), mediator: address(2), tokenFactory: address(3), wrappedNative: address(5), deliveryRouter: router ? address(8) : null };
}

interface World {
  readonly first: { side: TrafficSide; port: FakePort; state: FakeReaderState };
  readonly second: { side: TrafficSide; port: FakePort; state: FakeReaderState };
  readonly logs: ReturnType<typeof memoryLogger>;
  readonly traffic: ReturnType<typeof createTraffic>;
}

function sideOf(chainId: number, seed: number, options: { router?: boolean; reserve?: bigint; newCopyGasLimit?: bigint } = {}) {
  const state: FakeReaderState = { native: 10n ** 18n, balances: new Map(), allowances: new Map() };
  const port = fakePort(chainId, WALLET);
  const side: TrafficSide = {
    chainId,
    name: `chain-${chainId}`,
    reader: fakeReader(chainId, state),
    port,
    contracts: contractsOf(seed, options.router ?? true),
    minimumNativeWei: options.reserve ?? 1_000n,
    newCopyGasLimit: options.newCopyGasLimit ?? null,
  };
  return { side, port, state };
}

function world(options: { secondRouter?: boolean; symbols?: readonly string[]; random?: () => number; newCopyGasLimit?: bigint } = {}): World {
  const first = sideOf(1, 0x10);
  const second = sideOf(369, 0x20, { router: options.secondRouter ?? true, ...(options.newCopyGasLimit === undefined ? {} : { newCopyGasLimit: options.newCopyGasLimit }) });
  const settings = { amount: { minimum: "1", maximum: "25" }, balance: { minimum: "1000", maximum: "900000" } };
  const symbols = options.symbols ?? ["tUSD"];
  const logs = memoryLogger();
  const traffic = createTraffic({
    sides: [first.side, second.side],
    tokens: parseTestTokens(tokenFile([1, 369])),
    bounds: new Map(symbols.map((symbol) => [symbol, (decimals: number) => boundsOf(settings, decimals)] as const)),
    tipRate: RATE,
    protectedAddresses: protectedAddressesOf([
      { name: "one", ...first.side.contracts },
      { name: "two", ...second.side.contracts },
    ]),
    random: options.random ?? (() => 0),
    logger: logs.logger,
  });
  return { first, second, logs, traffic };
}

const announce = () => vi.fn(async () => undefined);
const eventsNamed = (logs: World["logs"], name: string) => logs.events().filter((event) => event.event === name);

describe("a traffic send", () => {
  it("approves the mediator once, then relays the native token with the default tip to the router", async () => {
    const { first, second, logs, traffic } = world();
    first.state.balances.set(DOLLAR.toLowerCase(), 100_000n * DOLLAR_UNIT);
    first.port.receipts.push({}, { logs: [requestLog(first.side.contracts.bridge, MESSAGE_ID)] });
    const beforeFirstSend = announce();

    const outcome = await traffic.attempt({ direction: "first-to-second", beforeFirstSend });

    expect(outcome).toEqual({ kind: "sent", direction: "first-to-second", symbol: "tUSD", token: DOLLAR, amount: DOLLAR_UNIT, transactionHash: `0x${"2".padStart(64, "0")}`, messageId: MESSAGE_ID });
    expect(beforeFirstSend).toHaveBeenCalledTimes(1);
    const [approval, relay] = first.port.sent;
    expect(approval?.to).toBe(DOLLAR);
    expect(relay?.to).toBe(first.side.contracts.mediator);
    const decoded = decodeFunctionData({ abi: tokenMediatorAbi, data: relay!.data });
    expect(decoded.functionName).toBe("relayTokensAndCall");
    const [token, router, amount, terms] = decoded.args as [Address, Address, bigint, `0x${string}`];
    expect([token, router, amount]).toEqual([DOLLAR, second.side.contracts.deliveryRouter, DOLLAR_UNIT]);
    expect(decodeFeeDirector(terms)).toEqual({ ...defaultTip(WALLET), multiplier: RATE });
    // The send terms: the simulated gas plus 30 percent, at twice the base fee plus the tip.
    expect(relay).toMatchObject({ gas: 130_000n, maxFeePerGas: 22n, maxPriorityFeePerGas: 2n });
    expect(eventsNamed(logs, "traffic_approved")).toHaveLength(1);
    expect(eventsNamed(logs, "traffic_sent")[0]).toMatchObject({ direction: "first-to-second", symbol: "tUSD", kind: "native", tokenAddress: DOLLAR, amount: "1000000", amountText: "1", messageId: MESSAGE_ID, gasUsed: "50000", gasCostWei: "600000" });
    expect(second.port.sent).toHaveLength(0);
  });

  it("asks for the configured gas limit when the delivery deploys the copy, and the default once the copy exists", async () => {
    const { first, second, logs, traffic } = world({ newCopyGasLimit: 9_000_000n });
    first.state.balances.set(DOLLAR.toLowerCase(), 100_000n * DOLLAR_UNIT);
    first.state.allowances.set(DOLLAR.toLowerCase(), 10n ** 30n);
    second.state.code = new Set();
    await traffic.attempt({ direction: "first-to-second", beforeFirstSend: announce() });
    const deploying = decodeFunctionData({ abi: tokenMediatorAbi, data: first.port.sent[0]!.data });
    expect(deploying.args).toHaveLength(5);
    expect(deploying.args?.[4]).toBe(9_000_000n);
    expect(eventsNamed(logs, "traffic_sent")[0]).toMatchObject({ deploysCopy: true, messageGasLimit: "9000000" });

    second.state.code.add(copyAddressOf(369, 1, DOLLAR).toLowerCase());
    await traffic.attempt({ direction: "first-to-second", beforeFirstSend: announce() });
    expect(decodeFunctionData({ abi: tokenMediatorAbi, data: first.port.sent[1]!.data }).args).toHaveLength(4);
    expect(eventsNamed(logs, "traffic_sent")[1]).toMatchObject({ deploysCopy: false, messageGasLimit: null });
  });

  it("marks the first send of a token as a deploy message, and holds the token back after it", async () => {
    const { first, logs, traffic } = world();
    first.state.balances.set(DOLLAR.toLowerCase(), 100_000n * DOLLAR_UNIT);
    first.state.allowances.set(DOLLAR.toLowerCase(), 10n ** 30n);
    first.state.records = new Map([[DOLLAR.toLowerCase(), { registered: false, acknowledged: false }]]);
    await traffic.attempt({ direction: "first-to-second", beforeFirstSend: announce() });
    expect(eventsNamed(logs, "traffic_sent")[0]).toMatchObject({ deployMessage: true, deploysCopy: false });
    first.state.records.set(DOLLAR.toLowerCase(), { registered: true, acknowledged: false });
    expect(await traffic.attempt({ direction: "first-to-second", beforeFirstSend: announce() })).toMatchObject({ reason: "no-eligible-token" });
    expect(eventsNamed(logs, "traffic_skipped")[0]).toMatchObject({ candidates: [{ symbol: "tUSD", kind: "native", reason: "waiting-for-first-return" }, { kind: "copy" }] });
  });

  it("logs a send that deploys the copy also without a gas limit for it", async () => {
    const { first, second, logs, traffic } = world();
    first.state.balances.set(DOLLAR.toLowerCase(), 100_000n * DOLLAR_UNIT);
    first.state.allowances.set(DOLLAR.toLowerCase(), 10n ** 30n);
    second.state.code = new Set();
    await traffic.attempt({ direction: "first-to-second", beforeFirstSend: announce() });
    expect(decodeFunctionData({ abi: tokenMediatorAbi, data: first.port.sent[0]!.data }).args).toHaveLength(4);
    expect(eventsNamed(logs, "traffic_sent")[0]).toMatchObject({ deploysCopy: true, messageGasLimit: null });
  });

  it("skips the approval when the allowance covers the amount", async () => {
    const { first, traffic } = world();
    first.state.balances.set(DOLLAR.toLowerCase(), 100_000n * DOLLAR_UNIT);
    first.state.allowances.set(DOLLAR.toLowerCase(), 10n ** 30n);
    const outcome = await traffic.attempt({ direction: "first-to-second", beforeFirstSend: announce() });
    expect(outcome).toMatchObject({ kind: "sent", messageId: null });
    expect(first.port.sent).toHaveLength(1);
  });

  it("sends the bridged copy home in the other direction", async () => {
    const { first, second, traffic } = world();
    const copy = copyAddressOf(369, 1, DOLLAR);
    second.state.balances.set(copy.toLowerCase(), 40n * DOLLAR_UNIT);
    second.state.allowances.set(copy.toLowerCase(), 10n ** 30n);
    // The home balance of the native token is below its band, so the copy goes first.
    first.state.balances.set(DOLLAR.toLowerCase(), 10n * DOLLAR_UNIT);
    const outcome = await traffic.attempt({ direction: "second-to-first", beforeFirstSend: announce() });
    expect(outcome).toMatchObject({ kind: "sent", direction: "second-to-first", symbol: "ztUSD", token: copy });
    const decoded = decodeFunctionData({ abi: tokenMediatorAbi, data: second.port.sent[0]!.data });
    expect(decoded.args?.[1]).toBe(first.side.contracts.deliveryRouter);
  });

  it("skips when the destination has no delivery router", async () => {
    const { logs, traffic } = world({ secondRouter: false });
    expect(await traffic.attempt({ direction: "first-to-second", beforeFirstSend: announce() })).toEqual({ kind: "skipped", direction: "first-to-second", reason: "no-delivery-router" });
    expect(eventsNamed(logs, "traffic_skipped")[0]).toMatchObject({ reason: "no-delivery-router", chain: "chain-369" });
  });

  it("skips when no token can go, and says why for each", async () => {
    const { logs, traffic } = world();
    expect(await traffic.attempt({ direction: "first-to-second", beforeFirstSend: announce() })).toMatchObject({ kind: "skipped", reason: "no-eligible-token" });
    expect(eventsNamed(logs, "traffic_skipped")[0]).toMatchObject({
      candidates: [
        { symbol: "tUSD", kind: "native", reason: "home-balance-at-minimum" },
        { symbol: "tUSD", kind: "copy", reason: "copy-balance-below-amount" },
      ],
    });
  });

  it("skips when the approval would revert", async () => {
    const { first, traffic } = world();
    first.state.balances.set(DOLLAR.toLowerCase(), 100_000n * DOLLAR_UNIT);
    first.port.simulations.set(DOLLAR.toLowerCase(), { ok: false, reason: "paused" });
    expect(await traffic.attempt({ direction: "first-to-second", beforeFirstSend: announce() })).toMatchObject({ reason: "approval-simulation-reverted" });
    expect(first.port.sent).toHaveLength(0);
  });

  it("keeps the native reserve before the approval", async () => {
    const { first, logs, traffic } = world();
    first.state.balances.set(DOLLAR.toLowerCase(), 100_000n * DOLLAR_UNIT);
    // The approval costs at most 130,000 gas at 22 wei: 2,860,000 wei, and the reserve is 1,000.
    first.state.native = 2_860_999n - 1n;
    const beforeFirstSend = announce();
    expect(await traffic.attempt({ direction: "first-to-second", beforeFirstSend })).toMatchObject({ reason: "native-below-reserve" });
    expect(eventsNamed(logs, "traffic_skipped")[0]).toMatchObject({ step: "approval", nativeWei: "2860998", worstCaseWei: "2860000", reserveWei: "1000" });
    expect(beforeFirstSend).not.toHaveBeenCalled();
  });

  it("stops when the approval reverts", async () => {
    const { first, traffic } = world();
    first.state.balances.set(DOLLAR.toLowerCase(), 100_000n * DOLLAR_UNIT);
    first.port.receipts.push({ success: false });
    expect(await traffic.attempt({ direction: "first-to-second", beforeFirstSend: announce() })).toMatchObject({ reason: "approval-reverted" });
    expect(first.port.sent).toHaveLength(1);
  });

  it("names a gate that refuses the relay", async () => {
    const { first, logs, traffic } = world();
    first.state.balances.set(DOLLAR.toLowerCase(), 100_000n * DOLLAR_UNIT);
    first.state.allowances.set(DOLLAR.toLowerCase(), 10n ** 30n);
    const selector = encodeErrorResult({ abi: beaconForkGateAbi, errorName: "ForkNotConfirmed", args: [3n] }).slice(0, 10);
    first.port.simulations.set(first.side.contracts.mediator.toLowerCase(), { ok: false, reason: `Execution reverted (revert data ${selector})` });
    expect(await traffic.attempt({ direction: "first-to-second", beforeFirstSend: announce() })).toMatchObject({ reason: "gate-not-confirmed" });
    expect(eventsNamed(logs, "traffic_skipped")[0]).toMatchObject({ error: "ForkNotConfirmed" });
    expect(first.port.sent).toHaveLength(0);
  });

  it("keeps the native reserve before the relay, counting what the approval spent", async () => {
    const { first, logs, traffic } = world();
    first.state.balances.set(DOLLAR.toLowerCase(), 100_000n * DOLLAR_UNIT);
    // Enough for the approval's worst case, but after it spent 600,000 wei the relay's worst case no longer fits.
    first.state.native = 3_000_000n;
    const beforeFirstSend = announce();
    expect(await traffic.attempt({ direction: "first-to-second", beforeFirstSend })).toMatchObject({ reason: "native-below-reserve" });
    expect(eventsNamed(logs, "traffic_skipped")[0]).toMatchObject({ step: "relay", nativeWei: "2400000" });
    expect(beforeFirstSend).toHaveBeenCalledTimes(1);
    expect(first.port.sent).toHaveLength(1);
  });

  it("reports a relay that reverts on chain", async () => {
    const { first, traffic } = world();
    first.state.balances.set(DOLLAR.toLowerCase(), 100_000n * DOLLAR_UNIT);
    first.state.allowances.set(DOLLAR.toLowerCase(), 10n ** 30n);
    first.port.receipts.push({ success: false });
    expect(await traffic.attempt({ direction: "first-to-second", beforeFirstSend: announce() })).toMatchObject({ reason: "relay-reverted" });
  });
});

describe("the token list for the runner", () => {
  it("lists each configured native token with its copy on the other chain", async () => {
    const { traffic } = world({ symbols: ["tUSD", "tTKN"] });
    const listed = await traffic.describeTokens();
    expect(listed).toEqual([
      { symbol: "tTKN", chainId: 1, address: PLAIN, copyChainId: 369, copyAddress: copyAddressOf(369, 1, PLAIN) },
      { symbol: "tUSD", chainId: 1, address: DOLLAR, copyChainId: 369, copyAddress: copyAddressOf(369, 1, DOLLAR) },
      { symbol: "tTKN", chainId: 369, address: PLAIN, copyChainId: 1, copyAddress: copyAddressOf(1, 369, PLAIN) },
      { symbol: "tUSD", chainId: 369, address: DOLLAR, copyChainId: 1, copyAddress: copyAddressOf(1, 369, DOLLAR) },
    ]);
  });

  it("leaves out tokens of other chains and symbols without settings", async () => {
    const logs = memoryLogger();
    const first = sideOf(1, 0x10);
    const second = sideOf(369, 0x20);
    const traffic = createTraffic({
      sides: [first.side, second.side],
      tokens: parseTestTokens(tokenFile([1, 5])),
      bounds: new Map([["tUSD", (decimals: number) => boundsOf({ amount: { minimum: "1", maximum: "2" }, balance: { minimum: "0", maximum: "9" } }, decimals)]]),
      tipRate: RATE,
      protectedAddresses: [],
      random: () => 0,
      logger: logs.logger,
    });
    expect(await traffic.describeTokens()).toEqual([{ symbol: "tUSD", chainId: 1, address: DOLLAR, copyChainId: 369, copyAddress: copyAddressOf(369, 1, DOLLAR) }]);
    // The tokens of chain 5 are no candidates either: only chain 1's tUSD is, and it has no balance.
    expect(await traffic.attempt({ direction: "second-to-first", beforeFirstSend: announce() })).toMatchObject({ reason: "no-eligible-token" });
  });
});

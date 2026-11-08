import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getAddress, keccak256, parseTransaction, type Address, type Hex, type PublicClient } from "viem";
import { afterEach, describe, expect, it, vi } from "vitest";
import { signerFromPrivateKeyText } from "../../../terminal/src/signing/key-sources.ts";
import { BotConfigError, parseBotConfig } from "../../src/config/bot-config.ts";
import { LockHeldError } from "../../src/runtime/lock-file.ts";
import { gateBeaconUrlOf, ignoredScheduleSettings, SKIP_RETRIES, startTraffic, tipRateOf, type TrafficOverrides } from "../../src/traffic/service.ts";
import { HOUR_MILLISECONDS } from "../../src/traffic/schedule.ts";
import { seeded } from "../support/seeded.ts";
import { createServiceWorld, type ServiceWorld } from "../support/service-world.ts";
import { DOLLAR, copyAddressOf, fakeReader, requestLog, tokenFile, type FakeReaderState } from "../support/traffic.ts";

// The first public development key of Anvil. It holds no funds on a live chain.
const SIGNER_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const SIGNER_ADDRESS = getAddress("0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266");
const MESSAGE_ID = `0x${"ef".repeat(32)}` as const;
/** The contracts of the service world's deployment file (`test/support/service-world.ts`). */
const MEDIATOR = { 1: getAddress(`0x${"12".repeat(20)}`), 369: getAddress(`0x${"22".repeat(20)}`) } as const;
const BRIDGE = { 1: getAddress(`0x${"11".repeat(20)}`), 369: getAddress(`0x${"21".repeat(20)}`) } as const;
/** An hour of the clock, and a moment in it. */
const HOUR = 480_000;
const HOUR_START = HOUR * HOUR_MILLISECONDS;
const NOW = HOUR_START + 1_000;

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (closers.length > 0) await closers.pop()?.();
});

function trafficSection(world: { directory: string }, extra: Record<string, unknown> = {}) {
  return {
    traffic: {
      signer: { kind: "private-key", key: "env:TRAFFIC_KEY" },
      tokensFile: join(world.directory, "test-tokens.json"),
      tokens: { tUSD: { amount: { minimum: "1", maximum: "25" }, balance: { minimum: "1000", maximum: "900000" } } },
      minimumNativeWei: { "1": "1000", "369": "1000" },
      pollSeconds: 1,
      ...extra,
    },
  };
}

async function prepare(extra: Record<string, unknown> = {}, options: { tokens?: unknown } = {}): Promise<ServiceWorld> {
  const holder = { directory: "" };
  const created = await createServiceWorld({
    config: { traffic: undefined },
    environment: { TRAFFIC_KEY: SIGNER_KEY },
  });
  closers.push(created.cleanup);
  holder.directory = created.directory;
  await writeFile(join(created.directory, "test-tokens.json"), JSON.stringify(options.tokens ?? tokenFile([1, 369])));
  // The context is loaded already: put the traffic section into it, through the same parser as the file.
  const config = parseBotConfig({ schemaVersion: 1, stateDirectory: join(created.directory, "state"), ...trafficSection(holder, extra) });
  Object.assign(created.context, { config: { ...created.context.config, traffic: config.traffic } });
  return created;
}

/**
 * A chain node for the real transaction port: it answers the fee and gas questions, takes raw transactions, and gives a
 * receipt for each. A relay to the mediator gets the bridge's `UserRequestForAffirmation` log.
 */
function fakeNode(chainId: 1 | 369) {
  const sent: Array<{ to: Address; data: Hex }> = [];
  const client = {
    getBlock: vi.fn(async () => ({ baseFeePerGas: 10n })),
    estimateMaxPriorityFeePerGas: vi.fn(async () => 2n),
    call: vi.fn(async () => ({ data: "0x" })),
    estimateGas: vi.fn(async () => 100_000n),
    getTransactionCount: vi.fn(async () => sent.length),
    sendRawTransaction: vi.fn(async ({ serializedTransaction }: { serializedTransaction: Hex }) => {
      const parsed = parseTransaction(serializedTransaction);
      sent.push({ to: getAddress(parsed.to as Address), data: parsed.data as Hex });
      return keccak256(serializedTransaction);
    }),
    waitForTransactionReceipt: vi.fn(async ({ hash }: { hash: Hex }) => {
      const last = sent[sent.length - 1] as { to: Address };
      const logs = last.to === MEDIATOR[chainId] ? [{ ...requestLog(BRIDGE[chainId], MESSAGE_ID), topics: requestLog(BRIDGE[chainId], MESSAGE_ID).topics }] : [];
      return { status: "success", gasUsed: 60_000n, effectiveGasPrice: 12n, blockNumber: 9n, logs, transactionHash: hash };
    }),
    getBalance: vi.fn(async () => 0n),
    getCode: vi.fn(async () => "0x6080"),
    readContract: vi.fn(async ({ address, args }: { address: Address; functionName: string; args: readonly unknown[] }) => {
      if (address === getAddress(`0x${chainId === 1 ? "13" : "23"}`.padEnd(42, chainId === 1 ? "13" : "23"))) return copyAddressOf(chainId, Number(args[0]), args[1] as Address);
      return 0n;
    }),
  };
  return { client: client as unknown as PublicClient, sent };
}

/** Readers whose balances the test sets, one per chain, and a node for each chain. */
function overridesFor(extra: TrafficOverrides = {}) {
  const states: Record<number, FakeReaderState> = {
    1: { native: 10n ** 18n, balances: new Map([[DOLLAR.toLowerCase(), 100_000n * 10n ** 6n]]), allowances: new Map() },
    369: { native: 10n ** 18n, balances: new Map([[DOLLAR.toLowerCase(), 100_000n * 10n ** 6n]]), allowances: new Map() },
  };
  const nodes = { 1: fakeNode(1), 369: fakeNode(369) };
  const signer = signerFromPrivateKeyText(SIGNER_KEY);
  const dispose = vi.spyOn(signer, "dispose");
  const urls: string[] = [];
  const overrides: TrafficOverrides = {
    signer,
    publicClient: (rpcUrl) => {
      urls.push(rpcUrl);
      return (rpcUrl.endsWith(":1") ? nodes[1] : nodes[369]).client;
    },
    reader: (chainId) => fakeReader(chainId, states[chainId] as FakeReaderState),
    gate: () => null,
    random: () => 0,
    now: () => NOW,
    ...extra,
  };
  return { overrides, states, nodes, dispose, urls };
}

function run(created: ServiceWorld, overrides: TrafficOverrides | undefined, options: { runOnce?: boolean; signal?: AbortSignal } = {}) {
  return startTraffic({ context: created.context, signal: options.signal ?? new AbortController().signal, runOnce: options.runOnce ?? true, ...(overrides === undefined ? {} : { overrides }) });
}

const statePath = (created: ServiceWorld) => join(created.directory, "state", "traffic-eth-pls.json");
const named = (created: ServiceWorld, name: string) => created.events().filter((event) => event.event === name);

describe("tipRateOf", () => {
  it("reads a percentage as a share scaled by 1e18", () => {
    expect(tipRateOf("0.1")).toBe(10n ** 15n);
    expect(tipRateOf("100")).toBe(10n ** 18n);
  });

  it("refuses a share above 100 percent", () => {
    expect(() => tipRateOf("100.5")).toThrow(new BotConfigError("traffic.tipPercent 100.5 is above 100 percent."));
  });
});

describe("the traffic configuration", () => {
  const parse = (extra: Record<string, unknown>) => parseBotConfig({ schemaVersion: 1, stateDirectory: "/s", ...trafficSection({ directory: "/d" }, extra) }).traffic!;

  it("fills the defaults: 0 to 3 sends an hour in each direction, five minutes apart at least", () => {
    const parsed = parse({});
    expect(parsed).toMatchObject({ cadence: { minPerHour: 0, maxPerHour: 3, minGapSeconds: 300 }, tipPercent: "0.1", receiptTimeoutSeconds: 300, minimumPriorityFeeWei: {} });
    expect(parsed.directions).toEqual({ "first-to-second": { enabled: true }, "second-to-first": { enabled: true } });
    expect(ignoredScheduleSettings(parsed)).toEqual([]);
  });

  it("takes a partial cadence and fills the rest", () => {
    expect(parse({ cadence: { maxPerHour: 5, minGapSeconds: 60 } }).cadence).toEqual({ minPerHour: 0, maxPerHour: 5, minGapSeconds: 60 });
    expect(parse({ cadence: { minPerHour: 0, maxPerHour: 0 } }).cadence.maxPerHour).toBe(0);
    expect(parse({ cadence: { maxPerHour: 1, minGapSeconds: 5000 } }).cadence.minGapSeconds).toBe(5000);
  });

  it("refuses a maximum below the minimum, a count that cannot fit with the gap, and negatives", () => {
    expect(() => parse({ cadence: { minPerHour: 2, maxPerHour: 1 } })).toThrow(/config.traffic.cadence: maxPerHour must not be below minPerHour/);
    expect(() => parse({ cadence: { maxPerHour: 3, minGapSeconds: 1800 } })).toThrow(/config.traffic.cadence: maxPerHour sends cannot fit in one hour/);
    expect(() => parse({ cadence: { maxPerHour: 61, minGapSeconds: 60 } })).toThrow(/cannot fit in one hour/);
    expect(() => parse({ cadence: { minPerHour: -1 } })).toThrow(/config.traffic.cadence.minPerHour/);
    expect(() => parse({ cadence: { maxPerHour: -1 } })).toThrow(/config.traffic.cadence.maxPerHour/);
    expect(() => parse({ cadence: { minGapSeconds: -1 } })).toThrow(/config.traffic.cadence.minGapSeconds/);
    expect(() => parse({ cadence: { maxPerHour: 1.5 } })).toThrow(/config.traffic.cadence.maxPerHour/);
    expect(() => parse({ cadence: { unknown: 1 } })).toThrow(/config.traffic.cadence/);
  });

  it("still accepts the removed interval, jitter and offsets, and names them", () => {
    const parsed = parse({ intervalSeconds: 900, jitterSeconds: 60, directions: { "first-to-second": { enabled: true, offsetSeconds: 0 }, "second-to-first": { enabled: false, offsetSeconds: 450 } } });
    expect(ignoredScheduleSettings(parsed)).toEqual(["intervalSeconds", "jitterSeconds", "directions.first-to-second.offsetSeconds", "directions.second-to-first.offsetSeconds"]);
    expect(parsed.directions["second-to-first"].enabled).toBe(false);
  });

  it("refuses bounds whose minimum is above the maximum, and an empty token list", () => {
    const tokens = { tUSD: { amount: { minimum: "5", maximum: "1" }, balance: { minimum: "0", maximum: "1" } } };
    expect(() => parseBotConfig({ schemaVersion: 1, stateDirectory: "/s", ...trafficSection({ directory: "/d" }, { tokens }) })).toThrow(/config.traffic.tokens.tUSD.amount: minimum must not be above maximum/);
    expect(() => parseBotConfig({ schemaVersion: 1, stateDirectory: "/s", ...trafficSection({ directory: "/d" }, { tokens: {} }) })).toThrow(/config.traffic.tokens: name at least one token/);
  });
});

describe("startTraffic refuses to start", () => {
  it("without a traffic section", async () => {
    const created = await createServiceWorld();
    closers.push(created.cleanup);
    await expect(run(created, overridesFor().overrides)).rejects.toThrow(new BotConfigError("The bot configuration has no traffic section."));
    expect(existsSync(`${statePath(created)}.lock`)).toBe(false);
  });

  it("without a native reserve for each chain", async () => {
    const created = await prepare({ minimumNativeWei: { "1": "5" } });
    await expect(run(created, overridesFor().overrides)).rejects.toThrow("traffic.minimumNativeWei has no entry for chain 369 (pulsechain).");
  });

  it("when the test token file lacks a configured symbol", async () => {
    const created = await prepare({ tokens: { tDAI: { amount: { minimum: "1", maximum: "2" }, balance: { minimum: "0", maximum: "5" } } } });
    await expect(run(created, overridesFor().overrides)).rejects.toThrow(/traffic.tokens.tDAI: the test token file .* lists no token tDAI/);
  });

  it("while a live process holds the lock", async () => {
    const created = await prepare();
    await mkdir(join(created.directory, "state"), { recursive: true });
    await writeFile(`${statePath(created)}.lock`, `${process.pid}\n`);
    await expect(run(created, overridesFor().overrides)).rejects.toBeInstanceOf(LockHeldError);
  });
});

describe("startTraffic", () => {
  it("with --once sends in each direction now, leaves the plan alone, logs the tokens and disposes of the signer", async () => {
    const created = await prepare({ minimumPriorityFeeWei: { "369": "7" } });
    const { overrides, nodes, dispose, urls } = overridesFor();
    await run(created, overrides);

    expect(urls).toEqual(["http://127.0.0.1:1", "http://127.0.0.1:2"]);
    // Each chain: an approval, then the relay to the mediator.
    expect(nodes[1].sent.map((sent) => sent.to)).toEqual([DOLLAR, MEDIATOR[1]]);
    expect(nodes[369].sent.map((sent) => sent.to)).toEqual([DOLLAR, MEDIATOR[369]]);
    const sends = named(created, "traffic_sent");
    expect(sends.map((event) => event.direction)).toEqual(["first-to-second", "second-to-first"]);
    expect(sends[0]).toMatchObject({ bot: "traffic", pair: "eth-pls", symbol: "tUSD", messageId: MESSAGE_ID });
    expect(named(created, "traffic_started")[0]).toMatchObject({ wallet: SIGNER_ADDRESS, signer: "private-key", cadence: { minPerHour: 0, maxPerHour: 3, minGapSeconds: 300 }, tipPercent: "0.1" });
    expect(named(created, "traffic_hour_planned")).toEqual([]);
    expect(named(created, "config_ignored")).toEqual([]);
    expect((named(created, "traffic_tokens")[0]?.tokens as unknown[]).length).toBe(2);
    const state = JSON.parse(readFileSync(statePath(created), "utf8"));
    expect(state.directions["first-to-second"]).toEqual({ plan: null, lastAttemptAtMilliseconds: NOW });
    expect(state.directions["second-to-first"]).toEqual({ plan: null, lastAttemptAtMilliseconds: NOW });
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(existsSync(`${statePath(created)}.lock`)).toBe(false);
  });

  it("looks at the gate of the source chain before each send, and sends no confirmation to a gate that does not enforce", async () => {
    const created = await prepare();
    const sleep = vi.fn(async () => undefined);
    const { overrides, nodes } = overridesFor({ gate: undefined, sleep });
    const gateReads: Record<string, unknown> = { mode: 1, enforcing: false, isSealed: false, confirmedEpoch: [0n, false], genesisTime: 1n, secondsPerSlot: 12n, slotsPerEpoch: 32n, genesisValidatorsRoot: `0x${"ab".repeat(32)}`, beaconRoots: "0x000F3df6D732807Ef1319fB7B8bB8522d0Beac02" };
    for (const [chainId, gate] of [[1, `0x${"16".repeat(20)}`], [369, `0x${"26".repeat(20)}`]] as const) {
      const client = nodes[chainId].client as unknown as { readContract: ReturnType<typeof vi.fn>; getBlock: ReturnType<typeof vi.fn> };
      const plain = client.readContract.getMockImplementation() as (call: unknown) => Promise<unknown>;
      client.readContract.mockImplementation(async (call: { address: Address; functionName: string }) => (call.address.toLowerCase() === gate ? gateReads[call.functionName] : plain(call)));
      client.getBlock.mockImplementation(async () => ({ number: 9n, timestamp: 1_000n, baseFeePerGas: 10n }));
    }
    await run(created, overrides);
    expect(nodes[1].sent.map((sent) => sent.to)).toEqual([DOLLAR, MEDIATOR[1]]);
    expect(named(created, "traffic_sent")).toHaveLength(2);
    expect(named(created, "gate_confirmed")).toEqual([]);
    const gateCalls = (nodes[1].client.readContract as ReturnType<typeof vi.fn>).mock.calls.filter(([call]) => (call as { address: string }).address.toLowerCase() === `0x${"16".repeat(20)}`);
    expect(gateCalls.map(([call]) => (call as { functionName: string }).functionName)).toContain("enforcing");
    expect(sleep).not.toHaveBeenCalled();
  });

  it("takes the beacon API of the gate from its setting, else from the pair", () => {
    const parsed = parseBotConfig({ schemaVersion: 1, stateDirectory: "/s", ...trafficSection({ directory: "/d" }, { gateBeaconUrls: { "1": "https://lodestar.example" } }) }).traffic!;
    expect(gateBeaconUrlOf(parsed, { chainId: 1, beaconUrl: "http://pair" })).toBe("https://lodestar.example");
    expect(gateBeaconUrlOf(parsed, { chainId: 369, beaconUrl: "http://pair" })).toBe("http://pair");
    expect(gateBeaconUrlOf(parsed, { chainId: 369, beaconUrl: null })).toBeNull();
    expect(() => parseBotConfig({ schemaVersion: 1, stateDirectory: "/s", ...trafficSection({ directory: "/d" }, { gateBeaconUrls: { "1": "not a url" } }) })).toThrow();
  });

  it("accepts and ignores the removed newCopyGasLimit setting: a send needs no gas number for a copy", () => {
    expect(() => parseBotConfig({ schemaVersion: 1, stateDirectory: "/s", ...trafficSection({ directory: "/d" }, { newCopyGasLimit: { "1": "9000000" } }) })).not.toThrow();
  });

  it("raises the tip on chain 369 to its minimum and uses a fixed priority fee where one is set", async () => {
    const created = await prepare({ priorityFeeWei: "1" });
    const { overrides, nodes } = overridesFor();
    await run(created, overrides);
    expect(nodes[1].client.estimateMaxPriorityFeePerGas).not.toHaveBeenCalled();
    const relay369 = (nodes[369].client.sendRawTransaction as ReturnType<typeof vi.fn>).mock.calls[1]?.[0] as { serializedTransaction: Hex };
    expect(parseTransaction(relay369.serializedTransaction).maxPriorityFeePerGas).toBe(10_000_000n);
  });

  it("with --once records a skipped attempt", async () => {
    const created = await prepare({ directions: { "first-to-second": { enabled: true }, "second-to-first": { enabled: false } } });
    const { overrides, states, nodes } = overridesFor();
    states[1]!.balances.clear();
    await run(created, overrides);
    expect(named(created, "traffic_skipped")[0]).toMatchObject({ direction: "first-to-second", reason: "no-eligible-token" });
    expect(JSON.parse(readFileSync(statePath(created), "utf8")).directions).toEqual({ "first-to-second": { plan: null, lastAttemptAtMilliseconds: NOW }, "second-to-first": null });
    expect(nodes[1].sent).toHaveLength(0);
  });

  it("warns once at start about the removed interval settings and starts", async () => {
    const created = await prepare({ intervalSeconds: 900, jitterSeconds: 60, directions: { "first-to-second": { enabled: true, offsetSeconds: 0 }, "second-to-first": { enabled: true, offsetSeconds: 450 } } });
    await run(created, overridesFor().overrides);
    expect(named(created, "config_ignored")).toHaveLength(1);
    expect(named(created, "config_ignored")[0]).toMatchObject({ level: "warn", settings: ["intervalSeconds", "jitterSeconds", "directions.first-to-second.offsetSeconds", "directions.second-to-first.offsetSeconds"] });
    expect(named(created, "traffic_sent")).toHaveLength(2);
  });

  it("reads a state file from before the hourly plans", async () => {
    const created = await prepare();
    await mkdir(join(created.directory, "state"), { recursive: true });
    await writeFile(statePath(created), JSON.stringify({ schemaVersion: 1, directions: { "first-to-second": { lastSlot: 4, lastAttemptAtMilliseconds: 7 }, "second-to-first": null } }));
    await run(created, overridesFor().overrides);
    expect(named(created, "traffic_sent")).toHaveLength(2);
  });
});

describe("startTraffic on the hourly plan", () => {
  const T0 = HOUR_START + 1_650_000;
  const GAP = 300_000;
  /** A random source that always answers one value: 0.5 draws two sends, at T0 and T0 plus the gap. */
  const half = () => 0.5;
  const stateOf = (created: ServiceWorld) => JSON.parse(readFileSync(statePath(created), "utf8")).directions;

  /** Runs the loop until its log stops growing, then stops it: one or two passes of a bot with a one second poll. */
  async function pass(created: ServiceWorld, overrides: TrafficOverrides, now: number): Promise<void> {
    const controller = new AbortController();
    const running = run(created, { ...overrides, now: () => now }, { runOnce: false, signal: controller.signal });
    let size = -1;
    for (let waited = 0; waited < 500; waited += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      const next = created.logLines.length;
      if (next === size && waited > 5) break;
      size = next;
    }
    controller.abort();
    await running;
  }

  it("plans the hour at its start, sends at the planned times, and a restart resumes the same plan without sending twice", async () => {
    const created = await prepare();
    const { overrides, nodes } = overridesFor({ random: half });

    await pass(created, overrides, NOW);
    const planned = named(created, "traffic_hour_planned");
    expect(planned.map((event) => event.direction)).toEqual(["first-to-second", "second-to-first"]);
    expect(planned[0]).toMatchObject({ hour: HOUR, count: 2, times: [new Date(T0).toISOString(), new Date(T0 + GAP).toISOString()] });
    expect(stateOf(created)["first-to-second"].plan).toEqual({ hour: HOUR, count: 2, times: [T0, T0 + GAP], sent: [false, false] });
    expect(named(created, "traffic_sent")).toHaveLength(0);

    await pass(created, overrides, T0);
    expect(named(created, "traffic_sent").map((event) => event.direction)).toEqual(["first-to-second", "second-to-first"]);
    expect(stateOf(created)["first-to-second"]).toMatchObject({ plan: { sent: [true, false] }, lastAttemptAtMilliseconds: T0 });
    const sentOnChain = nodes[1].sent.length + nodes[369].sent.length;

    // A restart a minute later: the same plan, nothing planned, nothing sent (the second time has not come).
    await pass(created, overrides, T0 + 60_000);
    expect(named(created, "traffic_hour_planned")).toHaveLength(2);
    expect(named(created, "traffic_sent")).toHaveLength(2);
    expect(nodes[1].sent.length + nodes[369].sent.length).toBe(sentOnChain);

    // The second time sends, and no third ever does.
    await pass(created, overrides, T0 + GAP);
    expect(named(created, "traffic_sent")).toHaveLength(4);
    await pass(created, overrides, HOUR_START + HOUR_MILLISECONDS - 1);
    expect(named(created, "traffic_sent")).toHaveLength(4);
    expect(named(created, "traffic_hour_skipped")).toEqual([]);
  });

  it("plans an hour with no send and sends nothing in it", async () => {
    const created = await prepare();
    const { overrides, nodes } = overridesFor({ random: () => 0 });
    await pass(created, overrides, NOW);
    await pass(created, overrides, HOUR_START + HOUR_MILLISECONDS - 1);
    expect(named(created, "traffic_hour_planned")).toMatchObject([{ count: 0, times: [] }, { count: 0, times: [] }]);
    expect(nodes[1].sent).toHaveLength(0);
    expect(nodes[369].sent).toHaveLength(0);
  });

  it("draws a new plan in the next hour, and logs what the last one still held as skipped", async () => {
    const created = await prepare();
    const { overrides } = overridesFor({ random: half });
    await pass(created, overrides, NOW);
    // The bot was down through both times and the rest of the hour.
    await pass(created, overrides, HOUR_START + HOUR_MILLISECONDS + 5);
    expect(named(created, "traffic_sent")).toHaveLength(0);
    const skipped = named(created, "traffic_hour_skipped");
    expect(skipped).toHaveLength(2);
    expect(skipped[0]).toMatchObject({ level: "warn", direction: "first-to-second", hour: HOUR, planned: 2, unsent: 2, hoursMissed: 0 });
    const planned = named(created, "traffic_hour_planned");
    expect(planned).toHaveLength(4);
    expect(planned[2]).toMatchObject({ hour: HOUR + 1, count: 2 });
    expect(stateOf(created)["first-to-second"].plan.hour).toBe(HOUR + 1);
  });

  it("names the hours that passed whole, and skips a fully used plan without a warning", async () => {
    const created = await prepare({ directions: { "first-to-second": { enabled: true }, "second-to-first": { enabled: false } } });
    const { overrides } = overridesFor({ random: half });
    await pass(created, overrides, NOW);
    await pass(created, overrides, T0 + GAP);
    expect(named(created, "traffic_sent")).toHaveLength(1);
    await pass(created, overrides, T0 + GAP + 1);
    // Two sends are planned and one is used. Three hours later: skipped, with two whole hours missed.
    await pass(created, overrides, HOUR_START + 3 * HOUR_MILLISECONDS);
    expect(named(created, "traffic_hour_skipped")).toMatchObject([{ hour: HOUR, unsent: 1, hoursMissed: 2 }]);
  });

  it("warns about a missed whole hour even when the plan was used up", async () => {
    const created = await prepare({ directions: { "first-to-second": { enabled: true }, "second-to-first": { enabled: false } } });
    await mkdir(join(created.directory, "state"), { recursive: true });
    await writeFile(statePath(created), JSON.stringify({ schemaVersion: 1, directions: { "first-to-second": { plan: { hour: HOUR - 5, count: 0, times: [], sent: [] }, lastAttemptAtMilliseconds: null }, "second-to-first": null } }));
    await pass(created, overridesFor({ random: half }).overrides, NOW);
    expect(named(created, "traffic_hour_skipped")).toMatchObject([{ hour: HOUR - 5, planned: 0, unsent: 0, hoursMissed: 4 }]);
  });

  it("does not catch up an hour that is only one behind and fully used", async () => {
    const created = await prepare({ directions: { "first-to-second": { enabled: true }, "second-to-first": { enabled: false } } });
    await mkdir(join(created.directory, "state"), { recursive: true });
    await writeFile(statePath(created), JSON.stringify({ schemaVersion: 1, directions: { "first-to-second": { plan: { hour: HOUR - 1, count: 1, times: [HOUR_START - 10], sent: [true] }, lastAttemptAtMilliseconds: HOUR_START - 10 }, "second-to-first": null } }));
    await pass(created, overridesFor({ random: () => 0 }).overrides, NOW);
    expect(named(created, "traffic_hour_skipped")).toEqual([]);
    expect(named(created, "traffic_hour_planned")).toHaveLength(1);
  });

  it("waits when the stored plan is for a later hour (the clock went back)", async () => {
    const created = await prepare({ directions: { "first-to-second": { enabled: true }, "second-to-first": { enabled: false } } });
    await mkdir(join(created.directory, "state"), { recursive: true });
    const stored = { plan: { hour: HOUR + 1, count: 1, times: [HOUR_START + HOUR_MILLISECONDS + 5], sent: [false] }, lastAttemptAtMilliseconds: null };
    await writeFile(statePath(created), JSON.stringify({ schemaVersion: 1, directions: { "first-to-second": stored, "second-to-first": null } }));
    await pass(created, overridesFor({ random: half }).overrides, NOW);
    expect(named(created, "traffic_hour_planned")).toEqual([]);
    expect(stateOf(created)["first-to-second"]).toEqual(stored);
  });

  it("uses up a planned time with a skip, so the next pass does not try again", async () => {
    const created = await prepare({ directions: { "first-to-second": { enabled: true }, "second-to-first": { enabled: false } } });
    const { overrides, states, nodes } = overridesFor({ random: half });
    states[1]!.balances.clear();
    await pass(created, overrides, NOW);
    await pass(created, overrides, T0);
    await pass(created, overrides, T0 + 1_000);
    expect(named(created, "traffic_skipped")).toHaveLength(1);
    expect(stateOf(created)["first-to-second"]).toMatchObject({ plan: { sent: [true, false] }, lastAttemptAtMilliseconds: T0 });
    expect(nodes[1].sent).toHaveLength(0);
  });

  it("sends a time that came while it was down late, and the next only after the gap", async () => {
    const created = await prepare({ directions: { "first-to-second": { enabled: true }, "second-to-first": { enabled: false } } });
    const { overrides } = overridesFor({ random: half });
    await pass(created, overrides, NOW);
    await pass(created, overrides, T0 + GAP + 10);
    expect(named(created, "traffic_sent")).toHaveLength(1);
    await pass(created, overrides, T0 + GAP + 20);
    expect(named(created, "traffic_sent")).toHaveLength(1);
    await pass(created, overrides, T0 + 2 * GAP + 10);
    expect(named(created, "traffic_sent")).toHaveLength(2);
  });

  it("makes the same plans for the same seed", async () => {
    const plansOf = async (seed: number) => {
      const created = await prepare();
      await pass(created, overridesFor({ random: seeded(seed) }).overrides, NOW);
      return named(created, "traffic_hour_planned").map((event) => ({ direction: event.direction, count: event.count, times: event.times }));
    };
    const first = await plansOf(5);
    expect(await plansOf(5)).toEqual(first);
    expect(first).toHaveLength(2);
  });
});

describe("startTraffic, skips that a later try mends", () => {
  const T0 = HOUR_START + 1_650_000;
  const GAP = 300_000;
  const half = () => 0.5;
  const stateOf = (created: ServiceWorld) => JSON.parse(readFileSync(statePath(created), "utf8")).directions;

  /** A gate on chain 1 that has no header for the epoch. An attempt looks at it four times (the first look and three waits): the clock moves one gap and a second in all. */
  function waitingGate(clock: { at: number }) {
    return (chainId: number) =>
      chainId === 1
        ? { ensure: async () => ((clock.at += (GAP + 1_000) / 4), { kind: "wait" as const, epoch: 6n, headerEpoch: 5n, retryAfterSeconds: 0 }) }
        : null;
  }

  it("gives the send back to the plan in the same hour, and uses it up after the limit", async () => {
    const created = await prepare({ directions: { "first-to-second": { enabled: true }, "second-to-first": { enabled: false } } });
    const clock = { at: T0 };
    const { overrides } = overridesFor({ random: half, gate: waitingGate(clock), sleep: async () => undefined, now: () => clock.at });
    const controller = new AbortController();
    const running = run(created, overrides, { runOnce: false, signal: controller.signal });
    for (let waited = 0; waited < 600 && named(created, "traffic_skipped").length < SKIP_RETRIES + 1; waited += 1) await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort();
    await running;
    const skipped = named(created, "traffic_skipped").slice(0, SKIP_RETRIES + 1);
    expect(skipped.map((event) => event.reason)).toEqual(Array(SKIP_RETRIES + 1).fill("gate-epoch-has-no-header"));
    expect(named(created, "traffic_retry_planned").slice(0, SKIP_RETRIES).map((event) => event.retry)).toEqual([1, 2, 3]);
    // The first planned send was tried again and again, then used up: the next try belongs to the second time.
    expect(stateOf(created)["first-to-second"].plan.sent[0]).toBe(true);
  });

  it("does not give back a send of --once, which has no plan", async () => {
    const created = await prepare({ directions: { "first-to-second": { enabled: true }, "second-to-first": { enabled: false } } });
    const clock = { at: NOW };
    const { overrides } = overridesFor({ gate: waitingGate(clock), sleep: async () => undefined, now: () => clock.at });
    await run(created, overrides);
    expect(named(created, "traffic_skipped")).toHaveLength(1);
    expect(named(created, "traffic_retry_planned")).toEqual([]);
  });
});

describe("startTraffic, failures", () => {
  it("logs a direction that fails and goes on with the other", async () => {
    const created = await prepare();
    const { overrides, states } = overridesFor();
    const failing = fakeReader(1, states[1]!);
    let calls = 0;
    const broken = {
      ...failing,
      tokenBalance: async (token: Address, account: Address) => {
        // The start lists the tokens without balances; the first balance read is the forward attempt.
        calls += 1;
        if (calls === 1) throw new Error("rpc down");
        return failing.tokenBalance(token, account);
      },
    };
    await run(created, { ...overrides, reader: (chainId) => (chainId === 1 ? broken : fakeReader(369, states[369]!)) });
    expect(named(created, "traffic_failed")[0]).toMatchObject({ direction: "first-to-second", error: { message: "rpc down" } });
    expect(named(created, "traffic_sent").map((event) => event.direction)).toEqual(["second-to-first"]);
    expect(JSON.parse(readFileSync(statePath(created), "utf8")).directions["first-to-second"]).toBeNull();
  });

  it("opens the signer of the configuration and reads the chain through the client when nothing replaces them", async () => {
    const created = await prepare();
    const { nodes } = overridesFor();
    await run(created, { publicClient: (rpcUrl) => (rpcUrl.endsWith(":1") ? nodes[1] : nodes[369]).client });
    expect(named(created, "traffic_started")[0]).toMatchObject({ wallet: SIGNER_ADDRESS });
    // The real reader finds no balance, so both directions skip.
    expect(named(created, "traffic_skipped").map((event) => event.reason)).toEqual(["no-eligible-token", "no-eligible-token"]);
  });

  it("uses http clients by default, and stops when the chain does not answer", async () => {
    const created = await prepare();
    await expect(run(created, undefined)).rejects.toThrow();
    expect(existsSync(`${statePath(created)}.lock`)).toBe(false);
  });
});

import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getAddress, keccak256, parseTransaction, type Address, type Hex, type PublicClient } from "viem";
import { afterEach, describe, expect, it, vi } from "vitest";
import { signerFromPrivateKeyText } from "../../../terminal/src/signing/key-sources.ts";
import { BotConfigError, parseBotConfig } from "../../src/config/bot-config.ts";
import { LockHeldError } from "../../src/runtime/lock-file.ts";
import { newCopyGasLimitOf, scheduleOf, startTraffic, tipRateOf, type TrafficOverrides } from "../../src/traffic/service.ts";
import { dueAt } from "../../src/traffic/schedule.ts";
import { createServiceWorld, type ServiceWorld } from "../support/service-world.ts";
import { DOLLAR, copyAddressOf, fakeReader, requestLog, tokenFile, type FakeReaderState } from "../support/traffic.ts";

// The first public development key of Anvil. It holds no funds on a live chain.
const SIGNER_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const SIGNER_ADDRESS = getAddress("0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266");
const MESSAGE_ID = `0x${"ef".repeat(32)}` as const;
/** The contracts of the service world's deployment file (`test/support/service-world.ts`). */
const MEDIATOR = { 1: getAddress(`0x${"12".repeat(20)}`), 369: getAddress(`0x${"22".repeat(20)}`) } as const;
const BRIDGE = { 1: getAddress(`0x${"11".repeat(20)}`), 369: getAddress(`0x${"21".repeat(20)}`) } as const;
const SLOT = 480_000;

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
    random: () => 0,
    now: () => dueAt("first-to-second", SLOT, { intervalMilliseconds: 900_000, offsetMilliseconds: 0, jitterMilliseconds: 60_000 }),
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
  it("fills the defaults: four sends an hour in each direction, seven and a half minutes apart", () => {
    const parsed = parseBotConfig({ schemaVersion: 1, stateDirectory: "/s", ...trafficSection({ directory: "/d" }) }).traffic!;
    expect(parsed).toMatchObject({ intervalSeconds: 900, jitterSeconds: 60, tipPercent: "0.1", receiptTimeoutSeconds: 300, minimumPriorityFeeWei: {} });
    expect(parsed.directions).toEqual({ "first-to-second": { enabled: true, offsetSeconds: 0 }, "second-to-first": { enabled: true, offsetSeconds: 450 } });
    expect(scheduleOf(parsed, "second-to-first")).toEqual({ intervalMilliseconds: 900_000, offsetMilliseconds: 450_000, jitterMilliseconds: 60_000 });
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
  it("with --once sends in each direction now, records the slots, logs the tokens and disposes of the signer", async () => {
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
    expect(named(created, "traffic_started")[0]).toMatchObject({ wallet: SIGNER_ADDRESS, signer: "private-key", intervalSeconds: 900, tipPercent: "0.1" });
    expect((named(created, "traffic_tokens")[0]?.tokens as unknown[]).length).toBe(2);
    const state = JSON.parse(readFileSync(statePath(created), "utf8"));
    expect(state.directions["first-to-second"].lastSlot).toBe(SLOT);
    expect(state.directions["second-to-first"].lastSlot).toBe(SLOT - 1);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(existsSync(`${statePath(created)}.lock`)).toBe(false);
  });

  it("reads the gas limit for a new copy by destination chain", () => {
    const parsed = parseBotConfig({ schemaVersion: 1, stateDirectory: "/s", ...trafficSection({ directory: "/d" }, { newCopyGasLimit: { "1": "9000000" } }) }).traffic!;
    expect(newCopyGasLimitOf(parsed, 1)).toBe(9_000_000n);
    expect(newCopyGasLimitOf(parsed, 369)).toBeNull();
  });

  it("raises the tip on chain 369 to its minimum and uses a fixed priority fee where one is set", async () => {
    const created = await prepare({ priorityFeeWei: "1" });
    const { overrides, nodes } = overridesFor();
    await run(created, overrides);
    expect(nodes[1].client.estimateMaxPriorityFeePerGas).not.toHaveBeenCalled();
    const relay369 = (nodes[369].client.sendRawTransaction as ReturnType<typeof vi.fn>).mock.calls[1]?.[0] as { serializedTransaction: Hex };
    expect(parseTransaction(relay369.serializedTransaction).maxPriorityFeePerGas).toBe(10_000_000n);
  });

  it("records a skipped slot, so the next pass does not try again", async () => {
    const created = await prepare({ directions: { "first-to-second": { enabled: true, offsetSeconds: 0 }, "second-to-first": { enabled: false, offsetSeconds: 1800 } } });
    const { overrides, states, nodes } = overridesFor();
    states[1]!.balances.clear();
    await run(created, overrides);
    expect(named(created, "traffic_skipped")[0]).toMatchObject({ direction: "first-to-second", reason: "no-eligible-token" });
    expect(JSON.parse(readFileSync(statePath(created), "utf8")).directions).toEqual({ "first-to-second": { lastSlot: SLOT, lastAttemptAtMilliseconds: overrides.now!() }, "second-to-first": null });
    expect(nodes[1].sent).toHaveLength(0);
  });

  it("on its schedule sends a due direction once, and leaves the other until its time", async () => {
    const created = await prepare();
    const { overrides, nodes } = overridesFor();
    // The way back sent in its current slot already (half an hour earlier); the way out is due now.
    await mkdir(join(created.directory, "state"), { recursive: true });
    await writeFile(statePath(created), JSON.stringify({ schemaVersion: 1, directions: { "first-to-second": null, "second-to-first": { lastSlot: SLOT - 1, lastAttemptAtMilliseconds: 1 } } }));
    const controller = new AbortController();
    const running = run(created, overrides, { runOnce: false, signal: controller.signal });
    for (let attempt = 0; attempt < 300 && named(created, "traffic_sent").length === 0; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    // A second pass comes after one poll second: it must find the slot used up.
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    controller.abort();
    await running;
    expect(named(created, "traffic_sent").map((event) => event.direction)).toEqual(["first-to-second"]);
    expect(nodes[1].sent).toHaveLength(2);
    expect(nodes[369].sent).toHaveLength(0);
  });

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

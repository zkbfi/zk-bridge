import { describe, expect, it } from "vitest";
import { createRpcHarness, HARNESS_NOW } from "./support/rpc-harness.js";

const FAKEKEY = "FAKEKEY1234567890";

const RETURNED_ID = createRpcHarness().scenario.ids.returned;

describe("the light client heads", () => {
  it("reads the stored head from the contract and measures the lag against the finalized block of the tracked chain", async () => {
    const harness = createRpcHarness();
    const { heads } = await harness.body("/api/heads");
    const [ethereum, pulsechain] = heads;
    expect(ethereum).toMatchObject({
      chainId: 1,
      trackedChainId: 369,
      storedHeadSlot: 340,
      storedHeadExecutionBlock: 212,
      storedHeadExecutionTimestamp: Number(harness.scenario.timestampOf(369, 212n)),
      lastUpdateTimestamp: Number(harness.scenario.timestampOf(1, 216n)),
      updateCount: 1,
      // The finalized block is 32 blocks below the head: its slot is (timestamp - genesis time) / 12.
      finalizedSlot: 351,
      lagSlots: 11,
      trackedChainTipBlock: 300,
      ownChainTipBlock: 300,
    });
    expect(pulsechain).toMatchObject({ chainId: 369, trackedChainId: 1, storedHeadSlot: 300, storedHeadExecutionBlock: 105, lagSlots: 51, updateCount: 2 });
    expect(pulsechain.lagSeconds).toBe(Number(harness.scenario.timestampOf(1, 300n) - harness.scenario.timestampOf(1, 105n)));
  });

  it("shows the lag as unknown when the node does not serve the finalized tag, and never as zero", async () => {
    const harness = createRpcHarness({ first: { finalized: null }, second: { finalized: null } });
    const { heads } = await harness.body("/api/heads");
    expect(heads.map((head: { finalizedSlot: number | null; lagSlots: number | null }) => [head.finalizedSlot, head.lagSlots])).toEqual([[null, null], [null, null]]);
  });

  it("shows the lag as unknown when the finalized block is older than the genesis time", async () => {
    const early = createRpcHarness({
      first: { viewOverride: (call) => (call.functionName === "genesisTime" && call.address.startsWith("0x19") ? 9_999_999_999n : undefined) },
    });
    expect((await early.body("/api/heads")).heads[0].finalizedSlot).toBeNull();
  });

  it("shows no head when the light client stores none", async () => {
    const harness = createRpcHarness({ first: { viewOverride: (call) => (call.functionName === "head" ? 0n : undefined) } });
    const { heads } = await harness.body("/api/heads");
    expect(heads[0]).toMatchObject({ storedHeadSlot: null, updateCount: 0, lagSlots: null, lastUpdateTimestamp: null });
  });

  it("shows no update time when no update event is in the scanned history, and still shows the head", async () => {
    const harness = createRpcHarness({ api: { blockSpan: 40, maxWindowsPerRequest: 1 } });
    const { heads } = await harness.body("/api/heads");
    expect(heads[0]).toMatchObject({ storedHeadSlot: 340, lastUpdateTimestamp: null, updateCount: 0 });
  });

  it("shows the head block time as null when the tracked chain does not answer for that block", async () => {
    const harness = createRpcHarness();
    const original = harness.chains[369]!.getBlock;
    harness.chains[369]!.getBlock = async (selector) => {
      if ("blockNumber" in selector && selector.blockNumber === 212n) throw new Error("pruned");
      return original(selector);
    };
    const { heads } = await harness.body("/api/heads");
    expect(heads[0].storedHeadExecutionTimestamp).toBeNull();
    expect(heads[0].lagSeconds).toBeNull();
  });
});

describe("the summary", () => {
  it("counts the messages in flight by status and direction", async () => {
    const harness = createRpcHarness();
    const summary = await harness.body("/api/summary");
    expect(summary.inFlight).toEqual({
      total: 4,
      byStatus: { sent: 2, waiting_for_finality: 1, covered: 1 },
      byDirection: { "1>369": 3, "369>1": 1 },
    });
  });

  it("sums the volume of the last 24 hours by source chain and token", async () => {
    const harness = createRpcHarness();
    const summary = await harness.body("/api/summary");
    const byChain = Object.fromEntries(summary.volume24h.map((row: { chainId: number; volume: string; transfers: number }) => [row.chainId, [row.volume, row.transfers]]));
    // Chain 1 sent 1000 + 250 + 300 + 200 + 100 + 50. Chain 369 sent 400 + 60.
    expect(byChain).toEqual({ 1: ["1900", 6], 369: ["460", 2] });
  });

  it("counts a transfer whose token the history does not name under no token, and does not lose its amount", async () => {
    const harness = createRpcHarness({ scenario: { drop: (event) => event.eventName === "TokensBridgingInitiated" && event.args.messageId === RETURNED_ID } });
    const summary = await harness.body("/api/summary");
    const rows = summary.volume24h.filter((row: { chainId: number }) => row.chainId === 369);
    expect(rows.map((row: { token: unknown; volume: string }) => [row.token === null ? null : "token", row.volume]).sort()).toEqual([[null, "400"], ["token", "60"]]);
  });

  it("shows the newest light client update of each side with its gas, its cost and its poster", async () => {
    const harness = createRpcHarness();
    const summary = await harness.body("/api/summary");
    expect(summary.lastHeadUpdates).toEqual([
      {
        chainId: 1,
        update: { slot: 340, executionBlockNumber: 212, transactionHash: expect.stringMatching(/^0x/), timestamp: Number(harness.scenario.timestampOf(1, 216n)), gasUsed: "210000", costWei: "630000", poster: `0x${"e0".repeat(20)}` },
      },
      { chainId: 369, update: expect.objectContaining({ slot: 300, executionBlockNumber: 105 }) },
    ]);
  });

  it("shows the gate and the send state from the contracts, and the confirmation from the event", async () => {
    const harness = createRpcHarness();
    const { gates } = await harness.body("/api/summary");
    expect(gates[0]).toMatchObject({
      chainId: 1,
      enforcing: true,
      sealed: false,
      depositsOpen: true,
      lastConfirmedEpoch: 10,
      lastConfirmedVersion: "0x01020304",
      lastConfirmedTimestamp: Number(harness.scenario.timestampOf(1, 250n)),
      confirmations: 1,
    });
    expect(gates[1]).toMatchObject({ sealedVersion: "0xdeadbeef", sealedSlot: 7 });
  });

  it("derives the confirmation time from the epoch when no event is in the history, and marks it as partial", async () => {
    const harness = createRpcHarness({ scenario: { confirmations: false } });
    const summary = await harness.body("/api/summary");
    // genesis time = base - 1000, epoch 10, 32 slots of 12 seconds: base - 1000 + 3840.
    expect(summary.gates[0]).toMatchObject({ lastConfirmedEpoch: 10, lastConfirmedTimestamp: 1_700_000_000 - 1_000 + 3_840, confirmations: 0, lastConfirmedVersion: null });
    expect(summary.coverage.partial).toEqual(["gateConfirmation"]);
  });

  it("shows a gate with no confirmed epoch as null", async () => {
    const harness = createRpcHarness({
      scenario: { confirmations: false },
      first: { viewOverride: (call) => (call.functionName === "confirmedEpoch" ? [0n, false] : undefined) },
      second: { viewOverride: (call) => (call.functionName === "confirmedEpoch" ? [0n, false] : undefined) },
    });
    const summary = await harness.body("/api/summary");
    expect(summary.gates[0]).toMatchObject({ lastConfirmedEpoch: null, lastConfirmedTimestamp: null });
    expect(summary.coverage.partial).toEqual([]);
  });

  it("marks the figures that a short history cannot complete, and none when the history is complete", async () => {
    const complete = await createRpcHarness().body("/api/summary");
    expect(complete.coverage).toMatchObject({ complete: true, coveredFrom: 0 });
    expect(complete.coverage.partial).toEqual([]);
    const short = await createRpcHarness({ api: { blockSpan: 40, maxWindowsPerRequest: 1 } }).body("/api/summary");
    expect(short.coverage.complete).toBe(false);
    expect(short.coverage.partial).toEqual(expect.arrayContaining(["inFlight", "lightClientUpdates", "volume24h"]));
  });

  it("does not mark the volume as partial when the scan reaches back 24 hours, even if the history is not complete", async () => {
    const harness = createRpcHarness({ api: { blockSpan: 40, maxWindowsPerRequest: 1 } });
    const summary = await harness.body(`/api/summary?now=${HARNESS_NOW + 90_000}`);
    expect(summary.coverage.complete).toBe(false);
    expect(summary.coverage.partial).not.toContain("volume24h");
    expect(summary.coverage.partial).toContain("inFlight");
  });

  it("describes the scan: the lowest block read on each chain", async () => {
    const summary = await createRpcHarness({ api: { blockSpan: 40, maxWindowsPerRequest: 1 } }).body("/api/summary");
    expect(summary.coverage.scannedFromBlock).toEqual({ 1: 261, 369: 261 });
  });
});

describe("tokens", () => {
  it("lists every token that the history names, with the facts that the chain gave", async () => {
    const harness = createRpcHarness();
    const { tokens, coverage } = await harness.body("/api/tokens");
    expect(coverage.partial).toEqual([]);
    expect(tokens).toHaveLength(2);
    const native = tokens.find((token: { address: string }) => token.address === harness.scenario.tokens.native);
    const copy = tokens.find((token: { address: string }) => token.address === harness.scenario.tokens.copy);
    expect(native).toMatchObject({ chainId: 1, symbol: "USDT", decimals: 6, metadataRead: true, isBridgedCopy: false, homeChainId: 1, registeredBlockNumber: null });
    expect(copy).toMatchObject({
      chainId: 369,
      symbol: "USDT.e",
      isBridgedCopy: true,
      homeChainId: 1,
      homeToken: harness.scenario.tokens.native,
      registeredBlockNumber: 205,
      registeredTimestamp: Number(harness.scenario.timestampOf(369, 205n)),
    });
  });

  it("records that the metadata was not read, and assumes 18 decimals, for a token that does not answer", async () => {
    const harness = createRpcHarness({
      first: {
        viewOverride: undefined,
        failView: (call) => (call.functionName === "decimals" || call.functionName === "name" || call.functionName === "symbol" ? new Error("execution reverted") : undefined),
      },
    });
    const { tokens } = await harness.body("/api/tokens");
    expect(tokens.find((token: { chainId: number }) => token.chainId === 1)).toMatchObject({ metadataRead: false, decimals: 18, symbol: null, name: null });
  });

  it("reads a token that gave no decimals again after a minute", async () => {
    let now = 0;
    let broken = true;
    const harness = createRpcHarness({
      api: { now: () => now, headMaxAgeMilliseconds: 0 },
      first: { failView: (call) => (broken && call.functionName === "decimals" ? new Error("execution reverted") : undefined) },
    });
    expect((await harness.body("/api/tokens")).tokens.find((token: { chainId: number }) => token.chainId === 1).metadataRead).toBe(false);
    broken = false;
    now = 30_000;
    expect((await harness.body("/api/tokens")).tokens.find((token: { chainId: number }) => token.chainId === 1).metadataRead).toBe(false);
    now = 61_000;
    expect((await harness.body("/api/tokens")).tokens.find((token: { chainId: number }) => token.chainId === 1).metadataRead).toBe(true);
  });
});

describe("the audit", () => {
  const auditOf = async (settings: Parameters<typeof createRpcHarness>[0] = {}) => {
    const harness = createRpcHarness(settings);
    return { harness, audit: await harness.body("/api/audit") };
  };

  it("reads the escrow and the supply from the contracts and adds the transfers that are not paid", async () => {
    const { harness, audit } = await auditOf();
    expect(audit.tokens).toEqual([
      {
        token: expect.objectContaining({ chainId: 1, address: harness.scenario.tokens.native }),
        bridgedToken: expect.objectContaining({ chainId: 369, address: harness.scenario.tokens.copy }),
        escrow: "1710",
        bridgedSupply: "1150",
        // The send that a head covers (250), the release that failed (200) and the young send (50).
        pendingForward: "500",
        // The copy that was sent back and is not delivered yet.
        pendingBackward: "60",
        expectedEscrow: "1710",
        difference: "0",
        mismatch: false,
      },
    ]);
    expect(audit.coverage.partial).toEqual([]);
  });

  it("flags a mismatch when the escrow is not what the supply and the pending transfers need", async () => {
    const { audit } = await auditOf({
      first: { viewOverride: (call) => (call.functionName === "mediatorBalance" ? 1_709n : undefined) },
    });
    expect(audit.tokens[0]).toMatchObject({ escrow: "1709", difference: "-1", mismatch: true });
  });

  it("shows no bridged copy, and a supply of zero, when the other mediator does not name the native token back", async () => {
    const { audit } = await auditOf({
      second: { viewOverride: (call) => (call.functionName === "nativeTokenAddress" ? "0x0000000000000000000000000000000000000000" : undefined) },
    });
    expect(audit.tokens[0]).toMatchObject({ bridgedToken: null, bridgedSupply: "0" });
  });

  it("marks the audit as partial when the history is short, because older transfers may still be pending", async () => {
    const { audit } = await auditOf({ api: { blockSpan: 40, maxWindowsPerRequest: 1 } });
    expect(audit.coverage.partial).toEqual(["audit"]);
  });

  it("fails when a contract read fails, instead of showing a number that was not read", async () => {
    const harness = createRpcHarness({ first: { failView: (call) => (call.functionName === "mediatorBalance" ? new Error("rpc down") : undefined) } });
    await expect(harness.api.get("/api/audit")).rejects.toThrow("rpc down");
  });
});

describe("light client updates", () => {
  it("lists them newest first with the gas of the transaction", async () => {
    const harness = createRpcHarness();
    const { items, coverage } = await harness.body("/api/head-updates");
    // The two heads of chain 369 were stored in the same block, so the larger slot comes first.
    expect(items.map((item: { chainId: number; slot: number }) => [item.chainId, item.slot])).toEqual([[1, 340], [369, 300], [369, 299]]);
    expect(items[0]).toMatchObject({ gasUsed: "210000", effectiveGasPrice: "3", costWei: "630000", poster: `0x${"e0".repeat(20)}`, executionBlockNumber: 212 });
    expect(coverage.partial).toEqual([]);
  });

  it("filters by chain, by slot and by count", async () => {
    const harness = createRpcHarness();
    expect((await harness.body("/api/head-updates?chainId=369")).items.map((item: { chainId: number }) => item.chainId)).toEqual([369, 369]);
    expect((await harness.body("/api/head-updates?before=340")).items.map((item: { slot: number }) => item.slot)).toEqual([300, 299]);
    expect((await harness.body("/api/head-updates?limit=1")).items).toHaveLength(1);
    expect((await harness.body("/api/head-updates?limit=0")).items).toHaveLength(3);
  });

  it("marks the list as partial when the history is short", async () => {
    const short = await createRpcHarness({ api: { blockSpan: 40, maxWindowsPerRequest: 1 } }).body("/api/head-updates");
    expect(short.coverage.partial).toEqual(["lightClientUpdates"]);
  });
});

describe("delivery cost", () => {
  it("uses the settings that the caller gives for the default gas", async () => {
    const { parseDeliveryCostSettings } = await import("../src/index.js");
    const harness = createRpcHarness({ api: { deliveryCost: parseDeliveryCostSettings({ EXPLORER_DEFAULT_DELIVERY_GAS: "123456" }) } });
    expect((await harness.body("/api/delivery-cost?chainId=1")).kinds.token.defaultGas).toBe("123456");
  });

  it("gives the base fee of the latest block and the default gas, labelled as default because no delivery was measured", async () => {
    const harness = createRpcHarness();
    const report = await harness.body("/api/delivery-cost?chainId=369");
    expect(report.chainId).toBe(369);
    expect(report.baseFee).toEqual({ wei: "7", blockNumber: 300, timestamp: Number(harness.scenario.timestampOf(369, 300n)) });
    for (const kind of Object.values(report.kinds) as { sampleCount: number; isDefault: boolean; averageGas: string | null }[]) {
      expect(kind).toMatchObject({ sampleCount: 0, isDefault: true, averageGas: null });
    }
  });

  it("shows a missing base fee as null", async () => {
    const harness = createRpcHarness({ second: { baseFeePerGas: null } });
    expect((await harness.body("/api/delivery-cost?chainId=369")).baseFee.wei).toBeNull();
  });

  it("answers 400 for a chain identifier that is missing, malformed or not in the pair", async () => {
    const harness = createRpcHarness();
    expect(await harness.answer("/api/delivery-cost")).toEqual({ status: 400, body: { error: "chainId is required and must be a whole number" } });
    expect(await harness.answer("/api/delivery-cost?chainId=abc")).toMatchObject({ status: 400 });
    expect(await harness.answer("/api/delivery-cost?chainId=5")).toEqual({ status: 400, body: { error: "unknown chainId 5" } });
  });
});

describe("the pair", () => {
  it("describes the pair with no URL", async () => {
    const harness = createRpcHarness();
    const description = await harness.body("/api/pair");
    expect(description.name).toBe("eth-pls");
    expect(JSON.stringify(description)).not.toContain("http");
  });
});

describe("one message", () => {
  it("shows the message with its call data and the sender of the delivery", async () => {
    const harness = createRpcHarness();
    const detail = await harness.body(`/api/messages/${harness.scenario.ids.plain}`);
    expect(detail).toMatchObject({ messageId: harness.scenario.ids.plain, kind: "message", status: "delivered", data: "0xabcd", executor: harness.scenario.accounts.executor, delivered: { executedBy: `0x${"e0".repeat(20)}` } });
    expect(detail.coverage.complete).toBe(true);
  });

  it("accepts the identifier in capital letters", async () => {
    const harness = createRpcHarness();
    const detail = await harness.body(`/api/messages/0x${harness.scenario.ids.plain.slice(2).toUpperCase()}`);
    expect(detail.messageId).toBe(harness.scenario.ids.plain);
  });

  it("answers 400 for an identifier that is not 32 bytes of hex, and 404 for a message that does not exist", async () => {
    const harness = createRpcHarness();
    expect(await harness.answer("/api/messages/0x1234")).toEqual({ status: 400, body: { error: "invalid message identifier" } });
    expect(await harness.answer(`/api/messages/0x${"9".repeat(64)}`)).toEqual({ status: 404, body: { error: "unknown message" } });
  });

  it("says that an unknown message may be outside the scanned history when the history is short", async () => {
    const harness = createRpcHarness({ api: { blockSpan: 40, maxWindowsPerRequest: 1 } });
    const answer = await harness.answer(`/api/messages/0x${"9".repeat(64)}`);
    expect(answer).toEqual({ status: 404, body: { error: "unknown message in the scanned history; the RPC source reads only recent history" } });
  });

  it("reads older windows to find a message, up to the budget of the request", async () => {
    const harness = createRpcHarness({ api: { blockSpan: 40, maxWindowsPerRequest: 30 } });
    const answer = await harness.answer(`/api/messages/${harness.scenario.ids.delivered}`);
    expect(answer.status).toBe(200);
    const shortBudget = createRpcHarness({ api: { blockSpan: 40, maxWindowsPerRequest: 1 } });
    expect((await shortBudget.answer(`/api/messages/${shortBudget.scenario.ids.delivered}`)).status).toBe(404);
  });
});

describe("a message found by its transaction", () => {
  const sendTransaction = (harness: ReturnType<typeof createRpcHarness>, name: "delivered" | "plain") => {
    const id = harness.scenario.ids[name];
    return harness.scenario.events.find((event) => event.eventName === "UserRequestForAffirmation" && event.args.messageId === id)!.transactionHash;
  };

  it("finds the identifier from the send transaction on either chain, and from a delivery transaction", async () => {
    const harness = createRpcHarness();
    expect(await harness.api.findMessageByTransaction(sendTransaction(harness, "delivered"))).toBe(harness.scenario.ids.delivered);
    const delivery = harness.scenario.events.find((event) => event.eventName === "AffirmationCompleted" && event.args.messageId === harness.scenario.ids.delivered)!;
    expect(await harness.api.findMessageByTransaction(delivery.transactionHash)).toBe(harness.scenario.ids.delivered);
    const returned = harness.scenario.events.find((event) => event.eventName === "UserRequestForAffirmation" && event.args.messageId === harness.scenario.ids.returned)!;
    expect(await harness.api.findMessageByTransaction(returned.transactionHash)).toBe(harness.scenario.ids.returned);
  });

  it("answers null for a transaction that no chain knows, and for a transaction with no bridge message", async () => {
    const harness = createRpcHarness();
    expect(await harness.api.findMessageByTransaction(`0x${"7".repeat(64)}`)).toBeNull();
    const update = harness.scenario.events.find((event) => event.eventName === "HeadUpdated")!;
    expect(await harness.api.findMessageByTransaction(update.transactionHash)).toBeNull();
  });

  it("passes on an error that is not a missing receipt", async () => {
    const harness = createRpcHarness();
    harness.chains[1]!.getTransactionReceipt = async () => {
      throw new Error(`node failed for https://rpc.example.org/v3/${FAKEKEY}`);
    };
    await expect(harness.api.findMessageByTransaction(`0x${"7".repeat(64)}`)).rejects.toThrow("node failed");
  });

  it("lets the next message request read as far back as that transaction, which a plain request would not", async () => {
    const harness = createRpcHarness({ api: { blockSpan: 40, maxWindowsPerRequest: 1 } });
    const hash = sendTransaction(harness, "delivered");
    expect((await harness.answer(`/api/messages/${harness.scenario.ids.delivered}`)).status).toBe(404);
    expect(await harness.api.findMessageByTransaction(hash)).toBe(harness.scenario.ids.delivered);
    const detail = await harness.answer(`/api/messages/${harness.scenario.ids.delivered}`);
    expect(detail.status).toBe(200);
    expect((detail.body as { status: string }).status).toBe("delivered");
  });
});

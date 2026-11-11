import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { encodeFunctionData, getAddress, keccak256, toHex, type Address, type Hex } from "viem";
import { buildMessageId, encodeAmbMessage, tokenMediatorAbi } from "@zk-bridge/shared";
import { connectChain, compileSyntheticContracts, installEmptyPulsexFactories, type ChainHandle } from "./support/chains";
import { startAnvil, startIndexer, startPostgres, waitFor, type RunningIndexer, type Stoppable } from "./support/processes";

/**
 * The delivered side of the bridge, end to end, without a prover.
 *
 * Two Anvil chains hold test doubles (`test/contracts/Synthetic.sol`) that emit the same events as the real
 * contracts, at the call of the test. The real Ponder indexer follows both chains and the test reads the rows through
 * the HTTP API. This covers delivery, failed calls, failed releases, fees, light client heads,
 * the gate, the registry, escrow against supply.
 * The real contracts cover the sent side in `real-stack.test.ts`.
 */

const FINALITY_SECONDS = 4;
const SIX_DECIMALS = 1_000_000n;

type Feed = { items: FeedItem[] };
type FeedItem = {
  messageId: Hex;
  kind: string;
  status: string;
  transfer: null | {
    value: string | null;
    deliveredValue: string | null;
    paidTo: string | null;
    recipient: string | null;
    sourceToken: { symbol: string | null; decimals: number | null } | null;
    destinationToken: { symbol: string | null; isBridgedCopy: boolean | null; homeToken: string | null } | null;
  };
  sent: { blockNumber: number } | null;
  delivered: { success: boolean; executedBy: string } | null;
  covered: { headSlot: number } | null;
};

const stoppables: Stoppable[] = [];
let indexer: RunningIndexer;
let chainA: ChainHandle;
let chainB: ChainHandle;

const api = async <body>(path: string, init?: RequestInit): Promise<{ status: number; body: body }> => {
  const response = await fetch(`${indexer.apiUrl}${path}`, init);
  return { status: response.status, body: (await response.json()) as body };
};

const feedItem = async (messageId: Hex): Promise<FeedItem | undefined> =>
  (await api<Feed>("/api/feed?limit=200")).body.items.find((item) => item.messageId === messageId);

/** Waits until a message reaches a status. */
const waitForStatus = async (messageId: Hex, status: string): Promise<FeedItem> => {
  try {
    return await waitFor(`message ${messageId.slice(0, 10)} to be ${status}`, async () => {
      const item = await feedItem(messageId);
      return item?.status === status ? item : undefined;
    });
  } catch (error) {
    const feed = await fetch(`${indexer.apiUrl}/api/feed?limit=5`).then((response) => response.text());
    throw new Error(`${(error as Error).message}; feed: ${feed.slice(0, 600)}; log: ${indexer.logFile}`);
  }
};

type Audit = { tokens: { token: { address: string }; escrow: string; bridgedSupply: string; pendingForward: string; pendingBackward: string; mismatch: boolean }[] };

/** Waits until the audit of the native token shows these numbers. */
const waitForAudit = async (token: Address, expected: { escrow: bigint; bridgedSupply: bigint; pendingForward: bigint; pendingBackward: bigint }) => {
  try {
    return await waitForAuditRow(token, expected);
  } catch (error) {
    const audit = await fetch(`${indexer.apiUrl}/api/audit`).then((response) => response.text());
    const escrow = await fetch(`${indexer.apiUrl}/api/escrow`).then((response) => response.text());
    throw new Error(`${(error as Error).message}; audit: ${audit.slice(0, 900)}; escrow: ${escrow.slice(0, 900)}`);
  }
};

const waitForAuditRow = (token: Address, expected: { escrow: bigint; bridgedSupply: bigint; pendingForward: bigint; pendingBackward: bigint }) =>
  waitFor(`the audit of ${token} to read ${JSON.stringify(expected, (_, value) => (typeof value === "bigint" ? value.toString() : value))}`, async () => {
    const row = (await api<Audit>("/api/audit")).body.tokens.find((entry) => entry.token.address === token.toLowerCase());
    if (row === undefined) return undefined;
    const matches =
      row.escrow === expected.escrow.toString() &&
      row.bridgedSupply === expected.bridgedSupply.toString() &&
      row.pendingForward === expected.pendingForward.toString() &&
      row.pendingBackward === expected.pendingBackward.toString();
    return matches ? row : undefined;
  });

describe("the indexer follows synthetic chains", () => {
  let tokenA: Address;
  let copyB: Address;
  let bridgeA: Address;
  let bridgeB: Address;
  let mediatorA: Address;
  let mediatorB: Address;
  let lightClientA: Address;
  let lightClientB: Address;
  let gateA: Address;
  let gateB: Address;
  let registryB: Address;
  let nonceA = 0n;
  let nonceB = 0n;
  const ids: Record<string, Hex> = {};
  const blocks: Record<string, number> = {};

  const sender = () => chainA.accounts[0] as Address;
  const recipient = () => chainA.accounts[1] as Address;
  const poster = () => chainA.accounts[3] as Address;

  /** Sends a message on chain A (source) or chain B and returns its identifier and the block of the send. */
  const sendMessage = async (input: { from: "A" | "B"; executor: Address; data: Hex }) => {
    const fromA = input.from === "A";
    const chain = fromA ? chainA : chainB;
    const bridge = fromA ? bridgeA : bridgeB;
    const nonce = fromA ? nonceA++ : nonceB++;
    const id = buildMessageId(BigInt(chain.chainId), bridge, nonce);
    const encoded = encodeAmbMessage({
      header: {
        messageId: id,
        sender: fromA ? mediatorA : mediatorB,
        executor: input.executor,
        reservedGas: 0,
        dataType: 0,
        sourceChainId: BigInt(chain.chainId),
        destinationChainId: BigInt(fromA ? chainB.chainId : chainA.chainId),
      },
      data: input.data,
    });
    const receipt = await chain.send(bridge, "SyntheticBridge", "send", [id, encoded]);
    return { id, blockNumber: Number(receipt.blockNumber) };
  };

  /** Sends tokens from A: the mediator locks, the bridge sends the deploying or the plain handler call. */
  const forwardTransfer = async (name: string, value: bigint, options: { deploy?: boolean } = {}) => {
    const data = options.deploy
      ? encodeFunctionData({
          abi: tokenMediatorAbi,
          functionName: "deployAndHandleBridgedTokens",
          args: [tokenA, "Alpha", "ALP", 6, recipient(), value],
        })
      : encodeFunctionData({ abi: tokenMediatorAbi, functionName: "handleBridgedTokens", args: [tokenA, recipient(), value] });
    const { id, blockNumber } = await sendMessage({ from: "A", executor: mediatorB, data });
    await chainA.send(mediatorA, "SyntheticMediator", "initiated", [tokenA, sender(), value, id]);
    ids[name] = id;
    blocks[name] = blockNumber;
    return id;
  };

  beforeAll(async () => {
    const artifacts = compileSyntheticContracts();
    const [anvilA, anvilB, postgres] = await Promise.all([startAnvil(1, "cancun"), startAnvil(369, "shanghai"), startPostgres()]);
    stoppables.push(anvilA, anvilB, postgres);
    chainA = await connectChain(1, anvilA.url, artifacts);
    chainB = await connectChain(369, anvilB.url, artifacts);

    await installEmptyPulsexFactories(chainB);

    // One account sends every deployment, so they go one after the other (the nonce must not collide).
    bridgeA = await chainA.deploy("SyntheticBridge");
    mediatorA = await chainA.deploy("SyntheticMediator");
    lightClientA = await chainA.deploy("SyntheticLightClient");
    tokenA = await chainA.deploy("SyntheticToken", ["Alpha", "ALP", 6]);
    gateA = await chainA.deploy("SyntheticGate", [true]);
    [bridgeB, mediatorB, lightClientB, gateB, registryB, copyB] = [
      await chainB.deploy("SyntheticBridge"),
      await chainB.deploy("SyntheticMediator"),
      await chainB.deploy("SyntheticLightClient"),
      await chainB.deploy("SyntheticGate", [false]),
      await chainB.deploy("SyntheticRegistry"),
      await chainB.deploy("SyntheticToken", ["Alpha from Ethereum", "zALP", 6]),
    ];

    const section = (chainId: number, rpc: string, addresses: Record<string, Address | undefined>) => ({
      chain_id: chainId,
      rpc_url: rpc,
      wrapped_native: tokenA,
      token_factory: addresses.mediator,
      start_block: 0,
      ...addresses,
    });
    const directory = mkdtempSync(join(tmpdir(), "explorer-deployment-"));
    const deploymentFile = join(directory, "deployment.json");
    writeFileSync(
      deploymentFile,
      JSON.stringify({
        chain_a: section(1, anvilA.url, { bridge: bridgeA, mediator: mediatorA, gate: gateA, light_client: lightClientA }),
        chain_b: section(369, anvilB.url, { bridge: bridgeB, mediator: mediatorB, gate: gateB, light_client: lightClientB, fork_registry: registryB }),
      }),
    );

    indexer = await startIndexer({
      databaseUrl: postgres.connectionString,
      schema: "synthetic",
      environment: {
        EXPLORER_DEPLOYMENT_FILE: deploymentFile,
        EXPLORER_FINALITY_SECONDS_1: String(FINALITY_SECONDS),
        EXPLORER_FINALITY_SECONDS_369: String(FINALITY_SECONDS),
        EXPLORER_TIP_INTERVAL_BLOCKS: "1",
      },
    });
    stoppables.push(indexer);
  });

  afterAll(async () => {
    for (const stoppable of stoppables.reverse()) await stoppable.stop().catch(() => undefined);
  });

  it("indexes a token send as sent, with the transfer and its token metadata", async () => {
    await chainA.send(mediatorA, "SyntheticMediator", "setBalance", [tokenA, SIX_DECIMALS]);
    const id = await forwardTransfer("m1", SIX_DECIMALS, { deploy: true });
    await waitForStatus(id, "sent");
    // The send and the token event are two logs. Wait until the token metadata is joined.
    const item = await waitFor("the token metadata of the transfer", async () => {
      const found = await feedItem(id);
      return found?.transfer?.sourceToken?.symbol ? found : undefined;
    });
    expect(item.kind).toBe("token");
    expect(item.transfer?.value).toBe("1000000");
    expect(item.transfer?.sourceToken).toMatchObject({ symbol: "ALP", decimals: 6 });
    expect(item.transfer?.recipient).toBe(recipient().toLowerCase());
    const escrow = await api<{ escrow: { token: { address: string }; balance: string }[] }>("/api/escrow");
    expect(escrow.body.escrow.find((row) => row.token.address === tokenA.toLowerCase())?.balance).toBe("1000000");
  });

  it("covers the message when the destination light client stores a head at or after the source block", async () => {
    await chainB.send(lightClientB, "SyntheticLightClient", "update", [100n, keccak256(toHex("root-100")), keccak256(toHex("block-100")), BigInt(blocks.m1 as number)], 3);
    const item = await waitForStatus(ids.m1 as Hex, "covered");
    expect(item.covered?.headSlot).toBe(100);
    const heads = await api<{ heads: { chainId: number; storedHeadSlot: number; storedHeadExecutionBlock: number; updateCount: number }[] }>("/api/heads");
    const head = heads.body.heads.find((entry) => entry.chainId === 369);
    expect(head).toMatchObject({ storedHeadSlot: 100, storedHeadExecutionBlock: blocks.m1, updateCount: 1 });
    const updates = await api<{ items: { poster: string; gasUsed: string; costWei: string; executionBlockNumber: number }[] }>("/api/head-updates?chainId=369");
    expect(updates.body.items[0]?.poster).toBe(poster().toLowerCase());
    expect(BigInt(updates.body.items[0]?.gasUsed ?? "0")).toBeGreaterThan(21_000n);
    expect(BigInt(updates.body.items[0]?.costWei ?? "0")).toBeGreaterThan(0n);
  });

  it("marks a delivered transfer, joins it to its message and registers the bridged copy", async () => {
    await chainB.send(mediatorB, "SyntheticMediator", "setNative", [copyB, tokenA]);
    await chainB.send(mediatorB, "SyntheticMediator", "registered", [tokenA, copyB]);
    await chainB.send(copyB, "SyntheticToken", "mint", [recipient(), SIX_DECIMALS]);
    await chainB.send(mediatorB, "SyntheticMediator", "bridged", [copyB, recipient(), SIX_DECIMALS, ids.m1]);
    await chainB.send(bridgeB, "SyntheticBridge", "complete", [mediatorA, mediatorB, ids.m1, true], 4);
    const item = await waitForStatus(ids.m1 as Hex, "delivered");
    // A delivery that fails reverts up and leaves no log, so a delivery row is a success and has no success flag.
    expect(item.delivered).toMatchObject({ executedBy: chainB.accounts[4]?.toLowerCase() });
    expect(item.delivered).not.toHaveProperty("success");
    expect(item.transfer?.deliveredValue).toBe("1000000");
    expect(item.transfer?.paidTo).toBe(recipient().toLowerCase());
    expect(item.transfer?.destinationToken).toMatchObject({ symbol: "zALP", isBridgedCopy: true, homeToken: tokenA.toLowerCase() });
  });

  it("balances escrow against supply after the delivery", async () => {
    const row = await waitForAudit(tokenA, { escrow: SIX_DECIMALS, bridgedSupply: SIX_DECIMALS, pendingForward: 0n, pendingBackward: 0n });
    expect(row.mismatch).toBe(false);
  });

  it("follows a transfer back: burn on B, cover by a head on A, release on A", async () => {
    const value = 400_000n;
    await chainB.send(copyB, "SyntheticToken", "burn", [recipient(), value]);
    const data = encodeFunctionData({ abi: tokenMediatorAbi, functionName: "handleNativeTokens", args: [tokenA, recipient(), value] });
    const { id, blockNumber } = await sendMessage({ from: "B", executor: mediatorA, data });
    await chainB.send(mediatorB, "SyntheticMediator", "initiated", [copyB, recipient(), value, id]);
    ids.back = id;
    await waitForStatus(id, "sent");
    const sent = await waitFor("the token of the burn", async () => {
      const found = await feedItem(id);
      return found?.transfer?.sourceToken?.symbol ? found : undefined;
    });
    expect(sent.transfer?.sourceToken).toMatchObject({ symbol: "zALP" });
    // Burned on B, not released on A: the escrow still holds it and the audit counts it as pending.
    await waitForAudit(tokenA, { escrow: SIX_DECIMALS, bridgedSupply: 600_000n, pendingForward: 0n, pendingBackward: value });

    await chainA.send(lightClientA, "SyntheticLightClient", "update", [50n, keccak256(toHex("root-50")), keccak256(toHex("block-50")), BigInt(blockNumber)], 3);
    await waitForStatus(id, "covered");

    await chainA.send(mediatorA, "SyntheticMediator", "setBalance", [tokenA, SIX_DECIMALS - value]);
    await chainA.send(mediatorA, "SyntheticMediator", "bridged", [tokenA, recipient(), value, id]);
    await chainA.send(bridgeA, "SyntheticBridge", "complete", [mediatorB, mediatorA, id, true]);
    const delivered = await waitForStatus(id, "delivered");
    expect(delivered.transfer?.paidTo).toBe(recipient().toLowerCase());
    await waitForAudit(tokenA, { escrow: 600_000n, bridgedSupply: 600_000n, pendingForward: 0n, pendingBackward: 0n });
  });

  it("reports release_failed for a release that the recipient could not take, and keeps it final", async () => {
    await chainA.send(mediatorA, "SyntheticMediator", "setBalance", [tokenA, 700_000n]);
    const id = await forwardTransfer("stuck", 100_000n);
    await chainB.send(mediatorB, "SyntheticMediator", "releaseFailed", [copyB, recipient(), 100_000n, id]);
    await chainB.send(bridgeB, "SyntheticBridge", "complete", [mediatorA, mediatorB, id, true]);
    const stuck = await waitForStatus(id, "release_failed");
    expect(stuck.transfer?.recipient).toBe(recipient().toLowerCase());
    expect(stuck.transfer?.paidTo).toBeNull();
    expect(stuck).toMatchObject({ releaseFailed: true });
    expect(stuck).not.toHaveProperty("claimableOutstanding");
    expect(stuck).not.toHaveProperty("fallbackUsed");
  });

  it("lists the failed release by checksummed address and serves no claim route", async () => {
    const events = await api<{ events: { kind: string; account: string; value: string; messageId: string }[] }>(`/api/release-events?address=${getAddress(recipient())}`);
    expect(events.body.events).toEqual([expect.objectContaining({ kind: "release_failed", account: recipient().toLowerCase(), value: "100000", messageId: ids.stuck })]);
    expect((await fetch(`${indexer.apiUrl}/api/claimables`)).status).toBe(404);
  });

  it("keeps escrow and supply in step with the failed release pending, and flags a mismatch when they part", async () => {
    // The failed release is final: the tokens stay locked, so the escrow is the supply plus the pending 100000.
    await waitForAudit(tokenA, { escrow: 700_000n, bridgedSupply: 600_000n, pendingForward: 100_000n, pendingBackward: 0n });
    // The mock mediator now reports 1000 tokens less than the copy supply needs. Any mediator event on the token refreshes the escrow.
    const refreshId = keccak256(toHex("escrow-refresh"));
    await chainA.send(mediatorA, "SyntheticMediator", "setBalance", [tokenA, 699_000n]);
    await chainA.send(mediatorA, "SyntheticMediator", "bridged", [tokenA, sender(), 0n, refreshId]);
    const flagged = await waitFor("a mismatch", async () => {
      const row = (await api<Audit & { tokens: { difference: string }[] }>("/api/audit")).body.tokens[0];
      return row?.mismatch === true ? row : undefined;
    });
    expect(flagged).toMatchObject({ escrow: "699000", expectedEscrow: "700000", difference: "-1000" });
    await chainA.send(mediatorA, "SyntheticMediator", "setBalance", [tokenA, 700_000n]);
    await chainA.send(mediatorA, "SyntheticMediator", "bridged", [tokenA, sender(), 0n, refreshId]);
    await waitForAudit(tokenA, { escrow: 700_000n, bridgedSupply: 600_000n, pendingForward: 100_000n, pendingBackward: 0n });
  });

  it("keeps an arbitrary message undelivered when its delivery attempt reverted: a failed delivery leaves no log", async () => {
    const target = chainB.accounts[5] as Address;
    const { id } = await sendMessage({ from: "A", executor: target, data: "0xdeadbeef" });
    ids.failed = id;
    const item = await waitForStatus(id, "sent");
    expect(item.kind).toBe("message");
    expect(item.transfer).toBeNull();
    expect(item.delivered).toBeNull();
  });

  it("moves a send from sent to waiting_for_finality after the finality window, then covers it", async () => {
    const { id, blockNumber } = await sendMessage({ from: "A", executor: chainB.accounts[6] as Address, data: "0x01" });
    ids.waiting = id;
    expect((await waitForStatus(id, "sent")).covered).toBeNull();
    await new Promise((done) => setTimeout(done, (FINALITY_SECONDS + 1) * 1000));
    await chainA.mine(2);
    await waitForStatus(id, "waiting_for_finality");
    await chainB.send(lightClientB, "SyntheticLightClient", "update", [101n, keccak256(toHex("root-101")), keccak256(toHex("block-101")), BigInt(blockNumber)], 3);
    await waitForStatus(id, "covered");
  });

  it("filters the feed by status, kind, token, address and direction, and pages with a cursor", async () => {
    const delivered = await api<Feed>("/api/feed?status=delivered&limit=200");
    expect(delivered.body.items.every((item) => item.status === "delivered")).toBe(true);
    const messagesOnly = await api<Feed>("/api/feed?kind=message");
    expect(messagesOnly.body.items.map((item) => item.messageId).sort()).toEqual([ids.failed, ids.waiting].sort());
    const byToken = await api<Feed>(`/api/feed?token=${getAddress(tokenA)}`);
    expect(byToken.body.items.map((item) => item.messageId).sort()).toEqual([ids.m1, ids.stuck, ids.back].sort());
    expect(byToken.body.items.every((item) => item.kind === "token")).toBe(true);
    const byAddress = await api<Feed>(`/api/feed?address=${getAddress(recipient())}&kind=token`);
    expect(byAddress.body.items.map((item) => item.messageId)).toContain(ids.stuck);
    const backward = await api<Feed>("/api/feed?direction=369>1");
    expect(backward.body.items.map((item) => item.messageId)).toEqual([ids.back]);
    const none = await api<Feed>("/api/feed?direction=369-1&status=sent");
    expect(none.body.items).toEqual([]);

    const first = await api<Feed & { nextCursor: string | null }>("/api/feed?limit=2");
    expect(first.body.items).toHaveLength(2);
    expect(first.body.nextCursor).not.toBeNull();
    const second = await api<Feed>(`/api/feed?limit=200&cursor=${first.body.nextCursor}`);
    const all = await api<Feed>("/api/feed?limit=200");
    expect([...first.body.items, ...second.body.items].map((item) => item.messageId)).toEqual(all.body.items.map((item) => item.messageId));
    expect((await api("/api/feed?limit=0")).status).toBe(400);
  });

  it("indexes the gate, the registry and the opening of sends", async () => {
    await chainB.send(gateB, "SyntheticGate", "confirm", [7n, "0x0000036c"]);
    await chainA.send(gateA, "SyntheticGate", "seal", ["0x12345678", 999n]);
    await chainB.send(registryB, "SyntheticRegistry", "observe", ["0x0000036c", 1, 1234n]);
    await chainB.send(bridgeB, "SyntheticBridge", "open", [77n, keccak256(toHex("remote")), 76n]);

    const gate = await waitFor("gate events", async () => {
      const result = await api<{ sides: { chainId: number; sealed: boolean; enforcing: boolean; lastConfirmedEpoch: number | null; depositsOpen: boolean }[] }>("/api/gate");
      const sideB = result.body.sides.find((side) => side.chainId === 369);
      const sideA = result.body.sides.find((side) => side.chainId === 1);
      return sideB?.lastConfirmedEpoch === 7 && sideA?.sealed === true && sideB.depositsOpen ? result.body.sides : undefined;
    });
    expect(gate.find((side) => side.chainId === 369)).toMatchObject({ enforcing: true, sealed: false, depositsOpen: true });
    expect(gate.find((side) => side.chainId === 1)).toMatchObject({ enforcing: true, sealed: true, depositsOpen: false });

    const registry = await waitFor("registry observation", async () => {
      const result = await api<{ observations: { chainId: number; version: string; slot: number }[] }>("/api/registry");
      return result.body.observations.length > 0 ? result.body.observations : undefined;
    });
    expect(registry[0]).toMatchObject({ chainId: 369, version: "0x0000036c", slot: 1234 });
  });

  it("summarizes the pair from chain data only", async () => {
    const summary = await api<{
      pair: string;
      inFlight: { total: number; byStatus: Record<string, number> };
      volume24h: { chainId: number; token: { address: string } | null; volume: string; transfers: number }[];
      lastHeadUpdates: { chainId: number; update: { slot: number; poster: string; gasUsed: string } | null }[];
      heads: { chainId: number; storedHeadSlot: number | null }[];
    }>(`/api/summary?now=${Math.floor(Date.now() / 1000)}`);
    expect(summary.body.pair).toBe("eth-pls");
    const volume = summary.body.volume24h.find((row) => row.token?.address === tokenA.toLowerCase());
    // Two sends of the native token from chain A are transfers: m1 (1,000,000) and the stuck one (100,000).
    expect(volume).toMatchObject({ chainId: 1, volume: "1100000", transfers: 2 });
    // The two arbitrary messages are still in flight: the one whose delivery reverted (a failed delivery leaves no log,
    // so it stays undelivered) and the one that waited for finality. The head of slot 101 covers both.
    expect(summary.body.inFlight, JSON.stringify(summary.body.inFlight)).toMatchObject({ total: 2 });
    expect(summary.body.inFlight.byStatus.covered).toBe(2);
    expect(summary.body.heads.find((head) => head.chainId === 369)?.storedHeadSlot).toBe(101);
    expect(summary.body.lastHeadUpdates.find((entry) => entry.chainId === 369)?.update).toMatchObject({ slot: 101, poster: poster().toLowerCase() });
  });

  it("has no route that accepts proof records from outside", async () => {
    const response = await fetch(`${indexer.apiUrl}/api/proofs`, { method: "POST", body: "{}" });
    expect(response.status).toBe(404);
  });

  it("serves Ponder's GraphQL and SQL over HTTP", async () => {
    const graphql = await api<{ data: { messagess: { items: { messageId: string; status: string }[] } } }>("/graphql", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: `{ messagess(limit: 100, where: { status: "release_failed" }) { items { messageId status } } }` }),
    });
    expect(graphql.body.data.messagess.items.map((item) => item.messageId)).toEqual([ids.stuck]);

    const { createClient } = await import("@ponder/client");
    const schema = await import("../../ponder.schema");
    const client = createClient(`${indexer.apiUrl}/sql`, { schema });
    const rows = await client.db.select().from(schema.messages);
    expect(rows.length).toBe(Object.keys(ids).length);
  });
});

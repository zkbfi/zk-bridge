import { beforeAll, describe, expect, it } from "vitest";
import { chainTips, gateEvents, gateStates, headUpdates, lightClientHeads, messages, registryObservations } from "../../ponder.schema";
import { callHandler, handlers } from "./support/fake-registry";
import { GATE_ON_PULSECHAIN, LIGHT_CLIENT_ON_PULSECHAIN, addressOf, createContext, createEvent, hashOf, sentMessageRow } from "./support/handler-fixtures";

beforeAll(async () => {
  await import("../../src/handlers/chain");
});

describe("ChainTip:block", () => {
  const name = "ChainTip:block";

  it("stores the chain clock with the base fee", async () => {
    const { database, context } = createContext(369);
    database.queueSqlRows([]);
    await callHandler(name, { event: createEvent({}, { block: { number: 7n, timestamp: 70n, baseFeePerGas: 9n } }), context });
    expect(database.rows(chainTips)).toEqual([{ chainId: 369, blockNumber: 7n, timestamp: 70n, baseFeePerGas: 9n }]);
  });

  it("stores null when the block reports no base fee", async () => {
    const { database, context } = createContext(369);
    database.queueSqlRows([]);
    await callHandler(name, { event: createEvent({}, { block: { number: 7n, timestamp: 70n } }), context });
    expect(database.rows(chainTips)[0]?.baseFeePerGas).toBeNull();
  });

  it("ages the sends of the chain with the new clock, so that an old send leaves sent", async () => {
    const { database, context } = createContext(1);
    const messageId = hashOf("ab");
    database.seed(messages, sentMessageRow(messageId, 5n));
    database.queueSqlRows([{ messageId, destinationChainId: 369 }]);
    await callHandler(name, { event: createEvent({}, { block: { number: 7n, timestamp: 1_000n + 768n } }), context });
    expect(database.row(messages, { messageId })).toMatchObject({ status: "waiting_for_finality" });
  });
});

describe("BeaconLightClient:HeadUpdated", () => {
  const name = "BeaconLightClient:HeadUpdated";
  const args = { slot: 500n, headerRoot: hashOf("11"), executionBlockHash: hashOf("22") };
  const answer = ({ functionName }: { functionName: string }) => (functionName === "executionBlockNumber" ? 4_000n : undefined);

  it("reads the execution block number from the light client at the hash of the event", async () => {
    const { database, client, context } = createContext(369, answer);
    database.queueSqlRows([]);
    await callHandler(name, { event: createEvent(args), context });
    expect(client.readContract).toHaveBeenCalledWith({
      abi: expect.anything(),
      address: LIGHT_CLIENT_ON_PULSECHAIN,
      functionName: "executionBlockNumber",
      args: [hashOf("22")],
    });
  });

  it("stores the head update with its gas, its cost in wei and its poster", async () => {
    const { database, context } = createContext(369, answer);
    database.queueSqlRows([]);
    await callHandler(name, { event: createEvent(args), context });
    expect(database.rows(headUpdates)).toEqual([
      {
        chainId: 369,
        slot: 500n,
        headerRoot: hashOf("11"),
        executionBlockHash: hashOf("22"),
        executionBlockNumber: 4_000n,
        transactionHash: hashOf("aa"),
        blockNumber: 100n,
        timestamp: 1_000n,
        gasUsed: 21_000n,
        effectiveGasPrice: 3n,
        costWei: 63_000n,
        poster: addressOf("f0"),
      },
    ]);
  });

  it("starts the update count at one and adds one for each later head", async () => {
    const { database, context } = createContext(369, answer);
    database.queueSqlRows([]);
    await callHandler(name, { event: createEvent(args), context });
    expect(database.row(lightClientHeads, { chainId: 369 })).toEqual({
      chainId: 369,
      slot: 500n,
      headerRoot: hashOf("11"),
      executionBlockNumber: 4_000n,
      updatedTimestamp: 1_000n,
      updateCount: 1,
    });
    database.queueSqlRows([]);
    await callHandler(name, { event: createEvent({ ...args, slot: 501n }, { block: { number: 101n, timestamp: 1_012n } }), context });
    expect(database.row(lightClientHeads, { chainId: 369 })).toMatchObject({ slot: 501n, updateCount: 2, updatedTimestamp: 1_012n });
    expect(database.rows(headUpdates)).toHaveLength(2);
  });

  it("covers the messages that the new head reaches", async () => {
    const { database, context } = createContext(369, answer);
    const messageId = hashOf("ab");
    database.seed(messages, sentMessageRow(messageId, 3_999n));
    database.queueSqlRows([{ messageId, sourceChainId: 1 }]);
    await callHandler(name, { event: createEvent(args), context });
    expect(database.row(messages, { messageId })).toMatchObject({ status: "covered", coveredByHeadSlot: 500n, coveredAtTimestamp: 1_000n });
  });
});

describe("the gate events", () => {
  const gateAnswer =
    (enforcing: boolean, sealed: boolean) =>
    ({ functionName }: { functionName: string }) =>
      functionName === "enforcing" ? enforcing : functionName === "isSealed" ? sealed : undefined;

  it("reads the mode flags from the gate contract, because a gate can start enforcing with no event", async () => {
    const { client, context } = createContext(369, gateAnswer(true, false));
    await callHandler("BeaconForkGate:BeaconRootsDetected", { event: createEvent({}, { id: "e1" }), context });
    const reads = client.readContract.mock.calls.map(([call]) => [call.address, call.functionName]);
    expect(reads).toEqual([
      [GATE_ON_PULSECHAIN, "enforcing"],
      [GATE_ON_PULSECHAIN, "isSealed"],
    ]);
  });

  it("stores a confirmation as an event and in the state, and counts the confirmations", async () => {
    const { database, context } = createContext(369, gateAnswer(true, false));
    const args = { epoch: 12n, version: "0x04000000" };
    await callHandler("BeaconForkGate:ForkConfirmed", { event: createEvent(args, { id: "e1" }), context });
    expect(database.row(gateEvents, { id: "e1" })).toEqual({
      id: "e1",
      chainId: 369,
      kind: "confirmed",
      epoch: 12n,
      version: "0x04000000",
      slot: null,
      canary: null,
      transactionHash: hashOf("aa"),
      blockNumber: 100n,
      timestamp: 1_000n,
    });
    await callHandler("BeaconForkGate:ForkConfirmed", {
      event: createEvent({ epoch: 13n, version: "0x04000001" }, { id: "e2", block: { number: 101n, timestamp: 1_012n } }),
      context,
    });
    expect(database.row(gateStates, { chainId: 369 })).toEqual({
      chainId: 369,
      sealed: false,
      sealedVersion: null,
      sealedSlot: null,
      enforcing: true,
      lastConfirmedEpoch: 13n,
      lastConfirmedVersion: "0x04000001",
      lastConfirmedTimestamp: 1_012n,
      confirmations: 2,
    });
  });

  it("stores a seal with its version and slot, and keeps the earlier confirmation facts", async () => {
    const { database, context } = createContext(369, gateAnswer(true, true));
    await callHandler("BeaconForkGate:ForkConfirmed", { event: createEvent({ epoch: 12n, version: "0x04000000" }, { id: "e1" }), context });
    await callHandler("BeaconForkGate:GateSealedByFork", { event: createEvent({ version: "0x05000000", slot: 900n }, { id: "e2" }), context });
    expect(database.row(gateEvents, { id: "e2" })).toMatchObject({ kind: "sealed", version: "0x05000000", slot: 900n, epoch: null });
    expect(database.row(gateStates, { chainId: 369 })).toMatchObject({
      sealed: true,
      sealedVersion: "0x05000000",
      sealedSlot: 900n,
      lastConfirmedEpoch: 12n,
      confirmations: 1,
    });
  });

  it("stores the detection of the beacon roots with the flags of the contract", async () => {
    const { database, context } = createContext(369, gateAnswer(true, false));
    await callHandler("BeaconForkGate:BeaconRootsDetected", { event: createEvent({}, { id: "e1" }), context });
    expect(database.row(gateEvents, { id: "e1" })).toMatchObject({ kind: "beacon_roots_detected" });
    expect(database.row(gateStates, { chainId: 369 })).toMatchObject({ enforcing: true, sealed: false, confirmations: 0 });
  });

  it("stores a canary as a number", async () => {
    const { database, context } = createContext(369, gateAnswer(false, false));
    await callHandler("BeaconForkGate:ExecutionCanaryFired", { event: createEvent({ canary: 3n }, { id: "e1" }), context });
    expect(database.row(gateEvents, { id: "e1" })).toMatchObject({ kind: "canary_fired", canary: 3 });
    expect(database.row(gateStates, { chainId: 369 })).toMatchObject({ enforcing: false });
  });
});

describe("ForkRegistry:ForkObserved", () => {
  const name = "ForkRegistry:ForkObserved";
  const args = { version: "0x04000000", slot: 77n };

  it("is registered, because the test deployment has a fork registry", () => {
    expect(handlers.has(name)).toBe(true);
  });

  it("stores the observation", async () => {
    const { database, context } = createContext(369);
    await callHandler(name, { event: createEvent(args), context });
    expect(database.rows(registryObservations)).toEqual([
      { chainId: 369, version: "0x04000000", slot: 77n, transactionHash: hashOf("aa"), blockNumber: 100n, timestamp: 1_000n },
    ]);
  });

  it("keeps the first observation of a version when it is seen again", async () => {
    const { database, context } = createContext(369);
    await callHandler(name, { event: createEvent(args), context });
    await callHandler(name, { event: createEvent({ ...args, slot: 99n }, { block: { number: 200n, timestamp: 2_000n } }), context });
    expect(database.rows(registryObservations)).toEqual([expect.objectContaining({ slot: 77n, blockNumber: 100n })]);
  });
});

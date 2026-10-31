import { ponder } from "ponder:registry";
import { chainTips, gateEvents, gateStates, headUpdates, lightClientHeads, registryObservations } from "ponder:schema";
import { beaconForkGateAbi, beaconLightClientAbi, sideOf } from "@zk-bridge/shared";
import { initialHeadColumns, readInitialHead, type ContractReader } from "../lib/initial-head";
import { ageMessages, coverMessages } from "../lib/message-store";
import { pair } from "../lib/pair";
import { recordTransactionCost } from "../lib/transaction-costs";

/** Every few blocks: store the chain clock and age the sends that passed the finality window. */
ponder.on("ChainTip:block", async ({ event, context }) => {
  const row = {
    chainId: context.chain.id,
    blockNumber: event.block.number,
    timestamp: event.block.timestamp,
    baseFeePerGas: event.block.baseFeePerGas ?? null,
  };
  await context.db.insert(chainTips).values(row).onConflictDoUpdate(row);
  await ageMessages(context.db, context.chain.id, event.block.timestamp);
  await recordInitialHead(context, event.block.number);
});

/**
 * Until the light client of this chain holds a known head, reads the head it was deployed with at this tip block. The
 * light client may be deployed a few blocks after the start block, so a tip with no code yet stores nothing and the
 * next tip tries again. Once a row exists (from a tip or an update) nothing is read.
 */
const recordInitialHead = async (context: TipContext, blockNumber: bigint): Promise<void> => {
  const chainId = context.chain.id;
  if ((await context.db.find(lightClientHeads, { chainId })) !== null) return;
  const initial = await readInitialHead(context.client as unknown as ContractReader, sideOf(pair, chainId).contracts.lightClient, blockNumber);
  if (initial === null) return;
  await context.db.insert(lightClientHeads).values({
    chainId,
    slot: initial.slot,
    headerRoot: initial.headerRoot,
    executionBlockNumber: null,
    updatedTimestamp: null,
    updateCount: 0,
    ...initialHeadColumns(initial),
  });
};

type TipContext = Parameters<Parameters<typeof ponder.on<"ChainTip:block">>[1]>[0]["context"];

/**
 * The light client on this chain stored a head of the other chain. The event holds the slot, the header root and the
 * execution block hash. The execution block number is not in the event, so the handler reads it from the contract.
 */
ponder.on("BeaconLightClient:HeadUpdated", async ({ event, context }) => {
  const chainId = context.chain.id;
  const executionBlockNumber = await context.client.readContract({
    abi: beaconLightClientAbi,
    address: sideOf(pair, chainId).contracts.lightClient,
    functionName: "executionBlockNumber",
    args: [event.args.executionBlockHash],
  });
  const receipt = event.transactionReceipt;
  const gasUsed = receipt.gasUsed;
  const effectiveGasPrice = receipt.effectiveGasPrice;
  await context.db.insert(headUpdates).values({
    chainId,
    slot: event.args.slot,
    headerRoot: event.args.headerRoot,
    executionBlockHash: event.args.executionBlockHash,
    executionBlockNumber,
    transactionHash: event.transaction.hash,
    blockNumber: event.block.number,
    timestamp: event.block.timestamp,
    gasUsed,
    effectiveGasPrice,
    costWei: gasUsed * effectiveGasPrice,
    poster: event.transaction.from,
  });
  await recordTransactionCost(context, event);
  const previous = await context.db.find(lightClientHeads, { chainId });
  // No tip read the deployment head yet (the update came first): the state one block earlier still holds it.
  const initial =
    previous === null
      ? initialHeadColumns(
          await readInitialHead(context.client as unknown as ContractReader, sideOf(pair, chainId).contracts.lightClient, event.block.number - 1n),
        )
      : {
          initialSlot: previous.initialSlot,
          initialHeadBlockNumber: previous.initialHeadBlockNumber,
          genesisTime: previous.genesisTime,
          secondsPerSlot: previous.secondsPerSlot,
        };
  const row = {
    chainId,
    slot: event.args.slot,
    headerRoot: event.args.headerRoot,
    executionBlockNumber,
    updatedTimestamp: event.block.timestamp,
    updateCount: (previous?.updateCount ?? 0) + 1,
    ...initial,
  };
  await context.db.insert(lightClientHeads).values(row).onConflictDoUpdate(row);
  await coverMessages(context.db, chainId, {
    slot: event.args.slot,
    executionBlockNumber,
    timestamp: event.block.timestamp,
  });
});

type GateContext = Parameters<Parameters<typeof ponder.on<"BeaconForkGate:ForkConfirmed">>[1]>[0]["context"];

/**
 * Writes the gate state of a chain. The mode flags come from the contract (`enforcing()` and `isSealed()`), because
 * a gate can start in enforcing mode and then no event says so. The patch adds what the event itself tells.
 */
const writeGateState = async (context: GateContext, patch: Partial<typeof gateStates.$inferInsert>): Promise<void> => {
  const chainId = context.chain.id;
  const address = sideOf(pair, chainId).contracts.gate;
  const [enforcing, sealed] = await Promise.all([
    context.client.readContract({ abi: beaconForkGateAbi, address, functionName: "enforcing" }),
    context.client.readContract({ abi: beaconForkGateAbi, address, functionName: "isSealed" }),
  ]);
  const existing = await context.db.find(gateStates, { chainId });
  const row = {
    chainId,
    sealedVersion: null,
    sealedSlot: null,
    lastConfirmedEpoch: null,
    lastConfirmedVersion: null,
    lastConfirmedTimestamp: null,
    confirmations: 0,
    ...existing,
    ...patch,
    enforcing,
    sealed,
  };
  await context.db.insert(gateStates).values(row).onConflictDoUpdate(row);
};

/** Stores one gate event row. */
const writeGateEvent = (
  context: GateContext,
  event: { id: string; block: { number: bigint; timestamp: bigint }; transaction: { hash: `0x${string}` } },
  fields: Partial<typeof gateEvents.$inferInsert> & { kind: string },
) =>
  context.db.insert(gateEvents).values({
    id: event.id,
    chainId: context.chain.id,
    epoch: null,
    version: null,
    slot: null,
    canary: null,
    transactionHash: event.transaction.hash,
    blockNumber: event.block.number,
    timestamp: event.block.timestamp,
    ...fields,
  });

ponder.on("BeaconForkGate:ForkConfirmed", async ({ event, context }) => {
  await writeGateEvent(context, event, { kind: "confirmed", epoch: event.args.epoch, version: event.args.version });
  const existing = await context.db.find(gateStates, { chainId: context.chain.id });
  await writeGateState(context, {
    lastConfirmedEpoch: event.args.epoch,
    lastConfirmedVersion: event.args.version,
    lastConfirmedTimestamp: event.block.timestamp,
    confirmations: (existing?.confirmations ?? 0) + 1,
  });
});

ponder.on("BeaconForkGate:GateSealedByFork", async ({ event, context }) => {
  await writeGateEvent(context, event, { kind: "sealed", version: event.args.version, slot: event.args.slot });
  await writeGateState(context, { sealedVersion: event.args.version, sealedSlot: event.args.slot });
});

ponder.on("BeaconForkGate:BeaconRootsDetected", async ({ event, context }) => {
  await writeGateEvent(context, event, { kind: "beacon_roots_detected" });
  await writeGateState(context, {});
});

ponder.on("BeaconForkGate:ExecutionCanaryFired", async ({ event, context }) => {
  await writeGateEvent(context, event, { kind: "canary_fired", canary: Number(event.args.canary) });
  await writeGateState(context, {});
});

if (pair.sides.some((side) => side.contracts.forkRegistry !== null)) {
  /** The fork registry on this chain observed a fork version. */
  ponder.on("ForkRegistry:ForkObserved", async ({ event, context }) => {
    const row = {
      chainId: context.chain.id,
      version: event.args.version,
      slot: event.args.slot,
      transactionHash: event.transaction.hash,
      blockNumber: event.block.number,
      timestamp: event.block.timestamp,
    };
    await context.db.insert(registryObservations).values(row).onConflictDoNothing();
  });
}

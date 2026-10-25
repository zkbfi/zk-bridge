import { db, publicClients } from "ponder:api";
import { chainTips, gateStates, lightClientHeads, bridgeStates } from "ponder:schema";
import { eq } from "ponder";
import { beaconForkGateAbi, otherSide, type PairSide } from "@zk-bridge/shared";
import { createTimedCache, fetchFinalizedSlot } from "../lib/beacon";
import { pair } from "../lib/pair";
import { numberOf } from "./views";

const finalizedSlotCache = createTimedCache<number | null>(10_000);
const blockTimestampCache = new Map<string, number | null>();

/** The timestamp of a block on a chain, cached for ever (a finalized block does not change). Null when the RPC fails. */
const blockTimestamp = async (side: PairSide, blockNumber: bigint): Promise<number | null> => {
  const key = `${side.chainId}:${blockNumber}`;
  const cached = blockTimestampCache.get(key);
  if (cached !== undefined) return cached;
  try {
    const client = (publicClients as Record<string, { getBlock: (arguments_: { blockNumber: bigint }) => Promise<{ timestamp: bigint }> }>)[side.name];
    if (client === undefined) return null;
    const block = await client.getBlock({ blockNumber });
    blockTimestampCache.set(key, Number(block.timestamp));
    return Number(block.timestamp);
  } catch {
    return null;
  }
};

/**
 * The light client view of one side. The light client on `side` tracks the beacon chain of the other side.
 *
 * @param side The chain that holds the light client.
 */
const headOf = async (side: PairSide) => {
  const tracked = otherSide(pair, side.chainId);
  const [head] = await db.select().from(lightClientHeads).where(eq(lightClientHeads.chainId, side.chainId));
  const [trackedTip] = await db.select().from(chainTips).where(eq(chainTips.chainId, tracked.chainId));
  const [ownTip] = await db.select().from(chainTips).where(eq(chainTips.chainId, side.chainId));
  const finalizedSlot =
    tracked.beaconUrl === null
      ? null
      : await finalizedSlotCache.get(tracked.beaconUrl, () => fetchFinalizedSlot(tracked.beaconUrl as string));
  const headBlockTimestamp = head === undefined ? null : await blockTimestamp(tracked, head.executionBlockNumber);
  const lagSeconds =
    headBlockTimestamp === null || trackedTip === undefined ? null : Math.max(0, Number(trackedTip.timestamp) - headBlockTimestamp);
  return {
    chainId: side.chainId,
    name: side.name,
    lightClient: side.contracts.lightClient,
    trackedChainId: tracked.chainId,
    storedHeadSlot: numberOf(head?.slot),
    storedHeadExecutionBlock: numberOf(head?.executionBlockNumber),
    storedHeadExecutionTimestamp: headBlockTimestamp,
    lastUpdateTimestamp: numberOf(head?.updatedTimestamp),
    updateCount: head?.updateCount ?? 0,
    finalizedSlot,
    lagSlots: finalizedSlot === null || head === undefined ? null : Math.max(0, finalizedSlot - Number(head.slot)),
    lagSeconds,
    trackedChainTipBlock: numberOf(trackedTip?.blockNumber),
    trackedChainTipTimestamp: numberOf(trackedTip?.timestamp),
    ownChainTipBlock: numberOf(ownTip?.blockNumber),
    ownChainTipTimestamp: numberOf(ownTip?.timestamp),
  };
};

/** The light client heads of both sides. */
export const loadHeads = () => Promise.all(pair.sides.map(headOf));

type GateFlags = { readonly enforcing: boolean; readonly sealed: boolean };

const gateFlagsCache = createTimedCache<GateFlags | null>(5_000);

/** Reads the mode flags of the gate from the chain, cached for a few seconds. Null when the chain does not answer. */
const readGateFlags = (side: PairSide): Promise<GateFlags | null> =>
  gateFlagsCache.get(String(side.chainId), async () => {
    const client = (publicClients as Record<string, { readContract: (arguments_: unknown) => Promise<unknown> }>)[side.name];
    if (client === undefined) return null;
    try {
      const address = side.contracts.gate;
      const [enforcing, sealed] = await Promise.all([
        client.readContract({ abi: beaconForkGateAbi, address, functionName: "enforcing" }),
        client.readContract({ abi: beaconForkGateAbi, address, functionName: "isSealed" }),
      ]);
      return { enforcing: enforcing === true, sealed: sealed === true };
    } catch {
      return null;
    }
  });

/** The gate and send state of one side. The mode flags are read live: a gate can start enforcing with no event. */
const gateOf = async (side: PairSide) => {
  const live = await readGateFlags(side);
  const [gate] = await db.select().from(gateStates).where(eq(gateStates.chainId, side.chainId));
  const [bridge] = await db.select().from(bridgeStates).where(eq(bridgeStates.chainId, side.chainId));
  return {
    chainId: side.chainId,
    name: side.name,
    gate: side.contracts.gate,
    enforcing: live?.enforcing ?? gate?.enforcing ?? null,
    sealed: live?.sealed ?? gate?.sealed ?? null,
    sealedVersion: gate?.sealedVersion ?? null,
    sealedSlot: numberOf(gate?.sealedSlot),
    lastConfirmedEpoch: numberOf(gate?.lastConfirmedEpoch),
    lastConfirmedVersion: gate?.lastConfirmedVersion ?? null,
    lastConfirmedTimestamp: numberOf(gate?.lastConfirmedTimestamp),
    confirmations: gate?.confirmations ?? 0,
    depositsOpen: bridge?.depositsOpen ?? false,
    depositsOpenedTimestamp: numberOf(bridge?.openedTimestamp),
  };
};

/** The gate and send state of both sides. */
export const loadGates = () => Promise.all(pair.sides.map(gateOf));

/**
 * Confirms the deposit gate of a chain for the current epoch (step 2 of the run). See `src/gate.ts` for the evidence.
 */
import type { Hex } from "viem";
import { beaconForkGateAbi } from "@zk-bridge/shared";
import { chainOf, sendFrom, type Context, type Side } from "../context.ts";
import { buildGateEvidence } from "../gate.ts";
import { record } from "../results.ts";

/** The fork version that the evidence claims. The gate proves the claim but holds no list of versions, so any value works. */
const CLAIMED_VERSION: Hex = "0x03000000";

/** Reads the epoch that the gate confirmed last, or null when it confirmed none. */
export const confirmedEpoch = async (context: Context, side: Side): Promise<bigint | null> => {
  const chain = chainOf(context, side);
  const [epoch, exists] = (await chain.publicClient.readContract({ address: chain.deployment.gate, abi: beaconForkGateAbi, functionName: "confirmedEpoch" })) as readonly [bigint, boolean];
  return exists ? epoch : null;
};

/**
 * Builds the evidence for the current epoch, writes the beacon root, and confirms the gate. It tries again when the epoch
 * changes between the read of the clock and the confirmation.
 *
 * @param context The run.
 * @param side The chain of the gate.
 * @param stage The name for the record.
 * @returns The gas that `confirm` used.
 */
export const confirmGate = async (context: Context, side: Side, stage: string): Promise<bigint> => {
  const chain = chainOf(context, side);
  const read = <Value>(functionName: string) =>
    chain.publicClient.readContract({ address: chain.deployment.gate, abi: beaconForkGateAbi, functionName } as never) as Promise<Value>;
  const [genesisTime, secondsPerSlot, slotsPerEpoch, genesisValidatorsRoot] = await Promise.all([
    read<bigint>("genesisTime"),
    read<bigint>("secondsPerSlot"),
    read<bigint>("slotsPerEpoch"),
    read<Hex>("genesisValidatorsRoot"),
  ]);
  const version = CLAIMED_VERSION;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const latest = await chain.publicClient.getBlock();
    const evidence = buildGateEvidence({ timestamp: latest.timestamp, genesisTime, secondsPerSlot, slotsPerEpoch, version, genesisValidatorsRoot });
    for (const write of evidence.storageWrites) {
      await chain.publicClient.request({
        method: "anvil_setStorageAt" as never,
        params: [context.run.beaconRoots, write.slot, write.value] as never,
      });
    }
    try {
      const sent = await sendFrom(chain, "poster", { to: chain.deployment.gate, data: encodeConfirm(evidence.encoded), gas: 500_000n }, `confirm gate ${side}`);
      record(context, { stage, name: `gate-confirm-${side}`, ok: true, data: { epoch: evidence.epoch.toString(), version, gasUsed: sent.gasUsed.toString(), attempt } });
      return sent.gasUsed;
    } catch (error) {
      console.log(`gate ${side}: attempt ${attempt} failed: ${(error as Error).message.slice(0, 200)}`);
    }
  }
  throw new Error(`the gate on chain ${side} did not confirm`);
};

import { encodeFunctionData } from "viem";
const encodeConfirm = (evidence: Hex): Hex => encodeFunctionData({ abi: beaconForkGateAbi, functionName: "confirm", args: [evidence] });

/** The epoch that the gate counts for a time. */
const epochOf = (time: bigint, gate: { genesisTime: bigint; secondsPerSlot: bigint; slotsPerEpoch: bigint }): bigint =>
  (time - gate.genesisTime) / gate.secondsPerSlot / gate.slotsPerEpoch;

/**
 * Confirms the gate when it has not confirmed the epoch of the next block. The first sender of an epoch does this before the
 * send. It does nothing for an epoch that is confirmed already.
 *
 * @returns True when it sent a confirmation.
 */
export const ensureGateConfirmed = async (context: Context, side: Side, stage: string): Promise<boolean> => {
  const chain = chainOf(context, side);
  const read = <Value>(functionName: string) =>
    chain.publicClient.readContract({ address: chain.deployment.gate, abi: beaconForkGateAbi, functionName } as never) as Promise<Value>;
  const [genesisTime, secondsPerSlot, slotsPerEpoch] = await Promise.all([read<bigint>("genesisTime"), read<bigint>("secondsPerSlot"), read<bigint>("slotsPerEpoch")]);
  const latest = await chain.publicClient.getBlock();
  // The send lands in the next block, one slot later than the latest block.
  const epoch = epochOf(latest.timestamp + secondsPerSlot, { genesisTime, secondsPerSlot, slotsPerEpoch });
  if ((await confirmedEpoch(context, side)) === epoch) return false;
  await confirmGate(context, side, stage);
  return true;
};

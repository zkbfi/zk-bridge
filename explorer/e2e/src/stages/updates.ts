/**
 * Light client updates and the opening of the bridges (steps 1 and 2 of the run).
 */
import { decodeFunctionData, type Address } from "viem";
import { beaconLightClientAbi, messageBridgeAbi } from "@zk-bridge/shared";
import { chainOf, otherSide, routeFrom, sendFrom, type Context, type Side } from "../context.ts";
import { openingProof, prove } from "../prover.ts";
import { record } from "../results.ts";

/** The head slot that the light client on a side stores. It tracks the other chain. */
export const storedHead = async (context: Context, side: Side): Promise<bigint> => {
  const chain = chainOf(context, side);
  return (await chain.publicClient.readContract({
    address: chain.deployment.light_client,
    abi: beaconLightClientAbi,
    functionName: "head",
  })) as bigint;
};

/** Whether the bridge on a side accepts sends. */
export const depositsOpen = async (context: Context, side: Side): Promise<boolean> => {
  const chain = chainOf(context, side);
  return (await chain.publicClient.readContract({ address: chain.deployment.bridge, abi: messageBridgeAbi, functionName: "depositsOpen" })) as boolean;
};

/**
 * Proves the newest update of a route and posts it to the light client of the destination.
 *
 * @param context The run.
 * @param from The side of the source beacon chain. The light client on the other side receives the update.
 * @param stage The name for the record.
 * @returns True when an update was posted, false when the head already was the newest final header.
 */
export const postUpdate = async (context: Context, from: Side, stage: string): Promise<boolean> => {
  const route = routeFrom(from);
  const outcome = await prove(context, route);
  if (outcome.kind === "nothing-to-prove") return false;
  const destination = chainOf(context, otherSide(from));
  const sent = await sendFrom(destination, "poster", { to: destination.deployment.light_client, data: outcome.proof.updateCalldata }, `update ${route}`);
  record(context, {
    stage,
    name: `update-${route}`,
    ok: true,
    data: {
      backend: outcome.proof.backend,
      startHeadSlot: outcome.proof.startHeadSlot,
      newHeadSlot: outcome.proof.newHeadSlot,
      proofBytes: (outcome.proof.proof.length - 2) / 2,
      proveSeconds: outcome.seconds,
      gasUsed: sent.gasUsed.toString(),
      transaction: sent.hash,
    },
  });
  return true;
};

/** Reads the target of an opening proof and checks that it is the bridge of the side. */
const requireBridge = (context: Context, side: Side, to: Address): void => {
  const expected = chainOf(context, side).deployment.bridge;
  if (to.toLowerCase() !== expected.toLowerCase()) throw new Error(`the opening proof names ${to}, not the bridge ${expected}`);
};

/**
 * Posts updates in both directions and opens both bridges. A bridge opens only after its own light client stored a block
 * of the other chain that came after the first update of the other light client, so the loop runs rounds.
 *
 * @param context The run.
 * @param maximumRounds The most rounds before it gives up.
 */
export const updateAndOpen = async (context: Context, maximumRounds = 8): Promise<void> => {
  for (let round = 1; round <= maximumRounds; round += 1) {
    for (const side of ["a", "b"] as const) await postUpdate(context, side, "updates");
    for (const side of ["a", "b"] as const) {
      if (await depositsOpen(context, side)) continue;
      try {
        const proof = await openingProof(context, routeFrom(side));
        requireBridge(context, side, proof.to);
        const selector = decodeFunctionData({ abi: messageBridgeAbi, data: proof.calldata }).functionName;
        const sent = await sendFrom(chainOf(context, side), "poster", { to: proof.to, data: proof.calldata, gas: 3_000_000n }, "openDeposits");
        record(context, { stage: "open", name: `${selector}-${side}`, ok: true, data: { round, gasUsed: sent.gasUsed.toString(), transaction: sent.hash } });
      } catch (error) {
        console.log(`round ${round}: bridge ${side} is not ready: ${(error as Error).message.slice(0, 300)}`);
      }
    }
    const open = await Promise.all([depositsOpen(context, "a"), depositsOpen(context, "b")]);
    if (open[0] && open[1]) {
      record(context, { stage: "open", name: "both-open", ok: true, data: { rounds: round } });
      return;
    }
    await new Promise((done) => setTimeout(done, 15_000));
  }
  throw new Error(`the bridges are not both open after ${maximumRounds} rounds`);
};

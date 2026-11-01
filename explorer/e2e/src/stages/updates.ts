/**
 * Light client updates and the opening of the bridges (steps 1 and 2 of the run). The delivery runner opens the bridges.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Address, Hex } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { beaconLightClientAbi, messageBridgeAbi } from "@zk-bridge/shared";
import { ANVIL_MNEMONIC, chainOf, otherSide, routeFrom, sendFrom, type Context, type Side } from "../context.ts";
import { spawnBackground, stopBackground, type Background } from "../processes.ts";
import { prove } from "../prover.ts";
import { record } from "../results.ts";
import { botCommand, botEnvironment, startBoard, writeBotConfiguration } from "./bots.ts";

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

/** The account of the delivery runner of the run (account 2 of the mnemonic). */
const runnerAddress = (): Address => mnemonicToAccount(ANVIL_MNEMONIC, { addressIndex: 2 }).address;

/** The `DepositsOpened` transaction of the bridge on a side, or null while it has none. */
const openingTransaction = async (context: Context, side: Side): Promise<{ readonly hash: Hex; readonly from: Address } | null> => {
  const chain = chainOf(context, side);
  const logs = await chain.publicClient.getContractEvents({ address: chain.deployment.bridge, abi: messageBridgeAbi, eventName: "DepositsOpened", fromBlock: 0n });
  const log = logs[0];
  if (log === undefined) return null;
  const transaction = await chain.publicClient.getTransaction({ hash: log.transactionHash });
  return { hash: log.transactionHash, from: transaction.from };
};

/**
 * Posts updates in both directions and lets the delivery runner open both bridges. A bridge opens only after its own light
 * client stored a block of the other chain that came after the first update of the other light client, so the loop runs
 * rounds. In each round the stage posts the updates, then runs the runner once in both directions: at start it checks
 * the bridge of its destination chain and, while it is closed, builds the opening proof and sends `openDeposits`. The
 * stage itself sends no opening; it checks that the runner's account sent both.
 *
 * @param context The run.
 * @param maximumRounds The most rounds before it gives up.
 */
export const updateAndOpen = async (context: Context, maximumRounds = 8): Promise<void> => {
  const started: Background[] = [];
  try {
    await writeBotConfiguration(context, Bun.env.E2E_INDEXER_URL ?? "http://127.0.0.1:42069", ["first-to-second", "second-to-first"]);
    const environment = botEnvironment(context, await startBoard(context, started));
    for (let round = 1; round <= maximumRounds; round += 1) {
      for (const side of ["a", "b"] as const) await postUpdate(context, side, "updates");
      const runner = await spawnBackground(context, "runner-open", botCommand(context, "runner", ["--once"]), environment, join(context.repositoryRoot, "explorer/bots"));
      started.push(runner);
      const exitCode = await runner.exited;
      if (exitCode !== 0) throw new Error(`the runner exited with code ${exitCode} in round ${round}; see ${runner.logFile}`);
      const open = await Promise.all([depositsOpen(context, "a"), depositsOpen(context, "b")]);
      if (!open[0] || !open[1]) {
        console.log(`round ${round}: open a=${open[0]} b=${open[1]}; the runner opens the rest after the next update`);
        await new Promise((done) => setTimeout(done, 15_000));
        continue;
      }
      const problems: string[] = [];
      for (const side of ["a", "b"] as const) {
        const opening = await openingTransaction(context, side);
        const byRunner = opening !== null && opening.from.toLowerCase() === runnerAddress().toLowerCase();
        if (!byRunner) problems.push(`the bridge on ${side} was not opened by the runner (${opening?.from ?? "no DepositsOpened log"})`);
        record(context, { stage: "open", name: `opened-by-runner-${side}`, ok: byRunner, data: { round, transaction: opening?.hash ?? null } });
      }
      if (problems.length > 0) throw new Error(problems.join("; "));
      const log = readFileSync(runner.logFile, "utf8");
      if (!log.includes('"deposits_opened"')) throw new Error(`the runner log ${runner.logFile} has no deposits_opened line`);
      record(context, { stage: "open", name: "both-open", ok: true, data: { rounds: round } });
      return;
    }
    throw new Error(`the bridges are not both open after ${maximumRounds} rounds`);
  } finally {
    await Promise.all(started.map((background) => stopBackground(background)));
  }
};

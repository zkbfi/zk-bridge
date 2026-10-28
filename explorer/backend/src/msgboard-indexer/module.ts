import { readFile } from "node:fs/promises";
import type { Hono } from "hono";
import { createPublicClient, http, type Address, type PublicClient } from "viem";
import {
  PROOF_DIRECTIONS,
  beaconLightClientAbi,
  loadPair,
  proofCategory,
  tryDecodeProofMessage,
  type Pair,
  type ProofDirection,
} from "@zk-bridge/shared";
import { createBoardFeed, type BoardFeed, type BoardMessage, type BoardSubscription } from "@zk-bridge/shared/msgboard";
import { assessProofPayload, payloadKey, type LightClientReader } from "@zk-bridge/shared/prover";
import { BackendConfigError } from "../config.ts";
import type { ModuleHealth } from "../health.ts";
import type { BackendModuleContext } from "../module.ts";
import { cacheLightClientReader, chooseLatest, deleteStoredProof, loadStoredProof, saveStoredProof } from "./latest-proof.ts";

/** The variable that holds the address of the msgboard node. It can carry a key, so the backend never logs it. */
export const MSGBOARD_URL_VARIABLE = "EXPLORER_MSGBOARD_URL";

/** How often the module reads the recent messages of the board, in milliseconds. A socket drop loses nothing longer than this. */
export const POLL_MILLISECONDS = 30_000;

/** How long the board socket waits before it connects again, in milliseconds. */
export const RECONNECT_MILLISECONDS = 2_000;

/** How many message keys the module remembers, so that it looks at a republished message once. */
const SEEN_LIMIT = 512;

/** What the indexer needs from the outside world. A test passes fakes. */
export type IndexerDependencies = {
  readonly pair: Pair;
  readonly feed: BoardFeed;
  /** One reader per direction: the light client on the destination chain of that direction. */
  readonly lightClients: Readonly<Record<ProofDirection, LightClientReader>>;
  readonly pollMilliseconds: number;
};

type IndexerState = {
  lightClients: Readonly<Record<ProofDirection, LightClientReader>> | null;
  health: ModuleHealth;
};

const states = new WeakMap<BackendModuleContext, IndexerState>();

function stateFor(context: BackendModuleContext): IndexerState {
  const known = states.get(context);
  if (known !== undefined) return known;
  const created: IndexerState = { lightClients: null, health: { state: "degraded", detail: "not started" } };
  states.set(context, created);
  return created;
}

/**
 * Reads the head, the header root of the head and the program key of a `BeaconLightClient`.
 *
 * @param client A client of the destination chain.
 * @param address The light client address.
 */
export function createLightClientReader(client: Pick<PublicClient, "readContract">, address: Address): LightClientReader {
  return {
    async read() {
      const [headSlot, programKey] = await Promise.all([
        client.readContract({ address, abi: beaconLightClientAbi, functionName: "head" }),
        client.readContract({ address, abi: beaconLightClientAbi, functionName: "programVKey" }),
      ]);
      const headRoot = await client.readContract({ address, abi: beaconLightClientAbi, functionName: "headers", args: [headSlot] });
      return { headSlot: BigInt(headSlot), headRoot, programKey };
    },
  };
}

/**
 * Builds the real parts from the deployment file and the process variables.
 *
 * @param context The module context.
 * @param variables The variables that hold the msgboard address and the chain addresses.
 * @throws BackendConfigError when the msgboard address is not set.
 */
export async function buildDependencies(context: BackendModuleContext, variables: Readonly<Record<string, string | undefined>>): Promise<IndexerDependencies> {
  const boardUrl = variables[MSGBOARD_URL_VARIABLE];
  if (boardUrl === undefined || boardUrl === "") throw new BackendConfigError(`set the environment variable ${MSGBOARD_URL_VARIABLE} to the msgboard node`);
  const deployment: unknown = JSON.parse(await readFile(context.config.deploymentFile, "utf8"));
  const pair = loadPair({ pairName: context.config.pair, environment: variables, deployment });
  const readerFor = (destination: Pair["sides"][number]): LightClientReader =>
    cacheLightClientReader(createLightClientReader(createPublicClient({ transport: http(destination.rpcUrl) }), destination.contracts.lightClient), context.now);
  return {
    pair,
    feed: createBoardFeed({ boardUrl, reconnectDelayMilliseconds: RECONNECT_MILLISECONDS, logger: context.logger }),
    lightClients: { "first-to-second": readerFor(pair.sides[1]), "second-to-first": readerFor(pair.sides[0]) },
    pollMilliseconds: POLL_MILLISECONDS,
  };
}

/**
 * Adds `GET /proofs/latest/:direction`. The route reads the kept proof from the `proofs` table and checks it against
 * the head of the light client on every call, so it never serves a proof that the chain would refuse.
 */
export function register(app: Hono, context: BackendModuleContext): void {
  const state = stateFor(context);
  app.get("/proofs/latest/:direction", async (request) => {
    const direction = request.req.param("direction") as ProofDirection;
    if (!PROOF_DIRECTIONS.includes(direction)) return request.json({ error: "unknown direction" }, 404);
    const stored = loadStoredProof(context.storage, direction);
    if (stored === null) return request.json({ error: "no usable proof" }, 404);
    const head = await state.lightClients?.[direction].read().catch(() => null);
    if (head === null || head === undefined) return request.json({ error: "the light client cannot be read" }, 503);
    const decoded = tryDecodeProofMessage(stored.payload);
    if (!decoded.ok || decoded.message.startSlot !== head.headSlot || decoded.message.startRoot.toLowerCase() !== head.headRoot.toLowerCase()) {
      // The head only moves forward, so a proof that does not start at it now never will.
      deleteStoredProof(context.storage, direction);
      return request.json({ error: "no usable proof" }, 404);
    }
    const message = decoded.message;
    return request.json({
      pair: stored.pair,
      direction,
      startSlot: message.startSlot.toString(),
      newSlot: message.newSlot.toString(),
      payload: stored.payload,
      receivedAt: stored.receivedAt,
      programKey: message.programKey,
      startRoot: message.startRoot,
      newRoot: message.newRoot,
      publicValues: message.publicValues,
      proof: message.proof,
    });
  });
}

/**
 * Starts the indexer with the real parts.
 *
 * @throws BackendConfigError when the msgboard address is not set.
 */
export async function start(context: BackendModuleContext): Promise<() => Promise<void>> {
  return startIndexer(context, await buildDependencies(context, process.env));
}

/**
 * Starts the indexer with the parts that the caller gives. It subscribes to the category of each direction, reads the
 * messages that the board holds now, and reads them again at every poll. A failed read means the socket is down: the
 * module drops the subscriptions and subscribes again at the next poll.
 *
 * @returns The function that stops the polling and closes the board.
 */
export async function startIndexer(context: BackendModuleContext, dependencies: IndexerDependencies): Promise<() => Promise<void>> {
  const state = stateFor(context);
  state.lightClients = dependencies.lightClients;
  const seen = new Set<string>();
  const subscriptions = new Map<ProofDirection, BoardSubscription>();
  let queue: Promise<void> = Promise.resolve();
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const ingest = async (direction: ProofDirection, message: BoardMessage): Promise<void> => {
    const key = payloadKey(message.data);
    if (seen.has(key)) return;
    if (seen.size >= SEEN_LIMIT) seen.clear();
    seen.add(key);
    const reader = dependencies.lightClients[direction];
    const assessment = await assessProofPayload({ payload: message.data, pairName: dependencies.pair.name, direction, lightClient: reader, prover: context.prover });
    if (!assessment.accept) {
      // A refusal for an unreadable chain may pass later, so the message gets another look.
      if (assessment.reason === "light-client-unreadable") seen.delete(key);
      context.logger.debug("proof_refused", { direction, reason: assessment.reason });
      return;
    }
    const head = await reader.read();
    const current = loadStoredProof(context.storage, direction);
    const chosen = chooseLatest(current, assessment.message, head, context.now());
    if (chosen === current) return;
    // The head moved while the proof was checked: nothing kept starts at it any more.
    if (chosen === null) return deleteStoredProof(context.storage, direction);
    saveStoredProof(context.storage, chosen);
    context.logger.info("proof_kept", { direction, startSlot: chosen.startSlot, newSlot: chosen.newSlot });
  };

  // One message at a time: each step reads the kept proof and writes it back.
  const enqueue = (direction: ProofDirection, message: BoardMessage): Promise<void> => {
    queue = queue.then(() => ingest(direction, message)).catch((error: unknown) => context.logger.warn("proof_ingest_failed", { direction, error }));
    return queue;
  };

  const subscribe = async (direction: ProofDirection): Promise<void> => {
    if (subscriptions.has(direction)) return;
    const category = proofCategory(dependencies.pair.name, direction);
    subscriptions.set(direction, await dependencies.feed.subscribe(category, (message) => void enqueue(direction, message)));
  };

  const dropSubscriptions = async (): Promise<void> => {
    const open = [...subscriptions.values()];
    subscriptions.clear();
    await Promise.allSettled(open.map((subscription) => subscription.close()));
  };

  const poll = async (): Promise<void> => {
    try {
      for (const direction of PROOF_DIRECTIONS) {
        await subscribe(direction);
        const recent = await dependencies.feed.recent(proofCategory(dependencies.pair.name, direction));
        for (const message of recent) await enqueue(direction, message);
      }
      state.health = { state: "running" };
    } catch (error) {
      state.health = { state: "degraded", detail: "the msgboard node cannot be read" };
      context.logger.warn("board_unreadable", { error });
      await dropSubscriptions();
    }
  };

  const loop = async (): Promise<void> => {
    await poll();
    if (stopped) return;
    timer = setTimeout(() => void loop(), dependencies.pollMilliseconds);
    timer.unref();
  };

  await loop();
  return async () => {
    stopped = true;
    clearTimeout(timer);
    await queue;
    await dropSubscriptions();
    await dependencies.feed.close();
    state.lightClients = null;
    state.health = { state: "degraded", detail: "stopped" };
  };
}

/** Tells the health report whether the board can be read. */
export function health(context: BackendModuleContext): ModuleHealth {
  return stateFor(context).health;
}

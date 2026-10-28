import type { Hono } from "hono";
import { createPublicClient, http } from "viem";
import {
  PROOF_DIRECTIONS,
  PROOF_MESSAGE_BYTES,
  proofCategory,
  tryDecodeProofMessage,
  type Pair,
  type ProofDirection,
} from "@zk-bridge/shared";
import { createBoardFeed, type BoardFeed, type BoardMessage, type BoardSubscription } from "@zk-bridge/shared/msgboard";
import { assessProofPayload, createLightClientReader, payloadKey } from "@zk-bridge/shared/prover";
import { BackendConfigError } from "../config.ts";
import type { ModuleHealth } from "../health.ts";
import type { BackendModuleContext } from "../module.ts";
import { cacheLightClientReader, chooseLatest, createRecentSet, deleteStoredProof, loadStoredProof, saveStoredProof, type TimedLightClientReader } from "./latest-proof.ts";

/** How often the module reads the recent messages of the board, in milliseconds. A socket drop loses nothing longer than this. */
export const POLL_MILLISECONDS = 30_000;

/** How long the board socket waits before it connects again, in milliseconds. */
export const RECONNECT_MILLISECONDS = 2_000;

/** How many message keys the module remembers, so that it looks at a republished message once. The oldest key goes first. */
export const SEEN_LIMIT = 512;

/** The most messages that wait for a check. A message that arrives when the queue is full is dropped and counted. */
export const MAXIMUM_QUEUED_MESSAGES = 64;

/** The longest payload the module queues, in characters: `0x` and two characters for each byte of the longest form. */
const MAXIMUM_PAYLOAD_CHARACTERS = 2 + PROOF_MESSAGE_BYTES * 2;

/** Refusals that pass when the head moves, so the message gets another look. */
const REFUSALS_THAT_CAN_PASS = new Set(["light-client-unreadable", "start-slot-differs-from-head", "start-root-differs-from-head"]);

/** What the indexer needs from the outside world. A test passes fakes. */
export type IndexerDependencies = {
  readonly pair: Pair;
  readonly feed: BoardFeed;
  /** One reader per direction: the light client on the destination chain of that direction. */
  readonly lightClients: Readonly<Record<ProofDirection, TimedLightClientReader>>;
  readonly pollMilliseconds: number;
  /** Accept the oracle proofs of the free test prover. Local testing only. Default false. */
  readonly acceptOracleProof: boolean;
};

type IndexerState = {
  lightClients: Readonly<Record<ProofDirection, TimedLightClientReader>> | null;
  acceptOracleProof: boolean;
  droppedMessages: number;
  health: ModuleHealth;
};

const states = new WeakMap<BackendModuleContext, IndexerState>();

function stateFor(context: BackendModuleContext): IndexerState {
  const known = states.get(context);
  if (known !== undefined) return known;
  const created: IndexerState = { lightClients: null, acceptOracleProof: false, droppedMessages: 0, health: { state: "degraded", detail: "not started" } };
  states.set(context, created);
  return created;
}

/**
 * Builds the real parts from the context: the pair, the msgboard address and the oracle setting all come from the
 * configuration. No process setting is read.
 *
 * @throws BackendConfigError when `msgboardUrl` is not set.
 */
export function buildDependencies(context: BackendModuleContext): IndexerDependencies {
  const boardUrl = context.config.msgboardUrl;
  if (boardUrl === undefined) throw new BackendConfigError("set msgboardUrl in the configuration file");
  const { pair } = context;
  const readerFor = (destination: Pair["sides"][number]): TimedLightClientReader =>
    cacheLightClientReader(createLightClientReader(createPublicClient({ transport: http(destination.rpcUrl) }), destination.contracts.lightClient), context.now);
  return {
    pair,
    feed: createBoardFeed({ boardUrl, reconnectDelayMilliseconds: RECONNECT_MILLISECONDS, logger: context.logger }),
    lightClients: { "first-to-second": readerFor(pair.sides[1]), "second-to-first": readerFor(pair.sides[0]) },
    pollMilliseconds: POLL_MILLISECONDS,
    acceptOracleProof: context.config.acceptOracleProof,
  };
}

/**
 * Adds `GET /proofs/latest/:direction`. The route reads the kept proof from the `proofs` table and checks it against
 * the head of the light client on every call, so it never serves a proof that the chain would refuse.
 *
 * - 200: the proof. `headCheckedAt` is the clock time (milliseconds since 1970) of the head read that the check used.
 *   That read is at most three seconds old, but the head can move after it. A client must read the head again before it
 *   posts the proof. The contract refuses a proof that does not start at its head.
 * - 404: nothing usable is kept (none, or the head moved past the start of the kept proof), or the direction is unknown.
 * - 503: the module cannot tell. Either the indexer is not running ("the msgboard indexer is not running") or the light
 *   client cannot be read ("the light client cannot be read"). Try again later; a 503 does not mean "no proof".
 */
export function register(app: Hono, context: BackendModuleContext): void {
  const state = stateFor(context);
  app.get("/proofs/latest/:direction", async (request) => {
    const direction = request.req.param("direction") as ProofDirection;
    if (!PROOF_DIRECTIONS.includes(direction)) return request.json({ error: "unknown direction" }, 404);
    const reader = state.lightClients?.[direction];
    if (reader === undefined) return request.json({ error: "the msgboard indexer is not running" }, 503);
    const stored = loadStoredProof(context.storage, direction);
    if (stored === null) return request.json({ error: "no usable proof" }, 404);
    const head = await reader.read().catch(() => null);
    if (head === null) return request.json({ error: "the light client cannot be read" }, 503);
    const decoded = tryDecodeProofMessage(stored.payload, { acceptOracleProof: state.acceptOracleProof });
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
      headCheckedAt: head.checkedAt,
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
 * @throws BackendConfigError when `msgboardUrl` is not set.
 */
export async function start(context: BackendModuleContext): Promise<() => Promise<void>> {
  return startIndexer(context, buildDependencies(context));
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
  state.acceptOracleProof = dependencies.acceptOracleProof;
  state.droppedMessages = 0;
  const seen = createRecentSet(SEEN_LIMIT);
  const subscriptions = new Map<ProofDirection, BoardSubscription>();
  let queue: Promise<void> = Promise.resolve();
  let queued = 0;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const ingest = async (direction: ProofDirection, message: BoardMessage): Promise<void> => {
    const key = payloadKey(message.data);
    if (seen.has(key)) return;
    seen.add(key);
    const reader = dependencies.lightClients[direction];
    const assessment = await assessProofPayload({ payload: message.data, pairName: dependencies.pair.name, direction, lightClient: reader, prover: context.prover, acceptOracleProof: dependencies.acceptOracleProof });
    if (!assessment.accept) {
      // A refusal that depends on the head (the head read may be old) may pass later, so the message gets another look.
      if (REFUSALS_THAT_CAN_PASS.has(assessment.reason)) seen.delete(key);
      context.logger.debug("proof_refused", { direction, reason: assessment.reason });
      return;
    }
    const head = await reader.read();
    const current = loadStoredProof(context.storage, direction);
    const chosen = chooseLatest(current, assessment.message, head, context.now(), { acceptOracleProof: dependencies.acceptOracleProof });
    if (chosen === current) return;
    // The head moved while the proof was checked: nothing kept starts at it any more.
    if (chosen === null) return deleteStoredProof(context.storage, direction);
    saveStoredProof(context.storage, chosen);
    context.logger.info("proof_kept", { direction, startSlot: chosen.startSlot, newSlot: chosen.newSlot });
  };

  // One message at a time: each step reads the kept proof and writes it back. The queue has a limit, and a payload over
  // the longest form is never queued, so a flood of junk on the board cannot grow memory or force work.
  const enqueue = (direction: ProofDirection, message: BoardMessage): Promise<void> => {
    if (message.data.length > MAXIMUM_PAYLOAD_CHARACTERS) return queue;
    if (queued >= MAXIMUM_QUEUED_MESSAGES) {
      state.droppedMessages += 1;
      context.logger.warn("proof_queue_full", { direction, dropped: state.droppedMessages });
      return queue;
    }
    queued += 1;
    queue = queue
      .then(() => ingest(direction, message))
      .catch((error: unknown) => context.logger.warn("proof_ingest_failed", { direction, error }))
      .finally(() => void (queued -= 1));
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

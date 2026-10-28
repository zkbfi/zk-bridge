import { readFileSync } from "node:fs";
import type { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { createPublicClient, http, type Hex } from "viem";
import { beaconLightClientAbi, loadPair, proofCategory, type Pair, type ProofDirection } from "@zk-bridge/shared";
import { createBoardPublisher, grindInWorker, type BoardPublisher } from "@zk-bridge/shared/msgboard";
import { assessProofPayload, type LightClientHead } from "@zk-bridge/shared/prover";
import type { ModuleHealth } from "../health.ts";
import type { Logger } from "../logger.ts";
import type { BackendModuleContext } from "../module.ts";
import { MAXIMUM_BODY_BYTES } from "../requests/module.ts";
import { createProofPublisher, type ProofPublisher } from "./publish.ts";
import { bearerMatches, ensureProofTable, receiveProofPackage, type ReceiveOutcome } from "./receive.ts";

/** How often the publisher retries stored proofs and checks published jobs, in milliseconds. */
export const TICK_INTERVAL_MILLISECONDS = 15_000;

/** The name of the environment variable that holds the address of the msgboard node. The address can carry a key. */
export const MSGBOARD_VARIABLE = "EXPLORER_MSGBOARD_URL";

/** The largest message the board accepts, in bytes. The node default is 8 KiB. */
const MAXIMUM_BOARD_MESSAGE_BYTES = 8192;

/** The longest time one proof of work may take, in milliseconds. */
const GRIND_TIMEOUT_MILLISECONDS = 300_000;

/** The outside world that the module touches. A test replaces the parts it needs. */
export interface WebhookSource {
  readonly environment: Readonly<Record<string, string | undefined>>;
  /** Reads and parses the deployment file. */
  readonly readDeployment: (path: string) => unknown;
  /** Builds the board side of msgboard. */
  readonly makeBoard: (boardUrl: string, logger: Logger) => BoardPublisher;
  /** Reads the head, the root of the head and the program key of a light client. */
  readonly readLightClient: (input: { rpcUrl: string; lightClient: Hex }) => Promise<LightClientHead>;
}

/** The real outside world. */
export const REAL_SOURCE: WebhookSource = {
  environment: process.env,
  readDeployment: (path) => JSON.parse(readFileSync(path, "utf8")) as unknown,
  makeBoard: (boardUrl, logger) =>
    createBoardPublisher({
      boardUrl,
      maximumMessageBytes: MAXIMUM_BOARD_MESSAGE_BYTES,
      grind: grindInWorker,
      grindTimeoutMilliseconds: GRIND_TIMEOUT_MILLISECONDS,
      logger,
    }),
  async readLightClient({ rpcUrl, lightClient }) {
    const client = createPublicClient({ transport: http(rpcUrl) });
    const [headSlot, programKey] = await Promise.all([
      client.readContract({ address: lightClient, abi: beaconLightClientAbi, functionName: "head" }),
      client.readContract({ address: lightClient, abi: beaconLightClientAbi, functionName: "programVKey" }),
    ]);
    const headRoot = await client.readContract({ address: lightClient, abi: beaconLightClientAbi, functionName: "headers", args: [headSlot] });
    return { headSlot: BigInt(headSlot), headRoot, programKey };
  },
};

type Resolved = {
  readonly bearer: string;
  readonly publisher: ProofPublisher;
  readonly assess: (input: { payload: Hex; direction: ProofDirection }) => ReturnType<typeof assessProofPayload>;
};

type ModuleState = {
  source: WebhookSource;
  resolved: Resolved | null;
  ticking: Promise<void> | null;
};

const states = new WeakMap<BackendModuleContext, ModuleState>();

function stateOf(context: BackendModuleContext): ModuleState {
  const known = states.get(context);
  if (known !== undefined) return known;
  const created: ModuleState = { source: REAL_SOURCE, resolved: null, ticking: null };
  states.set(context, created);
  return created;
}

/**
 * Replaces parts of the outside world of one context. Call it before `register` and `start`. A test uses it to avoid
 * the network, the disk and the worker thread.
 */
export function configureWebhook(context: BackendModuleContext, source: Partial<WebhookSource>): void {
  const state = stateOf(context);
  state.source = { ...state.source, ...source };
  state.resolved = null;
}

/** The side that holds the light client which a proof of this direction updates. */
function destinationOf(pair: Pair, direction: ProofDirection) {
  return direction === "first-to-second" ? pair.sides[1] : pair.sides[0];
}

function build(context: BackendModuleContext, source: WebhookSource): Resolved {
  const bearer = source.environment[context.config.webhookBearerVariable];
  if (bearer === undefined || bearer === "") throw new Error(`set the environment variable ${context.config.webhookBearerVariable}`);
  const boardUrl = source.environment[MSGBOARD_VARIABLE];
  if (boardUrl === undefined || boardUrl === "") throw new Error(`set the environment variable ${MSGBOARD_VARIABLE}`);
  const pair = loadPair({ pairName: context.config.pair, environment: source.environment, deployment: source.readDeployment(context.config.deploymentFile) });
  const readLightClient = (direction: ProofDirection): Promise<LightClientHead> => {
    const destination = destinationOf(pair, direction);
    return source.readLightClient({ rpcUrl: destination.rpcUrl, lightClient: destination.contracts.lightClient });
  };
  const publisher = createProofPublisher({
    storage: context.storage,
    board: source.makeBoard(boardUrl, context.logger),
    categoryFor: (direction) => proofCategory(context.config.pair, direction),
    heads: { headSlot: async (direction) => (await readLightClient(direction)).headSlot },
    now: context.now,
    logger: context.logger,
  });
  const assess: Resolved["assess"] = ({ payload, direction }) =>
    assessProofPayload({
      payload,
      pairName: context.config.pair,
      direction,
      prover: context.prover,
      lightClient: { read: () => readLightClient(direction) },
    });
  ensureProofTable(context.storage);
  return { bearer, publisher, assess };
}

/** The settings of the module, or the reason that they cannot be built. The result is kept after the first success. */
function resolve(context: BackendModuleContext): { ok: true; resolved: Resolved } | { ok: false; reason: string } {
  const state = stateOf(context);
  if (state.resolved !== null) return { ok: true, resolved: state.resolved };
  try {
    state.resolved = build(context, state.source);
    return { ok: true, resolved: state.resolved };
  } catch (error) {
    // The message names a variable or a file problem and never a value.
    context.logger.warn("webhook_unusable", { error });
    return { ok: false, reason: "the webhook settings cannot be used" };
  }
}

const STATUS_OF_OUTCOME: Readonly<Record<ReceiveOutcome["kind"], 202 | 400 | 404 | 409 | 422 | 503>> = {
  stored: 202,
  malformed: 400,
  "unknown-job": 404,
  "not-proving": 409,
  refused: 422,
  unavailable: 503,
};

function describeOutcome(outcome: ReceiveOutcome): Record<string, string> {
  if (outcome.kind === "stored") return { status: "stored" };
  if (outcome.kind === "refused") return { error: "the proof was refused", reason: outcome.reason };
  if (outcome.kind === "not-proving") return { error: `the job is ${outcome.status}, not proving` };
  if (outcome.kind === "unknown-job") return { error: "no such job" };
  if (outcome.kind === "malformed") return { error: "the body is not a proof package" };
  return { error: "the light client cannot be read now; send the package again" };
}

/** Adds `POST /webhook/jobs/:jobId`. The prover calls it with the bearer token, once its proof is ready. */
export function register(app: Hono, context: BackendModuleContext): void {
  // Build the settings early, so a problem shows in the log at start.
  resolve(context);
  app.post(
    "/webhook/jobs/:jobId",
    async (request, next) => {
      const current = resolve(context);
      if (!current.ok) return request.json({ error: current.reason }, 503);
      if (!bearerMatches(request.req.header("authorization"), current.resolved.bearer)) return request.json({ error: "unauthorized" }, 401);
      return next();
    },
    bodyLimit({ maxSize: MAXIMUM_BODY_BYTES, onError: (request) => request.json({ error: "the request body is too large" }, 413) }),
    async (request) => {
      const { resolved } = resolve(context) as { ok: true; resolved: Resolved };
      const jobId = request.req.param("jobId");
      const outcome = await receiveProofPackage({
        storage: context.storage,
        jobId,
        pairName: context.config.pair,
        body: await request.req.json().catch(() => null),
        assess: resolved.assess,
        now: context.now,
        logger: context.logger,
      });
      if (outcome.kind === "stored") void resolved.publisher.publish(jobId);
      return request.json(describeOutcome(outcome), STATUS_OF_OUTCOME[outcome.kind]);
    },
  );
}

/** Resolves when no proof is being posted. A test awaits it. */
export async function settled(context: BackendModuleContext): Promise<void> {
  await stateOf(context).resolved?.publisher.settled();
}

/**
 * Retries the stored proofs now and then every {@link TICK_INTERVAL_MILLISECONDS}. Resolves with the function that
 * stops the timer and waits for the running posts.
 */
export async function start(context: BackendModuleContext): Promise<() => Promise<void>> {
  const state = stateOf(context);
  const tick = (): void => {
    const current = resolve(context);
    if (!current.ok || state.ticking !== null) return;
    state.ticking = current.resolved.publisher
      .tick()
      .catch((error: unknown) => context.logger.error("webhook_tick_failed", { error }))
      .finally(() => (state.ticking = null));
  };
  tick();
  const interval = setInterval(tick, TICK_INTERVAL_MILLISECONDS);
  interval.unref();
  return async () => {
    clearInterval(interval);
    await state.ticking;
    await settled(context);
  };
}

/** Running when the settings are usable, degraded when they are not. */
export function health(context: BackendModuleContext): ModuleHealth {
  const current = resolve(context);
  return current.ok ? { state: "running" } : { state: "degraded", detail: current.reason };
}

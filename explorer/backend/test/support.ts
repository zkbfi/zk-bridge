import type { Pair, PairSide } from "@zk-bridge/shared";
import type { ProveOutcome, ProverBinary, ProofPackage } from "@zk-bridge/shared/prover";
import { parseBackendConfig, type BackendConfig, type BackendSecrets, type ModuleName } from "../src/config.ts";
import { createLogger } from "../src/logger.ts";
import type { BackendModuleContext, ModuleTable } from "../src/module.ts";
import { createApp } from "../src/app.ts";
import { MODULES } from "../src/main.ts";
import { openStorage, type Storage } from "../src/storage.ts";
import type { ProofNeed, ProofNeedReader } from "../src/requests/proof-need.ts";
import { decisionBoardOf } from "../src/watch/decisions.ts";

const address = (digit: string): `0x${string}` => `0x${digit.repeat(40)}`;

function side(name: string, chainId: number, digit: string): PairSide {
  return {
    name,
    chainId,
    rpcUrl: `http://rpc-${chainId}.invalid`,
    beaconUrl: `http://beacon-${chainId}.invalid`,
    startBlock: 1,
    finalitySeconds: 0,
    contracts: {
      bridge: address(digit),
      mediator: address(digit),
      tokenFactory: address(digit),
      wrappedNative: address(digit),
      gate: address(digit),
      lightClient: address(digit),
      deliveryRouter: null,
      forkRegistry: null,
    },
  };
}

/** A pair of the two networks that the example deployment names. */
export const PAIR: Pair = { name: "eth-pls", sides: [side("ethereum", 1, "1"), side("pulsechain", 369, "2")] };

/** The secret values of the tests. Their text is easy to find in a leak check. */
export const SECRETS = { runpodApiKey: "runpod-secret-value-1234", webhookBearer: "bearer-value-0123456789-abcdefghijklmnop-5678" };

/** The secrets as `readSecrets` gives them for {@link makeConfig}: the RunPod key under its variable, and the bearer. */
export const READ_SECRETS: BackendSecrets = { proverKeys: [{ variable: "RUNPOD_API_KEY", value: SECRETS.runpodApiKey }], webhookBearer: SECRETS.webhookBearer };

/** A valid configuration. The watch is off unless a test turns it on: it would read beacon nodes over the network. */
export function makeConfig(overrides: Record<string, unknown> = {}): BackendConfig {
  return parseBackendConfig(
    JSON.stringify({
      schemaVersion: 1,
      deploymentFile: "/nowhere/deployment.json",
      databasePath: ":memory:",
      publicUrl: "https://backend.example.org/",
      prover: { binary: "/bin/zk-bridge-prover", timeoutSeconds: 1800 },
      remote: { endpoint: "https://endpoint.example.org" },
      runpodApiKeyVariable: "RUNPOD_API_KEY",
      webhookBearerVariable: "BACKEND_WEBHOOK_BEARER",
      watch: { enabled: false },
      ...overrides,
    }),
  );
}

/** A proof package with the fields that the backend reads. */
export function makeProofPackage(startHeadSlot: number, newHeadSlot: number): ProofPackage {
  return {
    schemaVersion: 1,
    route: "ethereum_to_pulsechain",
    programKey: `0x${"11".repeat(32)}`,
    startHeadSlot,
    startHeadRoot: `0x${"22".repeat(32)}`,
    newHeadSlot,
    newHeadRoot: `0x${"33".repeat(32)}`,
    latestFinalizedSlot: newHeadSlot,
    publicValues: "0x00",
    proof: "0x00",
    updateCalldata: "0x00",
    backend: "remote",
    createdAt: "2026-10-28T00:00:00Z",
  };
}

/** A prover whose `prove` waits until the test settles it. */
export function controllableProver() {
  const calls: unknown[] = [];
  const waiting: Array<{ resolve: (outcome: ProveOutcome) => void; reject: (error: unknown) => void }> = [];
  const binary: ProverBinary = {
    prove(request) {
      calls.push(request);
      return new Promise((resolve, reject) => waiting.push({ resolve, reject }));
    },
    async evidence() {
      throw new Error("not used");
    },
    async verify() {
      throw new Error("not used");
    },
  };
  return {
    binary,
    calls,
    settleAll(outcome: ProveOutcome) {
      for (const entry of waiting.splice(0)) entry.resolve(outcome);
    },
    failAll(error: unknown) {
      for (const entry of waiting.splice(0)) entry.reject(error);
    },
  };
}

/** A silent logger that keeps its lines. */
export function memoryLogger() {
  const lines: string[] = [];
  const logger = createLogger({ write: (line) => lines.push(line), now: () => 0, knownSecrets: () => Object.values(SECRETS) });
  return { logger, lines };
}

/** A clock that the test moves. */
export function makeClock(start = 1_000_000) {
  let current = start;
  return { now: () => current, advance: (milliseconds: number) => (current += milliseconds) };
}

/**
 * A chain indexer that the test steers. By default every direction needs a proof. `answer` sets the next answers;
 * an Error makes the read fail. `reads` counts the reads.
 */
export function fakeProofNeed(initial: ProofNeed | Error = { needed: true, why: "waiting-message" }) {
  let answer: ProofNeed | Error = initial;
  const reads: Array<{ direction: string; now: number }> = [];
  const read: ProofNeedReader = async (direction, now) => {
    reads.push({ direction, now });
    if (answer instanceof Error) throw answer;
    return answer;
  };
  return { read, reads, answer: (next: ProofNeed | Error) => (answer = next) };
}

/** A context over an in-memory database, and the app on top of it. */
export function makeBackend(
  options: {
    config?: BackendConfig;
    prover?: ReturnType<typeof controllableProver>;
    enabled?: readonly ModuleName[];
    modules?: ModuleTable;
    storage?: Storage;
    proofNeed?: ReturnType<typeof fakeProofNeed>;
  } = {},
) {
  const prover = options.prover ?? controllableProver();
  const proofNeed = options.proofNeed ?? fakeProofNeed();
  const clock = makeClock();
  const log = memoryLogger();
  const storage = options.storage ?? openStorage(":memory:");
  const context: BackendModuleContext = {
    storage,
    config: options.config ?? makeConfig(),
    pair: PAIR,
    prover: prover.binary,
    proverForJob: () => prover.binary,
    readProofNeed: proofNeed.read,
    now: clock.now,
    logger: log.logger,
  };
  const app = createApp({ context, modules: options.modules ?? MODULES, enabled: options.enabled ?? ["requests"] });
  return { app, context, prover, clock, storage, log, proofNeed };
}

/** The body of a proof request. */
export const requestBody = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({ pair: "eth-pls", direction: "first-to-second", reason: "user", ...overrides });

/** Options for a POST to `/requests` from one caller address. */
export const postFrom = (remoteAddress: string, overrides: Record<string, unknown> = {}) => ({
  init: { method: "POST", headers: { "content-type": "application/json" }, body: requestBody(overrides) },
  env: { incoming: { socket: { remoteAddress } } },
});

/**
 * The answer of a node to `eth_getTransactionReceipt`: a receipt whose logs carry the given block-level indexes, in order.
 * By default the logs are numbered 0 to 399, so the position of a log in the receipt equals its block index.
 */
export function receiptResponse(logIndexes: readonly number[] = Array.from({ length: 400 }, (_, index) => index)): Response {
  return Response.json({ jsonrpc: "2.0", id: 1, result: { logs: logIndexes.map((logIndex) => ({ logIndex: `0x${logIndex.toString(16)}` })) } });
}

/** True for the JSON-RPC post that asks a node for a receipt. */
export const isNodeRequest = (init: RequestInit | undefined): boolean => init?.method === "POST";

/** The nodes of the two chains of the pair, for a test of the archive. */
export const ARCHIVE_RPC_URLS = { "1": "https://rpc-1.example.org/", "369": "https://rpc-369.example.org/" };

/**
 * Tells the request service of a backend that the watcher handled a finality of a direction (its decision board), as a
 * running watch would: a user request then proves to it, once per finality. 12 s slots: the next one is 384 s later.
 */
export function seeFinality(context: object, direction: "first-to-second" | "second-to-first", finalizedSlot: number, at: number, headSlot = 100): void {
  decisionBoardOf(context).record(direction, { at, finalizedSlot, headSlot, genesisTime: 0, secondsPerSlot: 12, due: false, why: "nothing-due", detail: "test" });
}

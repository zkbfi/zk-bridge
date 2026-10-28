import type { Pair, PairSide } from "@zk-bridge/shared";
import type { ProveOutcome, ProverBinary, ProofPackage } from "@zk-bridge/shared/prover";
import { parseBackendConfig, type BackendConfig, type ModuleName } from "../src/config.ts";
import { createLogger } from "../src/logger.ts";
import type { BackendModuleContext, ModuleTable } from "../src/module.ts";
import { createApp } from "../src/app.ts";
import { MODULES } from "../src/main.ts";
import { openStorage, type Storage } from "../src/storage.ts";

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
export const SECRETS = { runpodApiKey: "runpod-secret-value-1234", webhookBearer: "bearer-secret-value-5678" };

/** A valid configuration. */
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

/** A context over an in-memory database, and the app on top of it. */
export function makeBackend(
  options: { config?: BackendConfig; prover?: ReturnType<typeof controllableProver>; enabled?: readonly ModuleName[]; modules?: ModuleTable; storage?: Storage } = {},
) {
  const prover = options.prover ?? controllableProver();
  const clock = makeClock();
  const log = memoryLogger();
  const storage = options.storage ?? openStorage(":memory:");
  const context: BackendModuleContext = {
    storage,
    config: options.config ?? makeConfig(),
    prover: prover.binary,
    proverForJob: () => prover.binary,
    now: clock.now,
    logger: log.logger,
  };
  const app = createApp({ context, modules: options.modules ?? MODULES, enabled: options.enabled ?? ["requests"] });
  return { app, context, prover, clock, storage, log };
}

/** The body of a proof request. */
export const requestBody = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({ pair: "eth-pls", direction: "first-to-second", reason: "user", ...overrides });

/** Options for a POST to `/requests` from one caller address. */
export const postFrom = (remoteAddress: string, overrides: Record<string, unknown> = {}) => ({
  init: { method: "POST", headers: { "content-type": "application/json" }, body: requestBody(overrides) },
  env: { incoming: { socket: { remoteAddress } } },
});

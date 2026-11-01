import { z } from "zod";
import { PAIR_DEFINITIONS, PROOF_DIRECTIONS, beaconVariableName, loadPair, rpcVariableName, stateUrlsVariableName, urlSecrets, type Pair } from "@zk-bridge/shared";
import { DEFAULT_RATE_LIMITS } from "./requests/rate-limit.ts";
import { DEFAULT_WARMUP } from "./watch/decide.ts";

/** The modules that the backend can run, in the order that the example file lists them. */
export const MODULE_NAMES = ["requests", "webhook", "msgboard-indexer", "archive"] as const;

/** The name of one module. */
export type ModuleName = (typeof MODULE_NAMES)[number];

const positiveInteger = z.number().int().positive();
const variableName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "must be the name of an environment variable");

/**
 * The backend configuration file. It holds paths, endpoints, numbers and the NAMES of the environment variables that
 * carry secrets. It never holds a secret value.
 */
export const backendConfigSchema = z
  .object({
    schemaVersion: z.literal(1),
    /** The pair to serve, such as `eth-pls`. */
    pair: z.string().min(1).default("eth-pls"),
    /** The deployment file that lists the contracts of the pair. */
    deploymentFile: z.string().min(1),
    /** The SQLite file. */
    databasePath: z.string().min(1),
    listen: z
      .object({ host: z.string().min(1).default("127.0.0.1"), port: z.number().int().min(0).max(65535).default(8787) })
      .strict()
      .default({ host: "127.0.0.1", port: 8787 }),
    /**
     * Read the caller from the `X-Forwarded-For` header. Turn it on only behind a proxy that appends the address of
     * its client to the header. A client can write any text into the start of the header, so the backend counts
     * `trustedProxyHops` entries from the RIGHT: the entries that your own proxies added.
     */
    trustForwardedHeader: z.boolean().default(false),
    /** The number of proxies of yours between the internet and the backend. The caller is the entry this many places from the right. */
    trustedProxyHops: positiveInteger.default(1),
    /** The modules to run when the command line names none. */
    modules: z.array(z.enum(MODULE_NAMES)).min(1).default(["requests"]),
    /** The address of this service as the prover reaches it. The prover posts its proof to `<publicUrl>/webhook/jobs/<id>`. */
    publicUrl: z.url(),
    prover: z.object({ binary: z.string().min(1), timeoutSeconds: positiveInteger.default(1800) }).strict(),
    /** The remote proving endpoint (the load balancing endpoint of the graphics processor service). */
    remote: z.object({ endpoint: z.url() }).strict(),
    /** The NAME of the variable that holds the key of the remote proving service. */
    runpodApiKeyVariable: variableName,
    /** The NAME of the variable that holds the bearer token the webhook checks. */
    webhookBearerVariable: variableName,
    limits: z
      .object({
        requestsPerCallerPerMinute: positiveInteger.default(DEFAULT_RATE_LIMITS.requestsPerCallerPerMinute),
        requestsPerUnknownCallerPerMinute: positiveInteger.default(DEFAULT_RATE_LIMITS.requestsPerUnknownCallerPerMinute),
        globalRequestsPerMinute: positiveInteger.default(DEFAULT_RATE_LIMITS.globalRequestsPerMinute),
        requestRetentionHours: positiveInteger.default(DEFAULT_RATE_LIMITS.requestRetentionHours),
        secondsBetweenJobsPerDirection: positiveInteger.default(DEFAULT_RATE_LIMITS.secondsBetweenJobsPerDirection),
        secondsBeforeRetryAfterFailure: positiveInteger.default(DEFAULT_RATE_LIMITS.secondsBeforeRetryAfterFailure),
        jobsPerDirectionPerDay: positiveInteger.default(DEFAULT_RATE_LIMITS.jobsPerDirectionPerDay),
        keepAliveSeconds: positiveInteger.default(DEFAULT_RATE_LIMITS.keepAliveSeconds),
      })
      .strict()
      .default(DEFAULT_RATE_LIMITS),
    /**
     * The execution endpoint of each chain of the pair, by chain identifier. An endpoint can carry a key, so keep the
     * file private (mode 0600); the logger removes these values from every line.
     */
    rpcUrls: z.record(z.string().regex(/^\d+$/), z.url()).default({}),
    /** The beacon endpoint of each chain of the pair, by chain identifier. The prover reads the source chain from it. */
    beaconUrls: z.record(z.string().regex(/^\d+$/), z.url()).default({}),
    /**
     * More beacon APIs of each chain, asked in order only for states, when the beacon endpoint does not serve an old
     * state. Optional. They can carry a key; the logger removes them like the other endpoints.
     */
    stateUrls: z.record(z.string().regex(/^\d+$/), z.array(z.url())).default({}),
    /** The msgboard node (`ws://`, `wss://`, `http://` or `https://`). Needed by the webhook and the msgboard indexer. It can carry a key. */
    msgboardUrl: z.string().regex(/^(wss?|https?):\/\/\S+$/, "must be a ws, wss, http or https address").optional(),
    /**
     * Accept the short oracle proofs of the free test prover. For local testing only: a real deployment keeps it off,
     * and then only full Groth16 proofs pass. It applies to the webhook and the msgboard indexer.
     */
    acceptOracleProof: z.boolean().default(false),
    /**
     * The chain indexer. The requests module asks it whether a direction needs a proof before it starts a job, and the
     * archive module reads its work list from it. Needed when the requests module runs.
     */
    indexerUrl: z.url().optional(),
    /**
     * Prove on finality: the requests module watches the source beacon chain of each direction and starts a proof
     * within seconds of the finality (with enough signatures) that a waiting message or a keep-alive needs. See
     * README.md, "Proving on finality".
     */
    watch: z
      .object({
        /** Default: on when `indexerUrl` and the beacon endpoint of each watched source chain are set. */
        enabled: z.boolean().optional(),
        /** The directions to watch. Default: both. */
        directions: z.array(z.enum(PROOF_DIRECTIONS)).min(1).optional(),
        /** Try the beacon event stream before falling back to the poll. */
        sse: z.boolean().default(true),
        /** The poll interval while no event stream runs. Default: one slot of the source chain (12 s or 10 s). */
        pollSeconds: positiveInteger.optional(),
        /** How often to look at the sent messages for a warm-up. */
        scanSeconds: positiveInteger.default(15),
        /** Ping the remote prover (`<remote.endpoint>/ping`) shortly before a proof is expected. */
        warmup: z
          .object({
            enabled: z.boolean().default(true),
            leadSeconds: positiveInteger.default(DEFAULT_WARMUP.leadSeconds),
            intervalSeconds: positiveInteger.default(DEFAULT_WARMUP.intervalSeconds),
            graceSeconds: positiveInteger.default(DEFAULT_WARMUP.graceSeconds),
            minGapSeconds: positiveInteger.default(DEFAULT_WARMUP.minGapSeconds),
            /** How long one ping may wait while the load-balancing endpoint starts a worker. */
            pingTimeoutSeconds: positiveInteger.default(DEFAULT_WARMUP.pingTimeoutSeconds),
          })
          .strict()
          .prefault({}),
      })
      .strict()
      .prefault({}),
  })
  .strict()
  .refine((config) => config.limits.requestRetentionHours * 3600 >= config.prover.timeoutSeconds, {
    message: "limits.requestRetentionHours must not be shorter than prover.timeoutSeconds, or a waiting caller loses its request",
    path: ["limits", "requestRetentionHours"],
  });

/** The parsed backend configuration. */
export type BackendConfig = z.infer<typeof backendConfigSchema>;

/** The configuration file is not valid. */
export class BackendConfigError extends Error {
  override readonly name = "BackendConfigError";
}

/**
 * Parses the text of the configuration file.
 *
 * @throws BackendConfigError when the text is not JSON or does not match the schema.
 */
export function parseBackendConfig(text: string): BackendConfig {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new BackendConfigError("the configuration file is not JSON");
  }
  const parsed = backendConfigSchema.safeParse(value);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `${issue.path.join(".") || "(file)"}: ${issue.message}`);
    throw new BackendConfigError(`the configuration file is not valid: ${issues.join("; ")}`);
  }
  return parsed.data;
}

/** The shortest webhook bearer value that the backend accepts, in bytes. */
export const MINIMUM_BEARER_BYTES = 32;

/**
 * Reads the secrets that the configuration names from the environment.
 *
 * @throws BackendConfigError when a named variable is empty or missing, or when the webhook bearer value is shorter
 *   than 32 bytes. The message names the variable and never shows a value.
 */
export function readSecrets(config: BackendConfig, environment: Readonly<Record<string, string | undefined>>): { runpodApiKey: string; webhookBearer: string } {
  const read = (variable: string): string => {
    const value = environment[variable];
    if (value === undefined || value === "") throw new BackendConfigError(`set the environment variable ${variable}`);
    return value;
  };
  const runpodApiKey = read(config.runpodApiKeyVariable);
  const webhookBearer = read(config.webhookBearerVariable);
  if (Buffer.byteLength(webhookBearer) < MINIMUM_BEARER_BYTES) {
    throw new BackendConfigError(`the environment variable ${config.webhookBearerVariable} must hold at least ${MINIMUM_BEARER_BYTES} bytes`);
  }
  return { runpodApiKey, webhookBearer };
}

/**
 * Builds the pair from the deployment file and the endpoints of the configuration file. No environment variable is read.
 *
 * @param config The configuration.
 * @param deployment The parsed deployment file.
 * @throws BackendConfigError when a chain of the pair has no entry in `rpcUrls`, or the pair is unknown.
 */
export function loadBackendPair(config: BackendConfig, deployment: unknown): Pair {
  const definition = PAIR_DEFINITIONS.find((candidate) => candidate.name === config.pair);
  if (definition === undefined) throw new BackendConfigError(`unknown pair "${config.pair}"`);
  const environment: Record<string, string> = {};
  for (const { chainId } of definition.sides) {
    const rpcUrl = config.rpcUrls[String(chainId)];
    if (rpcUrl === undefined) throw new BackendConfigError(`rpcUrls needs an entry for chain ${chainId}`);
    environment[rpcVariableName(chainId)] = rpcUrl;
    const beaconUrl = config.beaconUrls[String(chainId)];
    if (beaconUrl !== undefined) environment[beaconVariableName(chainId)] = beaconUrl;
    const stateUrls = config.stateUrls[String(chainId)];
    if (stateUrls !== undefined) environment[stateUrlsVariableName(chainId)] = stateUrls.join(",");
  }
  return loadPair({ pairName: config.pair, environment, deployment });
}

/**
 * Every address in the configuration that can carry a key, with the deployment file endpoints of the pair when known.
 * The logger removes these, and the secret parts of each, from every line.
 */
export function endpointValues(config: BackendConfig, pair: Pair | null): string[] {
  const fromPair = (pair?.sides ?? []).flatMap((side) => [side.rpcUrl, side.beaconUrl ?? "", ...(side.stateUrls ?? [])]);
  return [...Object.values(config.rpcUrls), ...Object.values(config.beaconUrls), ...Object.values(config.stateUrls).flat(), config.msgboardUrl ?? "", config.remote.endpoint, config.indexerUrl ?? "", ...fromPair].filter((value) => value !== "");
}

/** The shortest path segment that counts as a key. Shorter segments, such as `rpc` or `evm`, are plain words. */
const MINIMUM_KEY_SEGMENT = 8;

/**
 * Every secret part of every address in the configuration: each whole address, its user name, password, path and query,
 * and each long path segment on its own (a key in a path often shows up alone in an error text).
 */
export function endpointSecrets(config: BackendConfig, pair: Pair | null): string[] {
  const pieces = endpointValues(config, pair).flatMap((url) => {
    const segments = urlSecrets(url).flatMap((piece) => piece.split(/[/?&=]/));
    return [...urlSecrets(url), ...segments.filter((segment) => segment.length >= MINIMUM_KEY_SEGMENT)];
  });
  return [...new Set(pieces)];
}

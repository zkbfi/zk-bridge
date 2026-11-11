import { z } from "zod";
import { PAIR_DEFINITIONS, PROOF_DIRECTIONS, beaconVariableName, headerRpcVariableName, handoffUrlsVariableName, loadPair, rpcVariableName, stateUrlsVariableName, urlSecrets, type Pair } from "@zk-bridge/shared";
import { SINGLE_ENDPOINT_LABEL, endpointKeyVariables, remoteEndpointListSchema, type ProverSecret, type RemoteEndpoint } from "@zk-bridge/shared/prover";
import { DEFAULT_RATE_LIMITS } from "./requests/rate-limit.ts";
import { DEFAULT_WARMUP, holdIntervalFor } from "./watch/warmup.ts";
import { signerSchema } from "../../bots/src/config/bot-config.ts";

/** The modules that the backend can run, in the order that the example file lists them. */
export const MODULE_NAMES = ["requests", "webhook", "msgboard-indexer", "archive", "seal"] as const;

/** The name of one module. */
export type ModuleName = (typeof MODULE_NAMES)[number];

const positiveInteger = z.number().int().positive();
const nonNegativeInteger = z.number().int().min(0);

/**
 * When a message proof is due (README.md, "Batching and profit"). Every field may be left out; a pair or a direction
 * overrides only what it names.
 */
const batchFields = {
  /**
   * The fallback: a batch that does not pay proves once the direction's last proof started at least this long ago.
   * With no waiting message nothing proves, however long ago the last proof was. 0 proves at the first finality that
   * covers a waiting message, whatever it pays.
   */
  minIntervalSeconds: nonNegativeInteger.optional(),
  /** Deprecated: the old name of `minIntervalSeconds`, read as it (`minIntervalSeconds` wins on the same level). */
  maxWaitSeconds: nonNegativeInteger.optional(),
  /** How far ahead the fees of messages that are not final yet count toward the time the proof is expected. Default: one epoch of the source chain. */
  lookaheadSeconds: nonNegativeInteger.optional(),
  /** The fees must reach the cost (the proof and the deliveries) times this before a batch proves early. */
  profitMargin: z.number().positive().max(1000).optional(),
};

/** The batching of one direction of a pair. */
const directionBatchSchema = z.object(batchFields).strict();

/** The batching of one pair, with overrides per direction. */
const pairBatchSchema = z
  .object({
    ...batchFields,
    directions: z.partialRecord(z.enum(PROOF_DIRECTIONS), directionBatchSchema).optional(),
  })
  .strict();

/** The names of the pairs, for the keys of `watch.pairs`. */
const PAIR_NAMES = PAIR_DEFINITIONS.map((definition) => definition.name) as [string, ...string[]];
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
    /**
     * Where the prover sends a proof job. Either `endpoint`, one load balancing endpoint whose key is in
     * `runpodApiKeyVariable`, or `endpoints`, a list in priority order (a dedicated worker first, the serverless
     * endpoint as the fallback), each with its own key variable and limits. See README.md, "Proving endpoints".
     */
    remote: z
      .object({ endpoint: z.url().optional(), endpoints: remoteEndpointListSchema.optional() })
      .strict()
      .refine((remote) => (remote.endpoint === undefined) !== (remote.endpoints === undefined), { message: "set remote.endpoint or remote.endpoints, not both and not neither" }),
    /** The NAME of the variable that holds the key of `remote.endpoint`. Not used with `remote.endpoints`. */
    runpodApiKeyVariable: variableName.optional(),
    /** The NAME of the variable that holds the bearer token the webhook checks. */
    webhookBearerVariable: variableName,
    limits: z
      .object({
        requestsPerCallerPerMinute: positiveInteger.default(DEFAULT_RATE_LIMITS.requestsPerCallerPerMinute),
        requestsPerUnknownCallerPerMinute: positiveInteger.default(DEFAULT_RATE_LIMITS.requestsPerUnknownCallerPerMinute),
        globalRequestsPerMinute: positiveInteger.default(DEFAULT_RATE_LIMITS.globalRequestsPerMinute),
        requestRetentionHours: positiveInteger.default(DEFAULT_RATE_LIMITS.requestRetentionHours),
        /** Deprecated and ignored: one job per new finality replaced it. Accepted so that older files load. */
        secondsBetweenJobsPerDirection: positiveInteger.optional(),
        secondsBeforeRetryAfterFailure: positiveInteger.default(DEFAULT_RATE_LIMITS.secondsBeforeRetryAfterFailure),
        /** Absent: the epochs per day of the direction's source chain (225 or 270). */
        jobsPerDirectionPerDay: positiveInteger.optional(),
        gpuBudgetUsdPerDirectionPerDay: z.number().min(0).max(100_000).default(DEFAULT_RATE_LIMITS.gpuBudgetUsdPerDirectionPerDay),
        keepAliveSeconds: positiveInteger.default(DEFAULT_RATE_LIMITS.keepAliveSeconds),
        pendingProofStaleSeconds: positiveInteger.default(DEFAULT_RATE_LIMITS.pendingProofStaleSeconds),
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
    /**
     * More execution RPCs of each chain, asked in order only for `debug_getRawHeader` when the RPC endpoint lacks it.
     * The `opening-proof` command reads the raw header of the other chain's block; every header is checked against its
     * block hash. Optional. They can carry a key; the logger removes them like the other endpoints.
     */
    headerRpcUrls: z.record(z.string().regex(/^\d+$/), z.array(z.url({ protocol: /^https?$/ }))).default({}),
    /**
     * More beacon APIs of each chain, asked in order for the committee handoff update of a period that the beacon
     * endpoint and the states cannot give (and for states, after `stateUrls`). A light client that missed a period border
     * moves only with these updates. Optional. They can carry a key; the logger removes them like the other endpoints.
     */
    handoffUrls: z.record(z.string().regex(/^\d+$/), z.array(z.url({ protocol: /^https?$/ }))).default({}),
    /**
     * More base URLs of the handoff archive (`<base>/<chainId>/<period>.json`), asked after this backend's own table and
     * the chain indexer's (`<indexerUrl>/api/proofs/handoffs`), such as a published IPFS tree
     * (`https://<gateway>/ipfs/<cid>/handoff-updates`). Nothing in a record is trusted: the proof checks it.
     */
    handoffArchiveUrls: z.array(z.url({ protocol: /^https?$/ })).default([]),
    /**
     * The archive module asks the prover for the handoff update of every period of each source chain once the period
     * ended (`zk-bridge-prover handoff-update`), keeps it for good in `handoff_updates`, and serves it to the prover, the
     * indexer and the proof archive. `backfillPeriods`: how many ended periods it looks back (it tries the missing ones).
     */
    handoffCapture: z
      .object({
        enabled: z.boolean().default(true),
        backfillPeriods: z.number().int().min(1).max(64).default(8),
        intervalSeconds: z.number().int().min(60).default(600),
      })
      .strict()
      .default({ enabled: true, backfillPeriods: 8, intervalSeconds: 600 }),
    /**
     * The archive module reads the sent messages of each direction from the chain indexer and, once a message's block is
     * final, asks the prover for the fork proof of that block (`zk-bridge-prover fork-proof`), while a beacon node still
     * serves its state. It keeps the record for good in `fork_proofs` and serves it to the prover, the indexer and the
     * proof archive (`archive/fork-proofs.ts`). `intervalSeconds`: how often it looks, and the first wait after a failure.
     */
    forkProofCapture: z
      .object({
        enabled: z.boolean().default(true),
        intervalSeconds: z.number().int().min(30).default(120),
      })
      .strict()
      .default({ enabled: true, intervalSeconds: 120 }),
    /**
     * More base URLs of the fork proof archive (`<base>/<chainId>/<stateRoot>.json`), asked by the `evidence` command
     * after this backend's own table and the chain indexer's (`<indexerUrl>/api/proofs/fork-proofs`), such as a published
     * IPFS tree (`https://<gateway>/ipfs/<cid>/fork-proofs`). Nothing in a record is trusted: the prover checks it.
     */
    forkProofArchiveUrls: z.array(z.url({ protocol: /^https?$/ })).default([]),
    /**
     * The `seal` module: the auto-seal of the deposit gates (`seal/module.ts`). `signer` is configured as the runner's signer
     * of `explorer/bots` (README there, "Signer"): a key or a mnemonic by reference (`env:NAME`, `op://...`), a keystore
     * file, or a hardware wallet. The file never holds the secret. The account pays the gas of a seal (about 70,000 to
     * 100,000 gas, once).
     */
    seal: z
      .object({
        signer: signerSchema,
        /** The longest wait for the receipt of a seal. */
        receiptTimeoutSeconds: positiveInteger.default(180),
        /**
         * The fork observations of a chain whose gate seals from a `ForkRegistry` (`seal/observe-watch.ts`): proven on the
         * GPU of the proving jobs when the chain runs a fork version that the registry does not hold, then posted with
         * this signer. `retryMinutes` spaces the tries for one version, `maxProofsPerVersionPerDay` caps them.
         */
        observation: z
          .object({
            enabled: z.boolean().default(true),
            retryMinutes: positiveInteger.default(60),
            maxProofsPerVersionPerDay: positiveInteger.max(24).default(4),
          })
          .strict()
          .default({ enabled: true, retryMinutes: 60, maxProofsPerVersionPerDay: 4 }),
        /**
         * The keep-alive of the fork registry's own light client (`seal/registry-watch.ts`): when nobody updated it for one
         * sync committee period (about 22.75 hours on PulseChain), the backend proves an update on the GPU and posts it with
         * this signer, so a fold of the observation program stays short (at most 64 periods).
         */
        registryKeepAlive: z.object({ enabled: z.boolean().default(true) }).strict().default({ enabled: true }),
      })
      .strict()
      .optional(),
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
        ...batchFields,
        /** Batching per pair, and per direction inside a pair. A direction beats its pair, a pair beats these. */
        pairs: z.partialRecord(z.enum(PAIR_NAMES), pairBatchSchema).default({}),
        /**
         * Wake the remote prover (`<remote.endpoint>/ping`) a learned lead time before a proof is expected, and keep the
         * worker warm until the job starts. See README.md, "Proving on finality".
         */
        warmup: z
          .object({
            enabled: z.boolean().default(true),
            /** The quantile of the observed times to a ready worker that the lead time takes. */
            leadP: z.number().gt(0).max(1).default(DEFAULT_WARMUP.leadP),
            /** How many of the newest observations count. */
            leadObservations: positiveInteger.default(DEFAULT_WARMUP.leadObservations),
            /** Seconds added to that quantile, so the proof rarely waits for a worker that is almost ready. */
            leadMarginSeconds: z.number().min(0).max(120).default(DEFAULT_WARMUP.leadMarginSeconds),
            /** The lead time until there is an observation. */
            defaultLeadSeconds: positiveInteger.default(DEFAULT_WARMUP.defaultLeadSeconds),
            minLeadSeconds: positiveInteger.default(DEFAULT_WARMUP.minLeadSeconds),
            maxLeadSeconds: positiveInteger.default(DEFAULT_WARMUP.maxLeadSeconds),
            /**
             * Ping a warm worker again this long after its last ready answer. Must be below `idleTimeoutSeconds`.
             * Default: `idleTimeoutSeconds - 2`, at least 1 (3 with the default idle timeout of 5).
             */
            holdIntervalSeconds: positiveInteger.optional(),
            /** Ping again this often while no worker is ready. */
            intervalSeconds: positiveInteger.default(DEFAULT_WARMUP.intervalSeconds),
            graceSeconds: positiveInteger.default(DEFAULT_WARMUP.graceSeconds),
            /**
             * The RunPod endpoint's idle timeout, owned here: a worker is billed this long after its last request. With
             * `syncIdleTimeout` the backend sets the endpoint to this value at start-up. Also the cost estimate.
             */
            idleTimeoutSeconds: z.number().int().min(1).max(3600).default(DEFAULT_WARMUP.idleTimeoutSeconds),
            /** Set the RunPod endpoint's idle timeout to `idleTimeoutSeconds` at start-up when it differs. */
            syncIdleTimeout: z.boolean().default(DEFAULT_WARMUP.syncIdleTimeout),
            /** What the remote GPU costs per hour, in USD (the cost estimate). */
            gpuUsdPerHour: z.number().min(0).max(1000).default(DEFAULT_WARMUP.gpuUsdPerHour),
            minGapSeconds: positiveInteger.default(DEFAULT_WARMUP.minGapSeconds),
            /** The most warm-up seconds of both directions together in any 24 hours. */
            dailyCapSeconds: positiveInteger.default(DEFAULT_WARMUP.dailyCapSeconds),
            /** How long one ping may wait while the load-balancing endpoint starts a worker. */
            pingTimeoutSeconds: positiveInteger.default(DEFAULT_WARMUP.pingTimeoutSeconds),
            /** Replaced by the learned lead time on 2026-11-01. Still accepted so an older file loads; it does nothing. */
            leadSeconds: positiveInteger.optional(),
          })
          .strict()
          .transform((warmup) => ({ ...warmup, holdIntervalSeconds: warmup.holdIntervalSeconds ?? holdIntervalFor(warmup.idleTimeoutSeconds) }))
          .refine((warmup) => warmup.minLeadSeconds <= warmup.maxLeadSeconds, { message: "minLeadSeconds must not be above maxLeadSeconds", path: ["minLeadSeconds"] })
          .refine((warmup) => warmup.holdIntervalSeconds < warmup.idleTimeoutSeconds, {
            message: "holdIntervalSeconds must be below idleTimeoutSeconds, or the worker stops between two holds and every hold cold-starts it (leave holdIntervalSeconds out to derive it)",
            path: ["holdIntervalSeconds"],
          })
          .prefault({}),
      })
      .strict()
      .prefault({}),
  })
  .strict()
  .refine((config) => config.remote.endpoint === undefined || config.runpodApiKeyVariable !== undefined, {
    message: "remote.endpoint needs runpodApiKeyVariable, the NAME of the variable with its key",
    path: ["runpodApiKeyVariable"],
  })
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
 * The proving endpoints in the order the prover tries them: `remote.endpoints`, or `remote.endpoint` as a list of one
 * endpoint labelled `remote` with the key of `runpodApiKeyVariable`.
 */
export function remoteEndpoints(config: BackendConfig): readonly RemoteEndpoint[] {
  const { endpoint, endpoints } = config.remote;
  if (endpoints !== undefined) return endpoints;
  // The schema makes sure that exactly one of the two is set, and that `endpoint` comes with its key variable.
  return [{ label: SINGLE_ENDPOINT_LABEL, url: endpoint as string, apiKeyVariable: config.runpodApiKeyVariable as string }];
}

/** The secrets that the backend reads from its environment. */
export interface BackendSecrets {
  /** The key of each proving endpoint that has one, under the NAME of its variable. */
  readonly proverKeys: readonly ProverSecret[];
  readonly webhookBearer: string;
}

/**
 * Reads the secrets that the configuration names from the environment.
 *
 * @throws BackendConfigError when a named variable is empty or missing, or when the webhook bearer value is shorter
 *   than 32 bytes. The message names the variable and never shows a value.
 */
export function readSecrets(config: BackendConfig, environment: Readonly<Record<string, string | undefined>>): BackendSecrets {
  const read = (variable: string): string => {
    const value = environment[variable];
    if (value === undefined || value === "") throw new BackendConfigError(`set the environment variable ${variable}`);
    return value;
  };
  const proverKeys = endpointKeyVariables(remoteEndpoints(config)).map((variable) => ({ variable, value: read(variable) }));
  const webhookBearer = read(config.webhookBearerVariable);
  if (Buffer.byteLength(webhookBearer) < MINIMUM_BEARER_BYTES) {
    throw new BackendConfigError(`the environment variable ${config.webhookBearerVariable} must hold at least ${MINIMUM_BEARER_BYTES} bytes`);
  }
  return { proverKeys, webhookBearer };
}

/**
 * Where the warm-up ping goes: the first endpoint, with its key, or null for an endpoint without one. Only the first:
 * with a dedicated worker first, a ping of the serverless fallback would start a paid worker that no job may need.
 */
export function warmupTarget(config: BackendConfig, secrets: BackendSecrets): { endpoint: string; apiKey: string | null } {
  const first = remoteEndpoints(config)[0] as RemoteEndpoint;
  const key = secrets.proverKeys.find((candidate) => candidate.variable === first.apiKeyVariable);
  return { endpoint: first.url, apiKey: key === undefined ? null : key.value };
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
    const headerRpcUrls = config.headerRpcUrls[String(chainId)];
    if (headerRpcUrls !== undefined) environment[headerRpcVariableName(chainId)] = headerRpcUrls.join(",");
    const handoffUrls = config.handoffUrls[String(chainId)];
    if (handoffUrls !== undefined) environment[handoffUrlsVariableName(chainId)] = handoffUrls.join(",");
  }
  return loadPair({ pairName: config.pair, environment, deployment });
}

/**
 * Every address in the configuration that can carry a key, with the deployment file endpoints of the pair when known.
 * The logger removes these, and the secret parts of each, from every line.
 */
export function endpointValues(config: BackendConfig, pair: Pair | null): string[] {
  const fromPair = (pair?.sides ?? []).flatMap((side) => [side.rpcUrl, side.beaconUrl ?? "", ...(side.stateUrls ?? []), ...(side.headerRpcUrls ?? []), ...(side.handoffUrls ?? [])]);
  return [...Object.values(config.rpcUrls), ...Object.values(config.beaconUrls), ...Object.values(config.stateUrls).flat(), ...Object.values(config.headerRpcUrls).flat(), ...Object.values(config.handoffUrls).flat(), ...config.handoffArchiveUrls, ...config.forkProofArchiveUrls, config.msgboardUrl ?? "", ...remoteEndpoints(config).map((endpoint) => endpoint.url), config.indexerUrl ?? "", ...fromPair].filter((value) => value !== "");
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

/**
 * The base URLs of the handoff archive that a prover run by this backend asks, in order: this backend's own table
 * (`GET /archive/handoffs/<chainId>/<period>.json` on its listen address), the chain indexer's read route, then
 * `handoffArchiveUrls`.
 */
export function handoffArchiveBases(config: BackendConfig): string[] {
  return archiveBases(config, "handoffs", config.handoffArchiveUrls);
}

/**
 * The base URLs of the fork proof archive that a prover run by this backend asks, in order: this backend's own table
 * (`GET /archive/fork-proofs/<chainId>/<stateRoot>.json`), the chain indexer's read route, then `forkProofArchiveUrls`.
 */
export function forkProofArchiveBases(config: BackendConfig): string[] {
  return archiveBases(config, "fork-proofs", config.forkProofArchiveUrls);
}

/** This backend's own route `/archive/<name>` on its listen address (loopback for a wildcard), the indexer's, then `more`. */
function archiveBases(config: BackendConfig, name: string, more: readonly string[]): string[] {
  const host = config.listen.host === "0.0.0.0" || config.listen.host === "::" ? "127.0.0.1" : config.listen.host;
  const own = `http://${host.includes(":") ? `[${host}]` : host}:${config.listen.port}/archive/${name}`;
  const indexer = config.indexerUrl === undefined ? [] : [`${config.indexerUrl.replace(/\/+$/, "")}/api/proofs/${name}`];
  return [own, ...indexer, ...more];
}

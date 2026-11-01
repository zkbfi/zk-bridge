import { z } from "zod";
import { beaconVariableName, loadPair, rpcVariableName, type Pair } from "@zk-bridge/shared";

/** A configuration file that cannot be used. The message never holds a secret. */
export class StatusConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StatusConfigError";
  }
}

const positiveInteger = z.number().int().positive();
/** A value that is either a literal or `env:NAME`, the name of a variable that holds it. */
const reference = z.string().min(1);
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/, "must be a 20 byte hex address");
const decimal = z.string().regex(/^\d+(\.\d+)?$/, "must be a decimal number such as 0.05");

const unitSchema = z.object({ name: z.string().regex(/^[A-Za-z0-9@_.:-]+$/), optional: z.boolean().default(false) }).strict();

const DEFAULT_UNITS = [
  { name: "zk-bridge-backend", optional: false },
  { name: "zk-bridge-indexer", optional: false },
  { name: "zk-bridge-runner", optional: false },
  { name: "zk-bridge-traffic", optional: true },
  { name: "zk-bridge-ipfs", optional: false },
  { name: "zk-bridge-keepalive.timer", optional: false },
];

const DEFAULT_SERVICES = {
  indexerLocal: "http://127.0.0.1:42069",
  indexerPublic: "https://indexer.zkb.fi",
  backendLocal: "http://127.0.0.1:8787",
  backendPublic: "https://prove.zkb.fi",
  webhookPublic: "https://webhook.zkb.fi",
  gateway: "https://gateway.zkb.fi",
  sites: { next: "https://next.zkb.fi", main: "https://zkb.fi" },
};

/**
 * The status configuration file. It holds addresses, endpoints, numbers and the names of the environment variables that
 * carry secrets (`env:NAME`). It never holds a secret value.
 */
export const statusConfigSchema = z
  .object({
    schemaVersion: z.literal(1),
    listen: z
      .object({ host: z.string().min(1).default("127.0.0.1"), port: z.number().int().min(0).max(65535).default(8790) })
      .strict()
      .default({ host: "127.0.0.1", port: 8790 }),
    databasePath: z.string().min(1),
    /** The pair to watch, such as `sepolia-pls943`, and the deployment file with its contracts. */
    pair: z.string().min(1),
    deploymentFile: z.string().min(1),
    /** Seconds between two rounds of checks. */
    intervalSeconds: z.number().int().min(5).default(60),
    /** The longest one check may take. */
    timeoutSeconds: z.number().int().min(1).default(20),
    /** A service that answers slower than this is degraded. */
    slowSeconds: z.number().min(0.1).default(3),
    /** Days of history kept. */
    retentionDays: positiveInteger.default(30),
    services: z
      .object({
        indexerLocal: z.url().default(DEFAULT_SERVICES.indexerLocal),
        indexerPublic: z.url().default(DEFAULT_SERVICES.indexerPublic),
        backendLocal: z.url().default(DEFAULT_SERVICES.backendLocal),
        backendPublic: z.url().default(DEFAULT_SERVICES.backendPublic),
        webhookPublic: z.url().default(DEFAULT_SERVICES.webhookPublic),
        gateway: z.url().default(DEFAULT_SERVICES.gateway),
        sites: z.object({ next: z.url(), main: z.url() }).strict().default(DEFAULT_SERVICES.sites),
      })
      .strict()
      .default(DEFAULT_SERVICES),
    units: z.array(unitSchema).default(DEFAULT_UNITS),
    /** The endpoints of each chain of the pair, by chain identifier. */
    chains: z.record(
      z.string().regex(/^\d+$/),
      z
        .object({
          /** The name on the page, such as `Sepolia`. */
          label: z.string().min(1),
          /** The native token, such as `ETH`. */
          symbol: z.string().min(1),
          rpcUrl: reference,
          beaconUrl: reference.optional(),
          /** A block older than this is degraded; five times this is down. */
          maxBlockAgeSeconds: positiveInteger.default(120),
          /** A finalized header older than this is degraded; five times this is down. */
          maxFinalizedAgeSeconds: positiveInteger.default(1800),
        })
        .strict(),
    ),
    lightClients: z
      .object({ keepAliveSeconds: positiveInteger.default(43_200), marginSeconds: positiveInteger.default(21_600) })
      .strict()
      .default({ keepAliveSeconds: 43_200, marginSeconds: 21_600 }),
    pipeline: z
      .object({
        /** A transfer that waits longer than this for its delivery is degraded; three times this is down. */
        maxUndeliveredAgeSeconds: positiveInteger.default(7200),
        /** A proof job that runs longer than this is degraded. */
        maxJobSeconds: positiveInteger.default(3600),
      })
      .strict()
      .default({ maxUndeliveredAgeSeconds: 7200, maxJobSeconds: 3600 }),
    /** The proving endpoint at RunPod. Read through RunPod's REST API only: the endpoint itself is never called. */
    runpod: z
      .object({ endpointId: z.string().regex(/^[A-Za-z0-9]+$/), apiKey: reference, apiBase: z.url().default("https://rest.runpod.io/v1") })
      .strict()
      .optional(),
    /** The wallets to watch, with the balance under which each one is low, per chain, in the native token. */
    wallets: z
      .array(z.object({ name: z.string().min(1), address, low: z.record(z.string().regex(/^\d+$/), decimal) }).strict())
      .default([]),
  })
  .strict();

export type StatusConfig = z.infer<typeof statusConfigSchema>;

/**
 * Reads the configuration text.
 *
 * @throws StatusConfigError when the text is not JSON or breaks a rule of the schema.
 */
export function parseStatusConfig(text: string): StatusConfig {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new StatusConfigError("the configuration file is not valid JSON");
  }
  const parsed = statusConfigSchema.safeParse(value);
  if (!parsed.success) {
    throw new StatusConfigError(`the configuration file is not valid: ${parsed.error.issues.map((issue) => `${issue.path.join(".") || "(file)"} ${issue.message}`).join("; ")}`);
  }
  return parsed.data;
}

/**
 * The value of a reference: the text of `env:NAME` is the variable NAME, anything else is the value itself.
 *
 * @throws StatusConfigError when the variable is not set. The message names the variable, never a value.
 */
export function resolveReference(value: string, environment: Readonly<Record<string, string | undefined>>): string {
  if (!value.startsWith("env:")) return value;
  const name = value.slice(4);
  const resolved = environment[name];
  if (resolved === undefined || resolved === "") throw new StatusConfigError(`set the environment variable ${name}`);
  return resolved;
}

/**
 * Builds the pair from the deployment file, with the endpoints of `chains`.
 *
 * @throws StatusConfigError when a chain of the pair has no entry in `chains`, or a variable is not set.
 */
export function loadStatusPair(config: StatusConfig, deployment: unknown, environment: Readonly<Record<string, string | undefined>>): Pair {
  const endpoints: Record<string, string> = {};
  for (const [chainId, chain] of Object.entries(config.chains)) {
    endpoints[rpcVariableName(Number(chainId))] = resolveReference(chain.rpcUrl, environment);
    if (chain.beaconUrl !== undefined) endpoints[beaconVariableName(Number(chainId))] = resolveReference(chain.beaconUrl, environment);
  }
  const pair = loadPair({ pairName: config.pair, deployment, environment: endpoints, requireRpcUrl: false });
  for (const side of pair.sides) {
    if (config.chains[String(side.chainId)] === undefined) throw new StatusConfigError(`chains needs an entry for chain ${side.chainId}`);
  }
  return pair;
}

/** Every secret value the process holds: the endpoints, which can carry a key, and the RunPod key. */
export function secretValues(config: StatusConfig, environment: Readonly<Record<string, string | undefined>>): string[] {
  const values: string[] = [];
  for (const chain of Object.values(config.chains)) {
    values.push(resolveReference(chain.rpcUrl, environment));
    if (chain.beaconUrl !== undefined) values.push(resolveReference(chain.beaconUrl, environment));
  }
  if (config.runpod !== undefined) values.push(resolveReference(config.runpod.apiKey, environment));
  return values;
}

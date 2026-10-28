import { z } from "zod";
import { DEFAULT_RATE_LIMITS } from "./requests/rate-limit.ts";

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
      })
      .strict()
      .default(DEFAULT_RATE_LIMITS),
    /** The chain indexer, for the archive module. */
    indexerUrl: z.url().optional(),
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

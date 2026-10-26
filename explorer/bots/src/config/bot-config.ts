import { parseReferenceText, type SecretReference } from "@zk-bridge/shared/config";
import { z } from "zod";

/**
 * The bot configuration file: one JSON file that both bots read. It holds paths, numbers and references to secrets.
 * It never holds a secret value. The endpoints, the pair, the directions, the proving policy and the references to the
 * RunPod key and the valve.city keys live in the setup file that the terminal dashboard writes (the "Prover setup
 * view"). This file adds what only a bot needs.
 */

/** A reference to a secret in the file: an object, or the text form `env:NAME` or `op://vault/item/field`. */
export const secretReferenceSchema: z.ZodType<SecretReference> = z.union([
  z.string().transform((text, context) => {
    try {
      return parseReferenceText(text);
    } catch (error) {
      context.addIssue({ code: "custom", message: error instanceof Error ? error.message : String(error) });
      return z.NEVER;
    }
  }),
  z.object({ source: z.literal("environment"), variable: z.string().min(1) }).strict(),
  z.object({ source: z.literal("onepassword"), reference: z.string().min(1) }).strict(),
  z.object({ source: z.literal("store"), name: z.string().min(1) }).strict(),
]);

const addressSchema = z.string().regex(/^0x[0-9a-fA-F]{40}$/, "must be a 20 byte hex address");
const weiSchema = z.string().regex(/^\d+$/, "must be a whole number of wei, as text");
const positiveSeconds = z.number().int().positive();
const pathSchema = z.string().min(1);

/** Where a bot finds its secret store. */
export const secretStoreSchema = z
  .object({
    /** `system`: Keychain or Secret Service, else the encrypted file. `encrypted-file`: only the file. `none`: only environment variables and 1Password. */
    kind: z.enum(["system", "encrypted-file", "none"]).default("none"),
    /** The encrypted file. Default: the file that the dashboard uses. */
    file: pathSchema.optional(),
    /** The environment variable that holds the password of the encrypted file. */
    passwordVariable: z.string().min(1).optional(),
  })
  .strict();

/** The signer of the runner. The same kinds as the dashboard. */
export const signerSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("private-key"), key: secretReferenceSchema }).strict(),
  z.object({ kind: z.literal("keystore"), file: pathSchema, password: secretReferenceSchema }).strict(),
  z
    .object({
      kind: z.literal("mnemonic"),
      mnemonic: secretReferenceSchema,
      passphrase: secretReferenceSchema.optional(),
      pathTemplate: z.string().default("m/44'/60'/0'/0/{index}"),
      index: z.number().int().nonnegative().default(0),
    })
    .strict(),
  z
    .object({
      kind: z.enum(["ledger", "trezor"]),
      pathTemplate: z.string().default("m/44'/60'/0'/0/{index}"),
      index: z.number().int().nonnegative().default(0),
    })
    .strict(),
]);

/** The signer settings of the runner. */
export type SignerConfig = z.infer<typeof signerSchema>;

/**
 * How the publisher reaches the remote graphics processor. Only the load balancing endpoint exists today: one `POST /prove` that
 * answers when the proof is ready. A queue mode (submit, then poll or wait for a webhook) adds a case here and a case
 * in `renderProverConfig`. Nothing that calls the proof source changes.
 */
export const remoteModeSchema = z.discriminatedUnion("mode", [z.object({ mode: z.literal("load-balancing") }).strict()]);

/** The remote mode of the publisher. */
export type RemoteMode = z.infer<typeof remoteModeSchema>;

const proverBinarySchema = z
  .object({
    /** The path of the `zk-bridge-prover` binary. */
    binary: pathSchema,
    /** The seconds that one `prove` run may take. The remote backend allows up to 900 seconds per request and retries. */
    timeoutSeconds: positiveSeconds.default(1800),
  })
  .strict();

/** The publisher section. */
export const publisherSchema = z
  .object({
    prover: proverBinarySchema,
    /** The name of the environment variable that the prover reads the RunPod key from. */
    apiKeyVariable: z
      .string()
      .regex(/^[A-Z][A-Z0-9_]*$/, "must be the NAME of an environment variable in capitals")
      .default("RUNPOD_API_KEY"),
    remote: remoteModeSchema.default({ mode: "load-balancing" }),
    /** The seconds between two looks at the chain. */
    pollSeconds: positiveSeconds.default(30),
    /** The seconds after which the latest useful proof is posted again. Messages last about 120 blocks. */
    republishSeconds: positiveSeconds.default(600),
    /** The seconds to wait after a failed proving run. */
    retryBackoffSeconds: positiveSeconds.default(120),
    /** The indexer. Needed when the policy proves when a transfer waits. */
    indexerUrl: z.string().url().optional(),
  })
  .strict();

/** The runner section. */
export const runnerSchema = z
  .object({
    prover: proverBinarySchema,
    indexerUrl: z.string().url(),
    signer: signerSchema,
    pollSeconds: positiveSeconds.default(30),
    /** The runner delivers only when the fee covers the gas cost plus this many wei. */
    minimumMarginWei: weiSchema.default("0"),
    /** Deliver items that have no fee offer, for the gas cost alone. Off by default. */
    deliverWithoutOffer: z.boolean().default(false),
    /** The fee router on the destination chain. Default: the `fee_router` of the deployment file. */
    feeRouter: addressSchema.optional(),
    /**
     * The value of one whole token in wei of the native coin, as a whole number. A fee in the wrapped native token
     * needs no entry. A fee in any other token needs one, or the runner skips the item.
     */
    tokenValuationsWei: z.record(addressSchema, weiSchema).default({}),
    /** Gas for the execution when the runner cannot estimate it before the layout calls are mined. */
    executionGasFallback: z.number().int().positive().default(900_000),
    /** The priority fee in wei. Default: what the node suggests. */
    priorityFeeWei: weiSchema.optional(),
    /** The most items that one sweep delivers. */
    maximumDeliveriesPerSweep: z.number().int().positive().default(10),
    /** The most layout calls that one delivery sends before it gives up. */
    maximumPrerequisiteRounds: z.number().int().positive().default(4),
    /** Gas that the runner assumes for a layout call it cannot simulate before the call before it is mined. */
    prerequisiteGasFallback: z.number().int().positive().default(300_000),
    /**
     * The most wei that the layout calls of one sweep may cost. Required: layout rows help every sender, so an item
     * whose fee later fails the final check still costs the runner this spend. A sweep that spends on layout calls
     * also counts toward `maximumDeliveriesPerSweep`.
     */
    maximumPrerequisiteSpendPerSweepWei: weiSchema,
    /** Seconds in which the runner does not try an item again after it paid layout calls for it and did not deliver. */
    prerequisiteLossRefusalSeconds: positiveSeconds.default(1800),
    /** Seconds to wait for a receipt. */
    receiptTimeoutSeconds: positiveSeconds.default(300),
  })
  .strict();

/** The whole bot configuration file. */
export const botConfigSchema = z
  .object({
    schemaVersion: z.literal(1),
    /** The setup file that the dashboard writes. Default: the dashboard's default path. */
    setupFile: pathSchema.optional(),
    /** The deployment file that `docker/deploy.sh` writes. Default: the variable `EXPLORER_DEPLOYMENT_FILE`. */
    deploymentFile: pathSchema.optional(),
    /** Where the bots keep their state and the outcome log. */
    stateDirectory: pathSchema,
    secretStore: secretStoreSchema.default({ kind: "none" }),
    logLevel: z.enum(["debug", "info", "warn", "error"]).default("info"),
    /** The largest msgboard message that the publisher posts, in bytes. The node default is 8 KiB. */
    maximumMessageBytes: z.number().int().positive().default(8192),
    publisher: publisherSchema.optional(),
    runner: runnerSchema.optional(),
  })
  .strict();

/** The parsed bot configuration. */
export type BotConfig = z.infer<typeof botConfigSchema>;
/** The publisher section, parsed. */
export type PublisherConfig = z.infer<typeof publisherSchema>;
/** The runner section, parsed. */
export type RunnerConfig = z.infer<typeof runnerSchema>;

/** The bot configuration is not valid. The message names the field. */
export class BotConfigError extends Error {
  override readonly name = "BotConfigError";
}

/**
 * Checks a parsed JSON value and returns it as a {@link BotConfig}.
 *
 * @throws BotConfigError with the path of the first invalid field.
 */
export function parseBotConfig(value: unknown): BotConfig {
  const result = botConfigSchema.safeParse(value);
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  const where = issue === undefined ? "config" : `config.${issue.path.join(".")}`;
  throw new BotConfigError(`${where}: ${issue?.message ?? "invalid"}`);
}

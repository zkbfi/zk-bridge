import { MULTICALL3_ADDRESS, minimumPriorityFeeWei } from "@zk-bridge/shared";
import { parseReferenceText, type SecretReference } from "@zk-bridge/shared/config";
import { z } from "zod";
import { remoteEndpointListSchema } from "@zk-bridge/shared/prover";

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
      context.addIssue({ code: "custom", message: (error as Error).message });
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
export const remoteModeSchema = z.discriminatedUnion("mode", [
  z
    .object({
      mode: z.literal("load-balancing"),
      /**
       * Proving endpoints in priority order, such as a dedicated worker first and the serverless endpoint as the
       * fallback. Without it the publisher uses the one endpoint of the setup file (`endpointUrl`, `runpodApiKey`). Each
       * key comes from the environment variable that its entry names.
       */
      endpoints: remoteEndpointListSchema.optional(),
    })
    .strict(),
]);

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
    /**
     * The proving backend. `remote` is the real one and the default. `oracle` is for local testing only: the prover
     * signs with a test key, and only a local chain accepts that signature. Set it in tests and in the end-to-end run,
     * never on a live deployment.
     */
    backend: z.enum(["remote", "oracle"]).default("remote"),
    /** The name of the environment variable that holds the test key of the `oracle` backend. */
    oracleKeyVariable: z
      .string()
      .regex(/^[A-Z][A-Z0-9_]*$/, "must be the NAME of an environment variable in capitals")
      .default("ORACLE_KEY"),
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

/** The default daily cap of unpaid delivery spend, by destination chain id, in wei. */
export const DEFAULT_MAXIMUM_UNPAID_SPEND_PER_DAY_WEI: Readonly<Record<number, bigint>> = {
  11155111: 50_000_000_000_000_000n,
  943: 1_000_000n * 10n ** 18n,
};

/** The daily cap of unpaid delivery spend on a chain: the runner's own setting for the chain, else the default, else null (none). */
export function runnerUnpaidSpendCapWei(runner: RunnerConfig, chainId: number): bigint | null {
  const override = runner.maximumUnpaidSpendPerDayWei[String(chainId)];
  if (override !== undefined) return BigInt(override);
  return DEFAULT_MAXIMUM_UNPAID_SPEND_PER_DAY_WEI[chainId] ?? null;
}

/** The runner section. */
export const runnerSchema = z
  .object({
    prover: proverBinarySchema,
    indexerUrl: z.string().url(),
    signer: signerSchema,
    pollSeconds: positiveSeconds.default(30),
    /**
     * The share of its cost that the runner accepts to lose on one delivery, as a whole number from 0 to 100. The cost
     * includes the share of the light client update that the delivery carries. The runner leaves out a delivery whose loss
     * is this share or more. A left-out message stays deliverable by anyone.
     */
    maximumLossPercent: z.number().int().min(0).max(100).default(20),
    /** Deliver items that have no fee offer, for the gas cost alone. Off by default. */
    deliverWithoutOffer: z.boolean().default(false),
    /**
     * Deliver a covered item that has waited this many seconds since a stored head covered it, even when it has no fee
     * offer or its offer is below the cost. An item with an offer goes through the delivery router, which pays what the
     * offer gives; an item with none goes to the bridge. Items that pay come first in a sweep. `null` turns the rule
     * off. Default 3600 (one hour). `deliverWithoutOffer` stays the immediate rule for items with no offer.
     */
    deliverUnpaidAfterSeconds: positiveSeconds.nullable().default(3600),
    /**
     * The most wei that such unpaid deliveries may cost in a rolling 24 hours, by the chain id of the destination
     * (counted from the receipts). Defaults: 0.05 ETH for Sepolia (11155111), one million PLS for the PulseChain testnet
     * (943). A chain with no entry here and no default sends no unpaid delivery. A chain id here wins over the default.
     */
    maximumUnpaidSpendPerDayWei: z.record(z.string().regex(/^\d+$/, "must be a chain id"), weiSchema).default({}),
    /**
     * Take proofs in the oracle form (message version 2). Set it only when the light client of the destination chain
     * uses the oracle stand-in as its verifier, for local testing. Never set it on a live deployment. Default off.
     */
    acceptOracleProof: z.boolean().default(false),
    /**
     * The delivery router on the destination chain. Default: the `delivery_router` of the deployment file. The runner
     * delivers to this router and to no other. It is the operator's allowlist, not a rule of the protocol: no contract
     * of the bridge or the mediator names a router, and anyone may deploy one.
     */
    deliveryRouter: addressSchema.optional(),
    /**
     * The Multicall3 contract that batches the deliveries (`aggregate3`, failure allowed on each call). The default is
     * the canonical address, which most chains share. A chain without a contract there needs a deployment. The runner
     * checks at start that the address holds code.
     */
    multicall3: addressSchema.default(MULTICALL3_ADDRESS),
    /**
     * Deprecated and ignored, with a `config_deprecated` warning, so an old file still starts. The runner prices tips
     * from PulseX pools on PulseChain, the one price source of the dapp and the backend; a tip in a token with no price
     * pays when it is at least 1% of the amount.
     */
    tokenValuationsWei: z.record(z.string(), z.unknown()).optional(),
    /**
     * The gas that the runner assumes for one whole delivery (proof check, bridge, mediator, router) when it cannot
     * estimate it: the first fee check runs before the proof exists, and a delivery that needs a light client update in
     * its own batch cannot be estimated alone. A delivery that can be estimated uses its estimate (`eth_estimateGas`).
     */
    deliveryGasFallback: z.number().int().positive().default(1_500_000),
    /** The priority fee in wei. Default: what the node suggests. */
    priorityFeeWei: weiSchema.optional(),
    /**
     * The smallest priority fee in wei, by chain id. A smaller fee, fixed or suggested, is raised to it. Chains 369 and
     * 943 default to 0.01 gwei (`DEFAULT_MINIMUM_PRIORITY_FEE_WEI` in the shared package): their validators skip a tip
     * of 0.001 gwei or less, and such a transaction blocks every later nonce of the runner. A chain id here wins.
     */
    minimumPriorityFeeWei: z.record(z.string().regex(/^\d+$/, "must be a chain id"), weiSchema).default({}),
    /** The most items that one sweep delivers. */
    maximumDeliveriesPerSweep: z.number().int().positive().default(10),
    /** The most items that one batch transaction delivers through the delivery router. */
    maximumBatchSize: z.number().int().positive().default(5),
    /**
     * The most gas that the estimates of the items of one batch, with the light client update, may add up to. An item
     * whose own estimate is above it is sent alone, with the gas it needs, and is never cut.
     */
    maximumBatchGas: z.number().int().positive().default(6_000_000),
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
    /**
     * The most wei that layout calls may cost, reservations included, in a rolling 24 hours. Required. The runner keeps
     * the spend in its state file, so a restart does not reset it. At the limit the runner sends no layout call until the
     * window rolls. It still delivers items that need none.
     */
    maximumPrerequisiteSpendPerDayWei: weiSchema,
    /**
     * The unrecovered loss at which the runner stops sending layout calls, over a rolling 24 hours. Required. A loss is
     * the layout spend on an item that was then not delivered.
     */
    maximumUnrecoveredPrerequisiteLossWei: weiSchema,
    /** Seconds in which the runner does not try an item again after it paid layout calls for it and did not deliver. */
    prerequisiteLossRefusalSeconds: positiveSeconds.default(1800),
    /**
     * The tries of one message that may pay for layout calls and still leave it uncovered. At this count the runner sends
     * no more layout calls for the message and records it as skipped with the reason `prerequisites-stuck`; the state
     * file keeps the count and the calls that were sent, so a restart neither resets it nor sends the same call again.
     * Default 3.
     */
    maximumUnsatisfiedPrerequisiteAttempts: z.number().int().positive().default(3),
    /** Seconds to wait for a receipt. */
    receiptTimeoutSeconds: positiveSeconds.default(300),
    /**
     * Open the bridge on the destination chain when it is closed: at start and after each light client update, the
     * runner builds the opening proof with the prover, simulates `openDeposits` and sends it from its signer. Once the
     * bridge is open the runner never checks again. Default on.
     */
    openDeposits: z.boolean().default(true),
  })
  .strict();

/** An amount in whole tokens, as decimal text, such as `25` or `0.5`. */
const wholeAmountSchema = z.string().regex(/^\d+(\.\d+)?$/, "must be an amount in whole tokens, as decimal text such as 25 or 0.5");

/** A lower and an upper bound in whole tokens. The lower bound is at most the upper bound. */
const boundsSchema = z
  .object({ minimum: wholeAmountSchema, maximum: wholeAmountSchema })
  .strict()
  .refine((bounds) => Number(bounds.minimum) <= Number(bounds.maximum), "minimum must not be above maximum");

/** The settings of one test token symbol. They apply to the token of that symbol on each chain and to its bridged copy. */
export const trafficTokenSchema = z
  .object({
    /** The amount of one send, drawn at random between the bounds, in whole tokens. */
    amount: boundsSchema,
    /**
     * The band of the balance on the token's home chain, in whole tokens. Below the minimum the bot sends no more of the
     * token away and brings its copy home first. Above the maximum it sends the token away first.
     */
    balance: boundsSchema,
  })
  .strict();

/** One direction of the traffic bot. */
export const trafficDirectionSchema = z
  .object({
    enabled: z.boolean().default(true),
    /** Removed with the fixed interval. Accepted and ignored, with a `config_ignored` warning, so an old file still starts. */
    offsetSeconds: z.number().int().nonnegative().optional(),
  })
  .strict();

/**
 * How many sends a direction makes in a clock hour (UTC). At the start of each hour the bot draws a count from
 * `minPerHour` to `maxPerHour`, uniformly, and that many send times at random inside the hour. Owner: "choose a number,
 * 0-3, and that is how many bridges will be initated through the course of an hour. 0 because sometimes there will be no
 * bridges. up to 3 because sometimes there will be multiple."
 */
export const trafficCadenceSchema = z
  .object({
    minPerHour: z.number().int().nonnegative().default(0),
    maxPerHour: z.number().int().nonnegative().default(3),
    /** The least seconds between two sends of one direction. */
    minGapSeconds: z.number().int().nonnegative().default(300),
  })
  .strict()
  .refine((cadence) => cadence.maxPerHour >= cadence.minPerHour, { message: "maxPerHour must not be below minPerHour" })
  .refine((cadence) => Math.max(cadence.maxPerHour - 1, 0) * cadence.minGapSeconds < 3600, {
    message: "maxPerHour sends cannot fit in one hour with minGapSeconds between them",
  });

/** The traffic bot section: test transfers in both directions on a schedule. */
export const trafficSchema = z
  .object({
    /** The wallet that sends. It holds the test tokens and gas on both chains. */
    signer: signerSchema,
    /** The test token file that `script/testnet/DeployTestTokens.s.sol` writes: the native test tokens of each chain. */
    tokensFile: pathSchema,
    /** The settings by symbol. A token of the file without an entry here is not sent. */
    tokens: z.record(z.string().min(1), trafficTokenSchema).refine((tokens) => Object.keys(tokens).length > 0, "name at least one token"),
    /** How many sends each direction makes in an hour. Default 0 to 3, at least five minutes apart. */
    cadence: trafficCadenceSchema.default({ minPerHour: 0, maxPerHour: 3, minGapSeconds: 300 }),
    /** Removed with the fixed interval. Accepted and ignored, with a `config_ignored` warning, so an old file still starts. */
    intervalSeconds: z.number().optional(),
    /** Removed with the fixed interval. Accepted and ignored, with a `config_ignored` warning. */
    jitterSeconds: z.number().optional(),
    /** Seconds between two looks at the clock. */
    pollSeconds: positiveSeconds.default(60),
    directions: z
      .object({
        "first-to-second": trafficDirectionSchema.default({ enabled: true }),
        "second-to-first": trafficDirectionSchema.default({ enabled: true }),
      })
      .strict()
      .default({ "first-to-second": { enabled: true }, "second-to-first": { enabled: true } }),
    /**
     * The tip, as a percentage of the amount, in the share mode of the delivery router. Default 0.1: the default tip
     * of the dapp and the terminal (`DEFAULT_TIP_PERCENTAGE_MULTIPLIER`).
     */
    tipPercent: z.string().regex(/^\d+(\.\d+)?$/, "must be a percentage as decimal text, such as 0.1").default("0.1"),
    /** Removed: a send needs no gas number for a new copy. Accepted and ignored, so a configuration from before still loads. */
    newCopyGasLimit: z.unknown().optional(),
    /**
     * The beacon API that serves the state proofs of the deposit gate, by chain id. Before the first send of an epoch from
     * a chain whose gate enforces (Sepolia), the bot confirms the epoch with a proof from it. It needs the compact
     * multiproof endpoint of Lodestar (`/eth/v0/beacon/proof/state/...`); the public Lodestar nodes serve it. The proof is
     * checked against the beacon root that the chain itself holds, so the node need not be trusted. Without an entry the
     * bot uses the beacon URL of the pair for that chain (`EXPLORER_BEACON_URL_<chain id>`).
     */
    gateBeaconUrls: z.record(z.string().regex(/^\d+$/, "must be a chain id"), z.string().url()).default({}),
    /** The native coin that the wallet keeps on each chain, by chain id: no send spends below it. Each chain of the pair needs an entry. */
    minimumNativeWei: z.record(z.string().regex(/^\d+$/, "must be a chain id"), weiSchema),
    /** The priority fee in wei. Default: what the node suggests. */
    priorityFeeWei: weiSchema.optional(),
    /** The smallest priority fee in wei, by chain id, as in the runner. Chains 369 and 943 default to 0.01 gwei. */
    minimumPriorityFeeWei: z.record(z.string().regex(/^\d+$/, "must be a chain id"), weiSchema).default({}),
    /** Seconds to wait for a receipt. */
    receiptTimeoutSeconds: positiveSeconds.default(300),
  })
  .strict();

/** The traffic section, parsed. */
export type TrafficConfig = z.infer<typeof trafficSchema>;
/** The settings of one test token symbol. */
export type TrafficTokenConfig = z.infer<typeof trafficTokenSchema>;

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
    traffic: trafficSchema.optional(),
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

/** The runner settings that were removed, with the setting that replaces each. */
const REMOVED_RUNNER_SETTINGS = { minimumMarginWei: "maximumLossPercent", executionGasFallback: "deliveryGasFallback", proofCheckGas: "deliveryGasFallback" } as const;

/** The first removed runner setting that the value still names, or null. */
function removedRunnerSettingIn(value: unknown): { readonly name: string; readonly replacement: string } | null {
  const runner = typeof value === "object" && value !== null && "runner" in value ? value.runner : null;
  if (typeof runner !== "object" || runner === null) return null;
  const found = Object.entries(REMOVED_RUNNER_SETTINGS).find(([name]) => name in runner);
  return found === undefined ? null : { name: found[0], replacement: found[1] };
}

/**
 * Checks a parsed JSON value and returns it as a {@link BotConfig}.
 *
 * @throws BotConfigError with the path of the first invalid field.
 */
export function parseBotConfig(value: unknown): BotConfig {
  const removed = removedRunnerSettingIn(value);
  if (removed !== null) throw new BotConfigError(`config.runner.${removed.name}: this setting was removed. Use runner.${removed.replacement}.`);
  const result = botConfigSchema.safeParse(value);
  if (result.success) return result.data;
  // A failed parse holds at least one issue.
  const issue = result.error.issues[0] as (typeof result.error.issues)[number];
  throw new BotConfigError(`config.${issue.path.join(".")}: ${issue.message}`);
}

/**
 * The smallest priority fee that the runner sends on a chain: the runner's own setting for the chain, else the shared
 * default of the chain, else zero.
 */
export function runnerMinimumPriorityFeeWei(runner: RunnerConfig, chainId: number): bigint {
  return minimumPriorityFeeWei(chainId, runner.minimumPriorityFeeWei);
}

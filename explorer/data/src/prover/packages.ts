import { z } from "zod";

const hexSchema = z.string().regex(/^0x[0-9a-fA-F]*$/, "must be 0x hex");
const hashSchema = z.string().regex(/^0x[0-9a-fA-F]{64}$/, "must be 32 bytes of 0x hex");
const addressSchema = z.string().regex(/^0x[0-9a-fA-F]{40}$/, "must be a 20 byte hex address");

/** The proof package that `zk-bridge-prover prove` prints (`prover/README.md`, "The proof package"). */
export const proofPackageSchema = z
  .object({
    schemaVersion: z.literal(1),
    route: z.string(),
    programKey: hashSchema,
    startHeadSlot: z.number().int().nonnegative(),
    startHeadRoot: hashSchema,
    newHeadSlot: z.number().int().nonnegative(),
    newHeadRoot: hashSchema,
    latestFinalizedSlot: z.number().int().nonnegative(),
    publicValues: hexSchema,
    proof: hexSchema,
    updateCalldata: hexSchema,
    backend: z.string(),
    destination: z.object({ chainId: z.number().int(), lightClient: addressSchema }).optional(),
    createdAt: z.string(),
  })
  .passthrough();

/** One proof of one light client update, as the producer hands it off. */
export type ProofPackage = z.infer<typeof proofPackageSchema>;

/** A layout call that must go before `executeMessage`. */
export const prerequisiteSchema = z
  .object({ function: z.string(), reason: z.string(), to: addressSchema, data: hexSchema })
  .passthrough();

/** The evidence that `zk-bridge-prover evidence` prints (`prover/README.md`, "The evidence command"). */
export const evidencePackageSchema = z
  .object({
    schemaVersion: z.literal(2),
    route: z.string(),
    sourceTransactionHash: hashSchema,
    logIndex: z.number().int().nonnegative(),
    message: z
      .object({
        messageId: hashSchema,
        sender: addressSchema,
        executor: addressSchema,
        gasLimit: z.number().int().nonnegative(),
        data: hexSchema,
      })
      .passthrough(),
    destination: z.object({ chainId: z.number().int(), bridge: addressSchema, lightClient: addressSchema }).passthrough(),
    anchor: z.object({ slot: z.number().int().nonnegative(), root: hashSchema }).passthrough(),
    deliveryStatus: z.enum(["notDelivered", "succeeded"]),
    alreadyDelivered: z.boolean(),
    execute: z.object({ to: addressSchema, data: hexSchema }).passthrough(),
    prerequisites: z.array(prerequisiteSchema),
    createdAt: z.string(),
  })
  .passthrough();

/** The evidence that delivers one message. */
export type EvidencePackage = z.infer<typeof evidencePackageSchema>;
/** One layout call of an evidence package. */
export type Prerequisite = z.infer<typeof prerequisiteSchema>;

/** The answer of `zk-bridge-prover verify`. */
export const verifyResultSchema = z.object({ valid: z.literal(true), programKey: hashSchema }).passthrough();

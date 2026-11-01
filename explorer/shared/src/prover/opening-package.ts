import { z } from "zod";

const hexSchema = z.string().regex(/^0x[0-9a-fA-F]*$/, "must be 0x hex");
const addressSchema = z.string().regex(/^0x[0-9a-fA-F]{40}$/, "must be a 20 byte hex address");
const slotSchema = z.number().int().nonnegative();

/**
 * What `zk-bridge-prover opening-proof` prints: the evidence of `MessageBridge.openDeposits` for the bridge on the source
 * chain of the route. The prover checked it natively before it printed. It sends nothing: `to` and `calldata` are the
 * transaction to send. The bots read the fields below; the other fields of the output pass through.
 */
export const openingPackageSchema = z
  .object({
    route: z.string(),
    /** The bridge to open. */
    to: addressSchema,
    /** The calldata of `openDeposits(proof)`. */
    calldata: hexSchema,
    /** The chain of the bridge. */
    chainId: z.number().int(),
    /** Whether the bridge already reported open when the prover read it. */
    depositsOpen: z.boolean(),
    /** The number of the remote block whose state the proof opens: the target of `eth_getProof`. */
    remoteBlockNumber: z.number().int().nonnegative(),
    proof: z
      .object({
        /** The slot of the own light client whose stored block hash anchors the proof. */
        remoteSlot: slotSchema,
        /** The slot of the remote light client that the storage proof shows as stored. */
        storedSlot: slotSchema,
      })
      .passthrough(),
  })
  .passthrough();

/** One parsed `opening-proof` answer. */
export type OpeningPackage = z.infer<typeof openingPackageSchema>;

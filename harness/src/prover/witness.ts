import type { Hex } from 'viem'

/**
 * What the host hands to the guest.
 * The guest uses nothing else.
 */
export interface DepositWitness {
  /** RLP of the execution header. */
  readonly headerRlp: Hex
  /** Consensus-encoded receipts of the whole block, in block order. */
  readonly receipts: readonly Hex[]
  /** Index of the deposit transaction in the block. */
  readonly txIndex: number
  /** Index of the `DepositInitiated` log inside that transaction's receipt. */
  readonly logIndex: number
}

/**
 * The smallest priority fee that a chain's validators include, by chain id, in wei.
 *
 * PulseChain testnet v4 (943) never includes a transaction with a tip of 0.001 gwei or less; 0.001 gwei plus 1 wei is
 * included (measured 2026-10-29). Its base fee is a few wei, so a library default can pick a tip of 1 wei, and such a
 * transaction waits in the pool for good and holds back every later nonce of the sender. PulseChain (369) shares the
 * client, so it gets the same floor; its real tips are far above it. The floor is 0.01 gwei, ten times the limit.
 */
export const DEFAULT_MINIMUM_PRIORITY_FEE_WEI: Readonly<Record<number, bigint>> = {
  369: 10_000_000n,
  943: 10_000_000n,
};

/**
 * The minimum priority fee of a chain: the override for its chain id when there is one, else the default, else zero.
 *
 * @param chainId The chain that the transaction goes to.
 * @param overrides Minimums by chain id (decimal text), in wei.
 */
export function minimumPriorityFeeWei(chainId: number, overrides: Readonly<Record<string, string | bigint>> = {}): bigint {
  const override = overrides[String(chainId)];
  if (override !== undefined) return BigInt(override);
  return DEFAULT_MINIMUM_PRIORITY_FEE_WEI[chainId] ?? 0n;
}

/** The fee fields of an EIP-1559 transaction. */
export interface PriorityFees {
  readonly maxFeePerGas: bigint;
  readonly maxPriorityFeePerGas: bigint;
}

/**
 * Raises the tip to the minimum. The maximum fee rises by the same amount, so the room that it leaves for the base fee
 * stays the same. Fees that already meet the minimum come back unchanged.
 *
 * @param fees The fees that the node or the library suggested.
 * @param minimum The minimum priority fee, in wei.
 */
export function withMinimumPriorityFee<Fees extends PriorityFees>(fees: Fees, minimum: bigint): Fees {
  if (fees.maxPriorityFeePerGas >= minimum) return fees;
  const raise = minimum - fees.maxPriorityFeePerGas;
  return { ...fees, maxFeePerGas: fees.maxFeePerGas + raise, maxPriorityFeePerGas: minimum };
}

/**
 * The bridge fee that a relay pays, stated before any signature. The mediator charges on PulseChain in both
 * directions: when a relay leaves PulseChain, and when a delivery arrives on PulseChain. The rate follows a fixed
 * schedule that only falls, so the rate read now is the highest rate that the relay or the delivery can meet.
 */
import { feeOf } from "@terminal/format/amounts";

/** Input of {@link describeBridgeFees}. */
export type BridgeFeeInput = {
  /** The amount that the sender gives, in base units. */
  readonly amount: bigint;
  /** `currentFeeRate()` of the mediator on the source chain, scaled by 1e18. */
  readonly sourceRate: bigint;
  /** `currentFeeRate()` of the mediator on the destination chain, scaled by 1e18. */
  readonly destinationRate: bigint;
};

/** The two fees and the amounts around them. */
export type BridgeFeeDisclosure = {
  readonly sourceRate: bigint;
  /** Taken on the source chain when the relay runs. Exact at the rate that the chain reports now. */
  readonly sourceFee: bigint;
  /** What the message carries: the amount less the source fee. */
  readonly afterSourceFee: bigint;
  readonly destinationRate: bigint;
  /** Taken on the destination chain when the message is delivered. At most this, because the rate only falls. */
  readonly destinationFeeAtMost: bigint;
  /** What arrives, at the rates of now. It can only rise, by a small amount, if the destination rate falls first. */
  readonly arrivesAtLeast: bigint;
};

/**
 * Computes both bridge fees with the rounding of the contract (down).
 *
 * @param input The amount and the two rates.
 */
export const describeBridgeFees = (input: BridgeFeeInput): BridgeFeeDisclosure => {
  const sourceFee = feeOf(input.amount, input.sourceRate);
  const afterSourceFee = input.amount - sourceFee;
  const destinationFeeAtMost = feeOf(afterSourceFee, input.destinationRate);
  return {
    sourceRate: input.sourceRate,
    sourceFee,
    afterSourceFee,
    destinationRate: input.destinationRate,
    destinationFeeAtMost,
    arrivesAtLeast: afterSourceFee - destinationFeeAtMost,
  };
};

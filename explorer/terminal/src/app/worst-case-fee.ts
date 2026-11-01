/**
 * The typical size of a gas based tip, next to the hard ceiling. `limit` of the director is the signed ceiling and the
 * only "most" the sender can rely on: a deliverer who supplies more gas can still raise a gas based tip up to it. The
 * expected figure is `worstCaseFee` at the gas estimate of the app, with the gas of the follow-up call when the director
 * asks for one. The web page imports this file too, so both screens say the same numbers.
 */
import { describeFee, EXCLUDE_PRIORITY, feeModeOf, formatTokenAmount, worstCaseFee, type DescribeFeeInput, type FeeDescription, type FeeDirector } from '@zk-bridge/shared'

/** A fee description that also carries the expected size of the tip. */
export type FeeDescriptionWithExpected = FeeDescription & {
  /** The tip at the gas estimate, in base units. For a fixed fee and a share it is the exact amount, the same as the maximum. */
  readonly expectedUnits: bigint
}

/**
 * Describes a fee like `describeFee`, then adds the expected tip of a gas based fee. The maximum stays the hard ceiling
 * (`maximumFee`), and the label says both: `estimate, expected about X, at most Y`.
 *
 * @param director The fee terms. A `callGas` above zero means that a call is requested.
 * @param input What `describeFee` needs: the gas estimate (`gasUsed`) and the prices.
 */
export function describeFeeAtWorstCase(director: FeeDirector, input: DescribeFeeInput): FeeDescriptionWithExpected {
  const described = describeFee(director, input)
  if (feeModeOf(director.settings) !== 'gas') return { ...described, expectedUnits: described.maximumUnits }
  const priorityFeeWei = (director.settings & EXCLUDE_PRIORITY) === 0n ? input.priorityFeeWei : 0n
  const expectedUnits = worstCaseFee(director, {
    value: input.transferValue,
    deliveryGas: input.gasUsed,
    gasPrice: input.baseFeeWei + priorityFeeWei,
    payout: input.payout ?? 'token',
    withCall: director.callGas > 0n,
  })
  const amount = (units: bigint) => `${formatTokenAmount(units, input.token.decimals)} ${input.token.symbol}`
  const certaintyLabel = `estimate, expected about ${amount(expectedUnits)}, at most ${amount(described.maximumUnits)}`
  return { ...described, expectedUnits, certaintyLabel, summary: `${described.amountText} (${certaintyLabel})` }
}

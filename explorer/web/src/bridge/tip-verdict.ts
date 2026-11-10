/**
 * The dapp's verdict on the tip: the one tip verdict of zkb.fi (`tipVerdict` of `@zkb/core`), which the backend's
 * batching and the delivery runner use too, read from the prices the screen holds. A priced tip is judged against twice
 * the total cost (`COST_MARGIN`, the low-fee warning); a tip in a token with no price (no market, or the source
 * unreachable with no recent price) pays at the frontend's automatic maximum, 1% of the amount, and the runner then
 * delivers it straight away.
 */
import { COST_MARGIN, DEFAULT_CAP_WAD, PERCENT_WAD, WAD, isUsablePrice, nativePriceKey, tipVerdict, tokenValuationIn, type PriceMap, type PriceStates, type TipVerdict } from "@zk-bridge/shared";

/** What {@link dappTipVerdict} reads. */
export type DappTipInput = {
  /** The prices the screen holds and their states. */
  readonly prices: PriceMap | undefined;
  readonly states: PriceStates;
  /** The key of the token sent (`<side>:<address>`). */
  readonly tokenKey: string;
  readonly destinationChainId: number;
  readonly decimals: number;
  /** The amount sent and the tip, in base units of the token; null while not known. */
  readonly amount: bigint | null;
  readonly tipUnits: bigint | null;
  /** The fee and the total cost at the gas level, USD × 1e18; null without prices. */
  readonly feeUsd: bigint | null;
  readonly costUsd: bigint | null;
};

/** The automatic maximum as text: `1%`. */
export const AUTOMATIC_MAXIMUM_TEXT = `${Number(DEFAULT_CAP_WAD) / Number(PERCENT_WAD)}%`;

/**
 * The verdict on the tip, or null while there is none to judge: no amount or no tip yet, a price of the token or of the
 * destination's coin not read yet, or a priced transfer whose cost is not estimated yet.
 *
 * @param input The prices, the token, the amount, the tip, the fee and the cost.
 */
export const dappTipVerdict = (input: DappTipInput): TipVerdict | null => {
  if (input.amount === null || input.amount <= 0n || input.tipUnits === null) return null;
  if (input.states.get(input.tokenKey) === undefined || input.states.get(nativePriceKey(input.destinationChainId)) === undefined) return null;
  const valuation = tokenValuationIn({ data: input.prices, states: input.states }, input.tokenKey, input.destinationChainId, false);
  // Priced, but the cost is not estimated yet: nothing to judge.
  if (isUsablePrice(valuation.state) && input.costUsd === null) return null;
  return tipVerdict({
    amount: input.amount,
    fee: input.tipUnits,
    decimals: input.decimals,
    price: { state: valuation.state, perWholeToken: valuation.usdE18 },
    feeValue: input.feeUsd,
    cost: input.costUsd,
    rule: { kind: "margin", marginWad: COST_MARGIN * WAD },
  });
};

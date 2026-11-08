import { amountText } from "../bridge/bridge-model";

/**
 * The delivery fee of a transfer in one line, as Explore and Activity show it: "12.3 tTKN sent · 0.0123 tTKN fee (0.1%)
 * · 12.2877 tTKN received". The indexer reads the fee from the delivery router (`fee`, `received`); a transfer that no
 * router delivered has no fee line.
 */

/** What one line needs. Amounts are base units: `sent` of the source token, `fee` and `received` of the destination token. */
export type FeeSummaryInput = {
  readonly sent: bigint;
  readonly sentDecimals: number;
  readonly sentSymbol: string;
  readonly fee: bigint | null;
  readonly received: bigint | null;
  readonly decimals: number;
  readonly symbol: string;
};

/**
 * The fee as a share of what the router received (`fee + received`), with up to three significant digits, such as
 * "0.1%" or "1%". Null when the share has no meaning: an unknown fee, or nothing received and no fee.
 *
 * @param fee The fee.
 * @param received What the recipient received.
 */
export const feePercentText = (fee: bigint | null, received: bigint | null): string | null => {
  if (fee === null || received === null) return null;
  const whole = fee + received;
  if (whole === 0n) return null;
  // Basis points times 100, so 0.0123 of 12.3 is 1,000 (0.1%).
  const scaled = Number((fee * 1_000_000n) / whole) / 10_000;
  return `${Number(scaled.toPrecision(3))}%`;
};

/**
 * The parts of the line: each amount with its symbol, and the share of the fee.
 *
 * @param input The amounts and the tokens.
 * @returns Null for the fee and received parts when the indexer does not know them.
 */
export const feeSummaryParts = (input: FeeSummaryInput) => ({
  sent: `${amountText(input.sent, input.sentDecimals)} ${input.sentSymbol}`,
  fee: input.fee === null ? null : `${amountText(input.fee, input.decimals)} ${input.symbol}`,
  percent: feePercentText(input.fee, input.received),
  received: input.received === null ? null : `${amountText(input.received, input.decimals)} ${input.symbol}`,
});

/**
 * The whole line. An unknown fee says so ("fee not recorded"), and so does an unknown received amount.
 *
 * @param input The amounts and the tokens.
 */
export const feeSummaryText = (input: FeeSummaryInput): string => {
  const parts = feeSummaryParts(input);
  const fee = parts.fee === null ? "fee not recorded" : `${parts.fee} fee${parts.percent === null ? "" : ` (${parts.percent})`}`;
  const received = parts.received === null ? "received amount not recorded" : `${parts.received} received`;
  return `${parts.sent} sent · ${fee} · ${received}`;
};

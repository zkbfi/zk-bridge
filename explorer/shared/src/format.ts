/** The scale of a rate: 1e18 equals 100 percent. */
export const RATE_SCALE = 10n ** 18n;

/** Options for `formatTokenAmount`. */
export type FormatAmountOptions = {
  /** The most fraction digits to show. Digits beyond are cut, never rounded. Default: all digits. */
  readonly fractionDigits?: number;
  /** The separator between groups of three integer digits. Default: none. */
  readonly thousandsSeparator?: string;
};

const groupDigits = (digits: string, separator: string): string =>
  separator === "" ? digits : digits.replace(/\B(?=(\d{3})+(?!\d))/g, separator);

/**
 * Formats an integer amount in base units with the decimals of its token. Uses bigint only.
 * Digits beyond `fractionDigits` are cut, so a displayed value never exceeds the stored value.
 *
 * @param value The amount in base units.
 * @param decimals The decimals of the token, 0 to 255.
 * @param options Display options.
 * @throws When the decimals are not an integer from 0 to 255.
 */
export const formatTokenAmount = (value: bigint, decimals: number, options: FormatAmountOptions = {}): string => {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) throw new Error(`invalid decimals: ${decimals}`);
  const negative = value < 0n;
  const digits = (negative ? -value : value).toString().padStart(decimals + 1, "0");
  const integerPart = digits.slice(0, digits.length - decimals);
  const kept = options.fractionDigits === undefined ? decimals : Math.min(options.fractionDigits, decimals);
  const fraction = digits.slice(digits.length - decimals, digits.length - decimals + kept).replace(/0+$/, "");
  const grouped = groupDigits(integerPart, options.thousandsSeparator ?? "");
  const sign = negative ? "-" : "";
  return fraction === "" ? `${sign}${grouped}` : `${sign}${grouped}.${fraction}`;
};

/**
 * Parses a decimal amount typed by a person into base units.
 *
 * @param text A decimal such as `1.5`. No sign, no exponent.
 * @param decimals The decimals of the token.
 * @throws When the text is not a decimal or has more fraction digits than the token allows.
 */
export const parseTokenAmount = (text: string, decimals: number): bigint => {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(text.trim());
  if (match === null) throw new Error(`not a decimal amount: ${text}`);
  const fraction = match[2] ?? "";
  if (fraction.length > decimals) throw new Error(`more than ${decimals} fraction digits: ${text}`);
  return BigInt(`${match[1]}${fraction.padEnd(decimals, "0")}`);
};

/**
 * Formats a 1e18 scaled rate as a percentage. `RATE_SCALE` shows as `100`.
 *
 * @param rate The rate, scaled by 1e18.
 * @param options Display options. `fractionDigits` defaults to all digits.
 */
export const formatRate = (rate: bigint, options: FormatAmountOptions = {}): string =>
  formatTokenAmount(rate * 100n, 18, options);

/**
 * Applies a 1e18 scaled rate to an amount, rounding down as the mediator does for fees.
 *
 * @param value The amount in base units.
 * @param rate The rate, scaled by 1e18.
 */
export const applyRate = (value: bigint, rate: bigint): bigint => (value * rate) / RATE_SCALE;

/**
 * Formats a count of seconds as a short age such as `3m 05s`.
 *
 * @param seconds The count of seconds. Negative values show as zero.
 */
export const formatDuration = (seconds: number): string => {
  const whole = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const rest = whole % 60;
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  if (minutes > 0) return `${minutes}m ${String(rest).padStart(2, "0")}s`;
  return `${rest}s`;
};

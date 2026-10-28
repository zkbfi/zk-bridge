/**
 * The default gas of one delivery transaction. It is the sum that Foundry measured: the delivery router delivery call with
 * the gas based fee (about 198850 gas, `test/hardened/mediator/DeliveryRouterGas.t.sol`), plus the proof check of the bridge
 * (290655 gas, `test/hardened/MessageBridgeGas.t.sol`), plus the 21000 gas base of a transaction. The sum is 510505.
 * The default rounds it up to 550000 to leave room for calldata.
 */
export const DEFAULT_DELIVERY_GAS = 550_000n;

/** How many of the newest samples of each kind the report uses. */
export const DEFAULT_SAMPLE_LIMIT = 200;

/** The settings of the delivery cost report, read once from the environment. */
export type DeliveryCostSettings = {
  /** The newest samples of each kind that feed the figures. */
  readonly sampleLimit: number;
  /** The gas that the report gives for a kind with no samples. */
  readonly defaultGas: bigint;
};

type Environment = Readonly<Record<string, string | undefined>>;

const readPositiveInteger = (environment: Environment, name: string, fallback: string): bigint => {
  const text = (environment[name] ?? fallback).trim();
  if (!/^[1-9]\d*$/.test(text)) throw new Error(`${name} must be a positive whole number, not "${text}"`);
  return BigInt(text);
};

const readSmallPositiveInteger = (environment: Environment, name: string, fallback: number): number => {
  const value = readPositiveInteger(environment, name, String(fallback));
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`${name} is too large: ${value}`);
  return Number(value);
};

/**
 * Reads the settings of the delivery cost report. Fails at once, with the variable name, on a malformed value.
 *
 * Variables: `EXPLORER_DELIVERY_SAMPLE_LIMIT` (default 200) and `EXPLORER_DEFAULT_DELIVERY_GAS` (default 550000, see
 * {@link DEFAULT_DELIVERY_GAS}).
 *
 * @param environment The environment variables.
 * @throws When a value is malformed.
 */
export const parseDeliveryCostSettings = (environment: Environment): DeliveryCostSettings => {
  return {
    sampleLimit: readSmallPositiveInteger(environment, "EXPLORER_DELIVERY_SAMPLE_LIMIT", DEFAULT_SAMPLE_LIMIT),
    defaultGas: readPositiveInteger(environment, "EXPLORER_DEFAULT_DELIVERY_GAS", String(DEFAULT_DELIVERY_GAS)),
  };
};

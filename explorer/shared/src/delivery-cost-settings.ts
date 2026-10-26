import { DEFAULT_PROOF_COST_USD, proofCostWei } from "./delivery-fee.js";

/**
 * The default gas of one delivery transaction. It is the sum that Foundry measured: the fee router delivery call with
 * the gas based fee (about 198850 gas, `test/hardened/mediator/FeeRouterGas.t.sol`), plus the proof check of the bridge
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
  /** The cost of one proof in US dollars, as a decimal text. */
  readonly proofCostUsd: string;
  /** How many deliveries one proof covers. */
  readonly deliveriesPerProof: number;
  /** The price of the native coin in US dollars, as a decimal text, by chain identifier. A chain with no price is absent. */
  readonly nativeCoinPriceUsdByChain: Readonly<Record<number, string>>;
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

const readDecimalText = (environment: Environment, name: string): string | null => {
  const text = environment[name]?.trim();
  if (text === undefined) return null;
  if (!/^\d+(\.\d+)?$/.test(text)) throw new Error(`${name} must be a decimal such as 0.02, not "${text}"`);
  return text;
};

/**
 * Reads the settings of the delivery cost report. Fails at once, with the variable name, on a malformed value.
 *
 * Variables: `EXPLORER_DELIVERY_SAMPLE_LIMIT` (default 200), `EXPLORER_DEFAULT_DELIVERY_GAS` (default 550000, see
 * {@link DEFAULT_DELIVERY_GAS}), `EXPLORER_PROOF_COST_USD` (default from `@zk-bridge/shared`),
 * `EXPLORER_DELIVERIES_PER_PROOF` (default 1) and `EXPLORER_NATIVE_COIN_PRICE_USD_<chainId>` (no default).
 *
 * @param environment The environment variables.
 * @param chainIds The chains that the indexer follows. Only these can have a coin price.
 * @throws When a value is malformed, or a coin price is zero.
 */
export const parseDeliveryCostSettings = (environment: Environment, chainIds: readonly number[]): DeliveryCostSettings => {
  const proofCostUsd = readDecimalText(environment, "EXPLORER_PROOF_COST_USD") ?? DEFAULT_PROOF_COST_USD;
  const deliveriesPerProof = readSmallPositiveInteger(environment, "EXPLORER_DELIVERIES_PER_PROOF", 1);
  const nativeCoinPriceUsdByChain: Record<number, string> = {};
  for (const chainId of chainIds) {
    const name = `EXPLORER_NATIVE_COIN_PRICE_USD_${chainId}`;
    const price = readDecimalText(environment, name);
    if (price === null) continue;
    // Fails here, with the variable named, on a zero price or on more than 18 fraction digits.
    try {
      proofCostWei({ proofCostUsd, nativeCoinPriceUsd: price, deliveriesPerProof });
    } catch (error) {
      // `proofCostWei` throws only `Error` objects.
      throw new Error(`${name} is not usable: ${(error as Error).message}`);
    }
    nativeCoinPriceUsdByChain[chainId] = price;
  }
  return {
    sampleLimit: readSmallPositiveInteger(environment, "EXPLORER_DELIVERY_SAMPLE_LIMIT", DEFAULT_SAMPLE_LIMIT),
    defaultGas: readPositiveInteger(environment, "EXPLORER_DEFAULT_DELIVERY_GAS", String(DEFAULT_DELIVERY_GAS)),
    proofCostUsd,
    deliveriesPerProof,
    nativeCoinPriceUsdByChain,
  };
};

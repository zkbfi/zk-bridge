/**
 * The words about the tip that the web page and the terminal share, so that both always say the same thing.
 */
import { getAddress } from "viem";
import type { FeeMode } from "./delivery-terms.js";

/** The name of each tip mode, for a person. */
export const TIP_MODE_NAMES: Readonly<Record<FeeMode, string>> = {
  share: "percentage of the transfer",
  fixed: "fixed amount",
  gas: "gas based, up to the limit",
};

/** What a tip is, in one sentence. Every page and the terminal show it beside the tip. */
export const TIP_NATURE =
  "A tip goes to the reward address of the delivery router. It is voluntary and it buys no promise. A low tip, or no tip, never makes a delivery fail.";

/** The words about the suggested range of tips. */
export const TIP_RANGE_HELP =
  "The suggested tips are a low range: half, one and a half times, and the measured gas cost of a delivery at the base fee. You may set any tip from zero up. A tip below the cost is allowed.";

/** The names of the three suggested tips, in order from low to high. */
export const TIP_RANGE_NAMES = { low: "Low", default: "Suggested", high: "High" } as const;

/** How the words name the router that the tip terms are written for. */
export const DELIVERY_ROUTER_NAME = "the default delivery router";

/**
 * The router in words. A router other than the one of the deployment is marked, because the tip terms are written for
 * the delivery router.
 *
 * @param router The router of the relay.
 * @param defaultRouter The default delivery router.
 */
export const routerInWords = (router: string, defaultRouter: string): string => {
  const address = getAddress(router);
  return address === getAddress(defaultRouter) ? `${address} (${DELIVERY_ROUTER_NAME})` : `${address} (not ${DELIVERY_ROUTER_NAME})`;
};

/** The short name of the gas based mode, for a label column of 14 characters. */
export const GAS_MODE_SHORT_LABEL = "Gas, to limit";

/**
 * What the gas based mode means, for the help line. The router computes the tip from the gas that the deliverer's
 * transaction makes available. The deliverer chooses the gas limit of that transaction, and the bridge forwards only the
 * message gas limit, so gas held back above it counts. The sender should expect the tip to reach the limit.
 */
export const GAS_MODE_HELP =
  "Up to the limit; the deliverer's gas choice decides. The tip follows the gas that the deliverer's transaction makes available, so expect it to reach the limit. The limit is the price ceiling.";

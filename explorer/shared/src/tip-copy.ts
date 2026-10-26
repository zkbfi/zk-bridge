/**
 * The words about the tip that the web page and the terminal share, so that both always say the same thing.
 */
import { getAddress } from "viem";
import type { FeeMode } from "./delivery-terms.js";

/** The name of each tip mode, for a person. */
export const TIP_MODE_NAMES: Readonly<Record<FeeMode, string>> = {
  share: "percentage of the transfer",
  fixed: "fixed amount",
  gas: "gas multiplier",
};

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

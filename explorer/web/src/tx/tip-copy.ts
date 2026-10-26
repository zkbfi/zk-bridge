/**
 * The words about the tip that the fee panel and the confirm dialog share, so that the two always say the same thing.
 */
import { getAddress } from "viem";
import { FEE_ROUTER_NAME } from "@zk-bridge/shared";
import type { DeliveryRouters } from "./delivery-selection";

/** What the confirm dialog says about a relay that carries no tip: no router, no fee terms, only a direct delivery. */
export const NO_ROUTER_NOTICE =
  "No router is involved. This relay carries no tip and no fee terms, so no router and no runner can take a fee. Anyone can deliver it directly on the bridge, for free. It may take longer.";

/**
 * What a tip means for the runner and for a direct delivery. The fee router whitelists one runner. Anyone may still call
 * the bridge directly, and then no runner is recorded, no tip is paid, and the recipient gets the whole amount.
 */
export const RUNNER_NOTES: readonly string[] = [
  "Only one whitelisted runner can collect tips through a router. The fee router pays the tip to that runner, and only when that runner delivers the message through the router.",
  "When anyone else calls the bridge directly to deliver, no runner is recorded and no tip is paid. The recipient then gets the whole amount.",
];

/**
 * The warning for a router that is not the fee router of the deployment, or null when it is. The tip terms are written
 * for the fee router, so another router can read them in a different way.
 *
 * @param routers The router of the relay and the router of the deployment.
 */
export const routerWarningOf = (routers: DeliveryRouters): string | null =>
  getAddress(routers.router) === getAddress(routers.defaultRouter)
    ? null
    : `This router is not ${FEE_ROUTER_NAME} (${getAddress(routers.defaultRouter)}). The tip terms are written for the fee router. Another router can read them in a different way. Use it only if you trust it.`;

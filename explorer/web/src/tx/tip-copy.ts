/**
 * The words about the tip that the fee panel and the confirm dialog share, so that the two always say the same thing.
 */
import { getAddress } from "viem";
import { DELIVERY_ROUTER_NAME, TIP_MODE_NAMES, TIP_NATURE } from "@zk-bridge/shared";
import type { DeliveryRouters } from "./delivery-selection";

/** What the confirm dialog says about a relay that carries no tip: no router, no fee terms, only a direct delivery. */
export const NO_ROUTER_NOTICE =
  "No router is involved. This relay carries no tip and no fee terms, so no router can take a fee. Anyone can deliver it directly on the bridge, for free. It may take longer.";

/**
 * What the confirm dialog says about the native coin sent with No tip (`wrapAndRelayTokens`): the delivery router on this chain wraps the coin and relays it, and
 * the relay carries no tip, so the router takes nothing.
 */
export const WRAP_NO_FEE_NOTICE =
  "The delivery router wraps the coin you send, then relays it on the bridge. It takes no fee: this relay carries no tip and no fee terms. Anyone can deliver it on the other chain, for free. It may take longer than a relay with a tip.";

/**
 * What a tip means for the delivery and for a direct delivery. Anyone may deliver through the delivery router. The router
 * pays the tip to its own reward address, so a copied delivery gains the copier nothing. A direct delivery on the bridge
 * does not use the router, so it pays no tip and the recipient gets the whole amount.
 */
export const TIP_NOTES: readonly string[] = [
  TIP_NATURE,
  "Anyone can deliver through the delivery router. The router pays the tip to its reward address, which it fixes when it is deployed. A copied delivery gains the copier nothing.",
  "When the router cannot deliver the tokens to the recipient, it hands them to its failed delivery address. The router pays the tip first.",
  "When anyone calls the bridge directly to deliver, without the router, no tip is paid. The recipient then gets the whole amount.",
];

/**
 * The warning for a router that is not the default delivery router, or null when it is. The tip terms are written
 * for the delivery router, so another router can read them in a different way.
 *
 * @param routers The router of the relay and the router of the deployment.
 */
export const routerWarningOf = (routers: DeliveryRouters): string | null =>
  getAddress(routers.router) === getAddress(routers.defaultRouter)
    ? null
    : `This router is not ${DELIVERY_ROUTER_NAME} (${getAddress(routers.defaultRouter)}). The tip terms are written for the delivery router. Another router can read them in a different way. Use it only if you trust it.`;

/** The label of the gas based mode in the option list: the shared name, with a capital letter. */
export const GAS_MODE_LABEL = `${TIP_MODE_NAMES.gas.charAt(0).toUpperCase()}${TIP_MODE_NAMES.gas.slice(1)}`;

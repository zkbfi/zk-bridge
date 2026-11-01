import { routerCallbackGas } from "@zkb/core";

/**
 * The gas that a sender passes for the callback of a relay. The bridge and the mediator keep no gas rule: a message
 * carries no gas limit, and a delivery that runs short of gas reverts as a whole and can be sent again with more. The
 * one number a sender states is the `callbackGas` of a relay with a call: the exact gas that `onTokenBridged` gets on
 * the destination chain. This module recommends that number. The dapp, the terminal and the bots use it, so no layer
 * guesses its own.
 */

/**
 * What a relay calls on the destination chain:
 * - `plain`: no callback, so there is no gas number;
 * - `router`: the receiver is a delivery router, which needs its own work plus the gas of the follow-up call (`callGas`)
 *   when the director asks for one;
 * - `contract`: the receiver is any other contract, and the sender states the gas it needs.
 */
export type CallbackGasRequest =
  | { kind: "plain" }
  | { kind: "router"; callGas?: bigint }
  | { kind: "contract"; callbackGas: bigint };

/**
 * The `callbackGas` to pass to `relayTokensAndCall` for a request, or null for a plain relay (the plain entry points
 * take no gas number).
 *
 * @param request What the relay calls.
 * @throws RangeError when the receiver is a contract and the gas is not above zero (the mediator refuses zero).
 */
export function recommendedCallbackGas(request: CallbackGasRequest): bigint | null {
  if (request.kind === "plain") return null;
  if (request.kind === "router") return routerCallbackGas(request.callGas === undefined ? {} : { callGas: request.callGas });
  if (request.callbackGas <= 0n) throw new RangeError("the callback gas must be above zero: the mediator refuses a callback with no gas");
  return request.callbackGas;
}

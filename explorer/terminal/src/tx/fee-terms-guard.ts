/**
 * The terminal side of the fee terms guard of `@zk-bridge/shared`. The router sends the whole value to its reward
 * address when the terms are invalid, so no form may build such a transfer. This module gives the shared guard the
 * addresses of the deployment and turns its error into a {@link PlanInputError}.
 */
import { FeeTermsError, assertValidFeeTerms, encodeFeeDirector, isKnownDeliveryRouter, protectedAddressesOf, type FeeDirector, type FeeTermsContext, type ProtectedChain } from '@zk-bridge/shared'
import type { Address, Hex } from 'viem'
import type { ChainConfig, PairConfig } from '../model/types'
import { PlanInputError } from './plan'

const protectedChainOf = (chain: ChainConfig): ProtectedChain => ({
  name: chain.name,
  bridge: chain.contracts.messageBridge,
  mediator: chain.contracts.tokenMediator,
  deliveryRouter: chain.contracts.deliveryRouter,
})

/** Both chains of the pair, as the shared guard reads them. */
export const protectedChainsOf = (pair: PairConfig): readonly ProtectedChain[] => [protectedChainOf(pair.first), protectedChainOf(pair.second)]

/** The context of the shared guard for a relay to `router`. */
export const feeTermsContextOf = (pair: PairConfig, router: Address): FeeTermsContext => ({
  router,
  protectedAddresses: protectedAddressesOf(protectedChainsOf(pair)),
})

/** True when the receiver is a default delivery router, on either chain. */
export const isDeploymentDeliveryRouter = (pair: PairConfig, receiver: Address): boolean => isKnownDeliveryRouter(receiver, protectedChainsOf(pair))

/** Runs a guarded step and reports its refusal as a {@link PlanInputError}. */
const refusingAsPlanInputError = <Result>(run: () => Result): Result => {
  try {
    return run()
  } catch (caught) {
    if (caught instanceof FeeTermsError) throw new PlanInputError(caught.message)
    throw caught
  }
}

/**
 * Encodes a director for a relay to `router`.
 *
 * @throws PlanInputError when the router would not honour the terms.
 */
export const encodeDirectorFor = (director: FeeDirector, pair: PairConfig, router: Address): Hex =>
  refusingAsPlanInputError(() => encodeFeeDirector(director, feeTermsContextOf(pair, router)))

/** What a relay to a router carries. */
export interface RouterRelay {
  readonly pair: PairConfig
  /** The chain that the router is on. */
  readonly destination: ChainConfig
  readonly router: Address
  /** The callback data. A plain relay carries none: pass `0x`. */
  readonly data: Hex
  /** The token that the router receives, or null for the wrap route. */
  readonly destinationToken: Address | null
}

/**
 * Refuses a relay to a router whose terms the router would hand to its failed delivery address.
 *
 * @throws PlanInputError with a sentence for the user.
 */
export const requireValidRouterRelay = (relay: RouterRelay): void =>
  refusingAsPlanInputError(() =>
    assertValidFeeTerms({
      ...feeTermsContextOf(relay.pair, relay.router),
      data: relay.data,
      destinationToken: relay.destinationToken,
      destinationWrappedNative: relay.destination.contracts.wrappedNative,
    }),
  )

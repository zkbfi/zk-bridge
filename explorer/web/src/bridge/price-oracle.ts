/**
 * The PulseX price oracle. It lives in `@zk-bridge/shared` so the indexer prices transaction costs with the same method
 * (see `shared/src/pulsex-oracle.ts`); this module keeps the web's import path.
 */
export { MINIMUM_DEPTH_USD, PULSECHAIN_COPY_OF, PULSEX_FACTORIES, STABLES, TESTNETS, WPLS, nativeUsd, plsUsd, poolReaderOver, priceNumber, pricingAddress, resolvePricingAddress, tokenUsd, usdText, weightedMedian } from "@zk-bridge/shared";
export type { PoolReader, PriceQuote, Reserves } from "@zk-bridge/shared";

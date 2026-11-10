import type { Address } from "viem";
import type { TokenValuation } from "@zk-bridge/shared";
import type { TokenPricing } from "../../src/runner/pricing.ts";

/**
 * A fixed price table for the runner's tests: one whole token in wei by lowercase address, known; the wrapped native coin
 * worth 1e18 a whole token; any other token with no market (its tip is judged by the automatic maximum).
 */
export function testPricing(valuationsWei: Readonly<Record<string, bigint>>, wrappedNative: Address): TokenPricing & { readonly asked: Address[] } {
  const asked: Address[] = [];
  const pricing = async (token: { readonly address: Address }): Promise<TokenValuation> => {
    asked.push(token.address);
    const key = token.address.toLowerCase();
    const wei = key === wrappedNative.toLowerCase() ? 10n ** 18n : valuationsWei[key];
    return wei === undefined ? { state: { kind: "no-market" }, usdE18: null, nativeUsdE18: null, weiPerToken: null } : { state: { kind: "known" }, usdE18: wei, nativeUsdE18: 10n ** 18n, weiPerToken: wei };
  };
  return Object.assign(pricing, { asked });
}

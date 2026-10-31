import { fallback, http, type Transport } from "viem";
import { DEFAULT_RPC_CHAIN_IDS, defaultRpcUrls } from "@terminal/config/default-rpc";

/**
 * The transport for an RPC URL. A chain's first default RPC (valve.city) gets that chain's whole default list behind it
 * (the public RPC next), so one provider's outage or quota does not stop the page; a URL the user or the build chose is
 * used alone.
 *
 * @param url The RPC URL, or undefined for viem's own default.
 */
export const rpcTransport = (url: string | undefined): Transport => {
  if (url === undefined) return http();
  const chainId = DEFAULT_RPC_CHAIN_IDS.find((id) => defaultRpcUrls(id)[0] === url);
  return chainId === undefined ? http(url) : fallback(defaultRpcUrls(chainId).map((each) => http(each)));
};

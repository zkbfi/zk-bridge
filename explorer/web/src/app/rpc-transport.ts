import type { Transport } from "viem";
import { buildRpcTransport } from "@terminal/chain/rpc-transport";

/**
 * The transport for an RPC URL, the same one the terminal's chain access uses: a chain's default URL (rpc.zkb.fi) gets the
 * public RPC behind it (and is skipped for a while after a 429); a URL the user or the build chose is used alone; calls
 * made together are batched. See `@terminal/chain/rpc-transport` for the reasoning.
 *
 * @param url The RPC URL, or undefined for viem's own default.
 */
export const rpcTransport = (url: string | undefined): Transport => buildRpcTransport(url);

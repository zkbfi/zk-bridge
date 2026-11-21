/**
 * Watching an address without a wallet, for development only: `?watch=0x…` shows the page as that account (balances,
 * fees, Activity) and sends nothing. A production build never reads the parameter.
 */
import { useMemo, type ReactNode } from "react";
import { getAddress, isAddress, type Address } from "viem";
import { WalletContext, type WalletPort } from "./wallet-port";

/**
 * The address to watch, or null. Only a development build reads it.
 *
 * @param search `window.location.search`.
 * @param development Whether this is a development build (`import.meta.env.DEV`).
 */
export const watchAddressOf = (search: string, development: boolean): Address | null => {
  if (!development) return null;
  const value = new URLSearchParams(search).get("watch");
  return value !== null && isAddress(value, { strict: false }) ? getAddress(value) : null;
};

/** Provides a wallet that looks connected as the watched account and refuses every send. */
export const WatchWalletProvider = ({ account, chainId, children }: { readonly account: Address; readonly chainId: number; readonly children: ReactNode }) => {
  const port = useMemo<WalletPort>(
    () => ({
      status: "connected",
      account,
      chainId,
      walletName: "Watching (development)",
      walletAvailable: true,
      kind: "simulated",
      connect: async () => undefined,
      disconnect: () => undefined,
      switchChain: async () => undefined,
      sendTransaction: async () => {
        throw new Error("Watching an address only; nothing is sent.");
      },
      watchAsset: async () => {
        throw new Error("Watching an address only; no wallet lists a token.");
      },
    }),
    [account, chainId],
  );
  return <WalletContext.Provider value={port}>{children}</WalletContext.Provider>;
};

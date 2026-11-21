/**
 * What the page needs from a wallet. The live page backs it with wagmi and the wallet in the browser (a hardware wallet
 * works through that wallet). The fixture page backs it with a simulated account that sends nothing. Components use only
 * this interface, so they never know which one they talk to.
 */
import { createContext, useContext } from "react";
import type { Address, Hash, Hex } from "viem";

/** The connection state. */
export type WalletStatus = "disconnected" | "connecting" | "connected";

/** A transaction for the wallet to sign and send. */
export type WalletTransaction = {
  readonly chainId: number;
  readonly to: Address;
  readonly data: Hex;
  readonly value: bigint;
  readonly gas: bigint;
};

/** A token for the wallet to list, on the chain where it lives. */
export type WalletToken = {
  readonly chainId: number;
  readonly address: Address;
  readonly symbol: string;
  readonly decimals: number;
};

/** The wallet of the viewer. */
export interface WalletPort {
  readonly status: WalletStatus;
  /** The connected account, or null. */
  readonly account: Address | null;
  /** The chain that the wallet is on now, or null when not connected. */
  readonly chainId: number | null;
  /** The name of the wallet, for example the name that the browser wallet reports. Null when not connected. */
  readonly walletName: string | null;
  /** True when the page found a wallet in the browser. */
  readonly walletAvailable: boolean;
  /** `real` for a wallet that signs, `simulated` for the fixture page, which sends nothing. */
  readonly kind: "real" | "simulated";
  connect(): Promise<void>;
  disconnect(): void;
  switchChain(chainId: number): Promise<void>;
  /** Signs and sends. It switches the wallet to the chain of the transaction first. It rejects when the viewer declines. */
  sendTransaction(transaction: WalletTransaction): Promise<Hash>;
  /** Asks the wallet to list a token (`wallet_watchAsset`), switching to the token's chain first. It rejects when the viewer declines or the wallet cannot. */
  watchAsset(token: WalletToken): Promise<void>;
}

/** Context of the wallet. */
export const WalletContext = createContext<WalletPort | null>(null);

/**
 * The wallet of the page.
 *
 * @throws When no provider wraps the component.
 */
export const useWallet = (): WalletPort => {
  const wallet = useContext(WalletContext);
  if (wallet === null) throw new Error("useWallet needs a WalletContext provider above it.");
  return wallet;
};

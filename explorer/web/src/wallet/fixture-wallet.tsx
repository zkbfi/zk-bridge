import { useMemo, useState, type ReactNode } from "react";
import type { Address, Hash } from "viem";
import { FIXTURE_ACCOUNT } from "@terminal/data/fixtures";
import { FIXTURE_TRANSACTION_HASH } from "@terminal/chain/chain-access";
import { WalletContext, type WalletPort } from "./wallet-port";

/** Props of {@link FixtureWalletProvider}. */
export type FixtureWalletProviderProps = {
  /** The chain that the simulated wallet starts on. */
  readonly initialChainId: number;
  /** The account that the simulated wallet reports. Default: the fixture account. */
  readonly account?: Address;
  /** Starts connected. Default: false. */
  readonly startConnected?: boolean;
  /** Called with the hash of each simulated send. A test uses it to see what the wallet received. */
  readonly onSend?: (hash: Hash) => void;
  readonly children: ReactNode;
};

/**
 * A wallet that sends nothing. The fixture page and the tests use it. Its kind is `simulated`, and the page shows a
 * banner so that nobody mistakes a simulated send for a real one.
 *
 * @param props The starting chain and options.
 */
export const FixtureWalletProvider = ({ initialChainId, account = FIXTURE_ACCOUNT, startConnected = false, onSend, children }: FixtureWalletProviderProps) => {
  const [connected, setConnected] = useState(startConnected);
  const [chainId, setChainId] = useState(initialChainId);
  const port = useMemo<WalletPort>(
    () => ({
      status: connected ? "connected" : "disconnected",
      account: connected ? account : null,
      chainId: connected ? chainId : null,
      walletName: connected ? "Simulated wallet" : null,
      walletAvailable: true,
      kind: "simulated",
      async connect() {
        setConnected(true);
      },
      disconnect: () => setConnected(false),
      async switchChain(next) {
        setChainId(next);
      },
      async sendTransaction(transaction) {
        setChainId(transaction.chainId);
        onSend?.(FIXTURE_TRANSACTION_HASH);
        return FIXTURE_TRANSACTION_HASH;
      },
      async watchAsset(token) {
        setChainId(token.chainId);
      },
    }),
    [connected, chainId, account, onSend],
  );
  return <WalletContext.Provider value={port}>{children}</WalletContext.Provider>;
};

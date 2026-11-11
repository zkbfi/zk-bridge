import { useMemo, type ReactNode } from "react";
import { rpcTransport } from "../app/rpc-transport";
import { createConfig, injected, useConnect, useConnection, useConnectors, useDisconnect, useSendTransaction, useSwitchChain, WagmiProvider, type Config } from "wagmi";
import type { Chain } from "viem";
import { rpcChain } from "@terminal/chain/rpc-transport";
import type { PairConfig } from "@terminal/model/types";
import { WalletContext, type WalletPort, type WalletStatus, type WalletTransaction } from "./wallet-port";
import { defaultRpcUrl } from "@terminal/config/default-rpc";

/** The endpoint of a chain that has neither a configured URL nor a public default: the local node, which is what a development chain runs on. */
const NO_ENDPOINT_URL = "http://127.0.0.1:8545";

/**
 * Builds the wagmi configuration for a pair: one chain per side, public transports from the page configuration, and the
 * injected connector (the wallet in the browser). WalletConnect is not wired in: it needs a project identifier and an
 * extra package.
 *
 * @param pair The pair.
 * @param rpcUrls The public RPC URL of each chain. A chain with none uses the default of its definition.
 */
export const createWalletConfig = (pair: PairConfig, rpcUrls: Readonly<Record<number, string>>): Config => {
  const urlOf = (chain: PairConfig["first"]): string => rpcUrls[chain.chainId] ?? defaultRpcUrl(chain.chainId) ?? NO_ENDPOINT_URL;
  const chains = [pair.first, pair.second].map((chain): Chain => rpcChain({ id: chain.chainId, name: chain.name, symbol: chain.nativeSymbol, rpcUrl: urlOf(chain) }));
  const [first, second] = chains as [Chain, Chain];
  return createConfig({
    chains: [first, second],
    connectors: [injected()],
    transports: { [first.id]: rpcTransport(urlOf(pair.first)), [second.id]: rpcTransport(urlOf(pair.second)) },
    ssr: false,
  });
};

const statusOf = (status: string): WalletStatus => {
  if (status === "connected") return "connected";
  if (status === "connecting" || status === "reconnecting") return "connecting";
  return "disconnected";
};

const WalletBridge = ({ children }: { readonly children: ReactNode }) => {
  const connection = useConnection();
  const connectors = useConnectors();
  const { connectAsync } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChainAsync } = useSwitchChain();
  const { sendTransactionAsync } = useSendTransaction();
  const connector = connectors[0];

  const port = useMemo<WalletPort>(
    () => ({
      status: statusOf(connection.status),
      account: connection.address ?? null,
      chainId: connection.status === "connected" ? connection.chainId : null,
      walletName: connection.status === "connected" ? connection.connector.name : null,
      walletAvailable: connector !== undefined,
      kind: "real",
      async connect() {
        if (connector === undefined) throw new Error("No wallet was found in this browser. Install a wallet extension, then reload the page.");
        await connectAsync({ connector });
      },
      disconnect: () => disconnect(),
      async switchChain(chainId) {
        await switchChainAsync({ chainId });
      },
      async sendTransaction(transaction: WalletTransaction) {
        if (connection.chainId !== transaction.chainId) await switchChainAsync({ chainId: transaction.chainId });
        return sendTransactionAsync({ chainId: transaction.chainId, to: transaction.to, data: transaction.data, value: transaction.value, gas: transaction.gas });
      },
    }),
    [connection.status, connection.address, connection.chainId, connection.connector, connector, connectAsync, disconnect, switchChainAsync, sendTransactionAsync],
  );
  return <WalletContext.Provider value={port}>{children}</WalletContext.Provider>;
};

/** Props of {@link WagmiWalletProvider}. */
export type WagmiWalletProviderProps = {
  readonly pair: PairConfig;
  readonly rpcUrls: Readonly<Record<number, string>>;
  readonly children: ReactNode;
};

/**
 * Provides the wallet through wagmi. A `QueryClientProvider` must sit above it.
 *
 * @param props The pair, the public endpoints and the children.
 */
export const WagmiWalletProvider = ({ pair, rpcUrls, children }: WagmiWalletProviderProps) => {
  const config = useMemo(() => createWalletConfig(pair, rpcUrls), [pair, rpcUrls]);
  return (
    <WagmiProvider config={config}>
      <WalletBridge>{children}</WalletBridge>
    </WagmiProvider>
  );
};

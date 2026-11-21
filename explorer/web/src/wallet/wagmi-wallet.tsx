import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { rpcTransport } from "../app/rpc-transport";
import { createConfig, injected, useConnect, useConnection, useConnectors, useDisconnect, useSendTransaction, useSwitchChain, useWatchAsset, WagmiProvider, type Config, type Connector, type Transport } from "wagmi";
import type { Chain } from "viem";
import { rpcChain } from "@terminal/chain/rpc-transport";
import type { PairConfig } from "@terminal/model/types";
import { WalletContext, type WalletPort, type WalletStatus, type WalletTransaction } from "./wallet-port";
import { defaultRpcUrl } from "@terminal/config/default-rpc";
import { loadAppKit, type AppKitHandle } from "./appkit";
import { WalletPicker, type PickableWallet } from "./WalletPicker";

/** The endpoint of a chain that has neither a configured URL nor a public default: the local node, which is what a development chain runs on. */
const NO_ENDPOINT_URL = "http://127.0.0.1:8545";

/** The chains of a pair as viem chains, with the public RPC of each (the configured one, else the default, else the local node). */
export const walletChains = (pair: PairConfig, rpcUrls: Readonly<Record<number, string>>): readonly [Chain, Chain] => {
  const urlOf = (chain: PairConfig["first"]): string => rpcUrls[chain.chainId] ?? defaultRpcUrl(chain.chainId) ?? NO_ENDPOINT_URL;
  const chains = [pair.first, pair.second].map((chain): Chain => rpcChain({ id: chain.chainId, name: chain.name, symbol: chain.nativeSymbol, rpcUrl: urlOf(chain) }));
  return chains as [Chain, Chain];
};

/** The transport of each chain of a pair: the page's own `rpcTransport`, on the same endpoint as {@link walletChains}. */
export const walletTransports = (chains: readonly Chain[]): Record<number, Transport> =>
  Object.fromEntries(chains.map((chain) => [chain.id, rpcTransport(chain.rpcUrls.default.http[0] ?? NO_ENDPOINT_URL)]));

/**
 * Builds the wagmi configuration for a pair without Reown: one chain per side, public transports from the page
 * configuration, and the wallets in the browser. Wallets that announce themselves (EIP-6963, wagmi's multi injected
 * provider discovery) are connectors by themselves; the generic injected connector is added only when the page has
 * `window.ethereum`, so it cannot throw "Provider not found" on a browser with no wallet.
 *
 * @param pair The pair.
 * @param rpcUrls The public RPC URL of each chain. A chain with none uses the default of its definition.
 */
export const createWalletConfig = (pair: PairConfig, rpcUrls: Readonly<Record<number, string>>): Config => {
  const [first, second] = walletChains(pair, rpcUrls);
  return createConfig({
    chains: [first, second],
    connectors: (window as { ethereum?: unknown }).ethereum !== undefined ? [injected()] : [],
    multiInjectedProviderDiscovery: true,
    transports: walletTransports([first, second]),
    ssr: false,
  });
};

const statusOf = (status: string): WalletStatus => {
  if (status === "connected") return "connected";
  if (status === "connecting" || status === "reconnecting") return "connecting";
  return "disconnected";
};

/**
 * A connect failure in words the viewer can act on. A viem or wagmi error has a short message; a wallet that refuses has
 * the code 4001.
 */
export const connectErrorText = (error: unknown): string => {
  const named = error as { name?: string; code?: number; shortMessage?: string; message?: string } | null;
  if (named?.name === "ProviderNotFoundError") return "That wallet is not available in this browser. Install it, then reload this page.";
  if (named?.name === "UserRejectedRequestError" || named?.code === 4001) return "The wallet request was declined. Connect again to retry.";
  const text = named?.shortMessage ?? named?.message ?? String(error);
  return `The wallet did not connect: ${text.split("\n")[0]}`;
};

/** The wallets to offer: the announced ones, and the generic injected connector only when nothing announced itself. */
export const pickableWallets = (connectors: readonly Connector[]): readonly Connector[] => {
  const named = connectors.filter((connector) => connector.id !== "injected");
  return named.length > 0 ? named : connectors;
};

/** Whether the viewer connected here before, so that a stored session may need the AppKit connectors at load. */
const hasStoredConnection = (): boolean => {
  try {
    return window.localStorage.getItem("wagmi.recentConnectorId") !== null;
  } catch {
    return false;
  }
};

type BridgeProps = { readonly children: ReactNode; readonly projectId: string | null; readonly kit: AppKitHandle | null; readonly loadKit: () => Promise<AppKitHandle> };

const WalletBridge = ({ children, projectId, kit, loadKit }: BridgeProps) => {
  const connection = useConnection();
  const connectors = useConnectors();
  const { connectAsync } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChainAsync } = useSwitchChain();
  const { sendTransactionAsync } = useSendTransaction();
  const { watchAssetAsync } = useWatchAsset();
  const [picker, setPicker] = useState<{ readonly error: string | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const wallets = useMemo(() => pickableWallets(connectors), [connectors]);

  const attempt = useCallback(
    async (connector: Connector): Promise<void> => {
      setBusy(true);
      try {
        await connectAsync({ connector });
        setPicker(null);
      } catch (error) {
        setPicker({ error: connectErrorText(error) });
      } finally {
        setBusy(false);
      }
    },
    [connectAsync],
  );

  const connect = useCallback(async (): Promise<void> => {
    if (projectId !== null) {
      try {
        (kit ?? (await loadKit())).open();
        return;
      } catch (error) {
        // Reown's modal could not load (blocked or offline): the page's own list still connects the wallets in the browser.
        setPicker({ error: `The wallet list could not load. ${connectErrorText(error)}` });
        return;
      }
    }
    // Exactly one wallet connects at once; several get a list; none gets the install links. Errors show in the list, never as a throw.
    if (wallets.length === 1) await attempt(wallets[0]!);
    else setPicker({ error: null });
  }, [projectId, kit, loadKit, wallets, attempt]);

  const port = useMemo<WalletPort>(
    () => ({
      status: statusOf(connection.status),
      account: connection.address ?? null,
      chainId: connection.status === "connected" ? connection.chainId : null,
      walletName: connection.status === "connected" ? connection.connector.name : null,
      walletAvailable: projectId !== null || connectors.length > 0,
      kind: "real",
      connect,
      disconnect: () => disconnect(),
      async switchChain(chainId) {
        await switchChainAsync({ chainId });
      },
      async sendTransaction(transaction: WalletTransaction) {
        if (connection.chainId !== transaction.chainId) await switchChainAsync({ chainId: transaction.chainId });
        return sendTransactionAsync({ chainId: transaction.chainId, to: transaction.to, data: transaction.data, value: transaction.value, gas: transaction.gas });
      },
      async watchAsset(token) {
        // The wallet lists a token on the chain it is on, so it moves to the token's chain first.
        if (connection.chainId !== token.chainId) await switchChainAsync({ chainId: token.chainId });
        const listed = await watchAssetAsync({ type: "ERC20", options: { address: token.address, symbol: token.symbol, decimals: token.decimals } });
        if (!listed) throw new Error("The wallet did not add the token.");
      },
    }),
    [connection.status, connection.address, connection.chainId, connection.connector, projectId, connectors.length, connect, disconnect, switchChainAsync, sendTransactionAsync, watchAssetAsync],
  );
  const listed: readonly PickableWallet[] = wallets.map((wallet) => ({ id: wallet.uid, name: wallet.name, icon: wallet.icon }));
  // A connection closes the list, whichever way it was made.
  const open = picker !== null && connection.status !== "connected";
  return (
    <WalletContext.Provider value={port}>
      {children}
      {open ? (
        <WalletPicker
          wallets={listed}
          error={picker.error}
          busy={busy}
          onPick={(id) => void attempt(wallets.find((wallet) => wallet.uid === id)!)}
          onClose={() => setPicker(null)}
        />
      ) : null}
    </WalletContext.Provider>
  );
};

/** Props of {@link WagmiWalletProvider}. */
export type WagmiWalletProviderProps = {
  readonly pair: PairConfig;
  readonly rpcUrls: Readonly<Record<number, string>>;
  /** The Reown project id (`VITE_WALLETCONNECT_PROJECT_ID`), or null for a page that connects only the wallets in the browser. */
  readonly walletConnectProjectId?: string | null;
  readonly children: ReactNode;
};

/**
 * Provides the wallet through wagmi. A `QueryClientProvider` must sit above it.
 *
 * With a Reown project id, Connect opens the AppKit modal. AppKit is imported on the first Connect (and at load when the
 * viewer connected here before), and from then on its wagmi configuration replaces the plain one. Without a project id
 * there is no AppKit: Connect uses the wallets in the browser, with a list to pick from or to install one.
 *
 * @param props The pair, the public endpoints, the project id and the children.
 */
export const WagmiWalletProvider = ({ pair, rpcUrls, walletConnectProjectId = null, children }: WagmiWalletProviderProps) => {
  const plain = useMemo(() => createWalletConfig(pair, rpcUrls), [pair, rpcUrls]);
  const [kit, setKit] = useState<AppKitHandle | null>(null);
  const pending = useRef<Promise<AppKitHandle> | null>(null);
  const loadKit = useCallback((): Promise<AppKitHandle> => {
    // Only called with a project id: Connect and the effect below both check for one first.
    pending.current ??= (() => {
      const chains = walletChains(pair, rpcUrls);
      return loadAppKit({ projectId: walletConnectProjectId as string, chains, transports: walletTransports(chains) }).then(
        (handle) => {
          setKit(handle);
          return handle;
        },
        (error: unknown) => {
          pending.current = null;
          throw error;
        },
      );
    })();
    return pending.current;
  }, [pair, rpcUrls, walletConnectProjectId]);
  useEffect(() => {
    if (walletConnectProjectId !== null && hasStoredConnection()) loadKit().catch(() => undefined);
  }, [walletConnectProjectId, loadKit]);
  useEffect(() => () => kit?.dispose(), [kit]);
  return (
    <WagmiProvider config={kit?.config ?? plain}>
      <WalletBridge projectId={walletConnectProjectId} kit={kit} loadKit={loadKit}>
        {children}
      </WalletBridge>
    </WagmiProvider>
  );
};

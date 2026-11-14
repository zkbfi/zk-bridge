import { ChakraProvider, defaultSystem } from "@chakra-ui/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useMemo, type ReactNode } from "react";
import { FixtureWalletProvider } from "../wallet/fixture-wallet";
import { WagmiWalletProvider } from "../wallet/wagmi-wallet";
import { watchAddressOf, WatchWalletProvider } from "../wallet/watch-wallet";
import { ServicesProvider, type Services } from "./services";

/** Props of {@link Providers}. */
export type ProvidersProps = {
  readonly services: Services;
  readonly children: ReactNode;
};

/**
 * Every provider that the page needs: the style system, the data cache, the services and the wallet. A fixture page
 * gets a simulated wallet. A live page gets the wallet in the browser, through wagmi.
 *
 * @param props The services and the children.
 */
export const Providers = ({ services, children }: ProvidersProps) => {
  const queryClient = useMemo(
    () => new QueryClient({ defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } } }),
    [],
  );
  const { configuration, pair } = services;
  const watched = watchAddressOf(window.location.search, import.meta.env.DEV);
  const wallet =
    watched !== null ? (
      <WatchWalletProvider account={watched} chainId={pair.first.chainId}>
        {children}
      </WatchWalletProvider>
    ) : configuration.dataMode === "fixture" ? (
      <FixtureWalletProvider initialChainId={pair.first.chainId}>{children}</FixtureWalletProvider>
    ) : (
      <WagmiWalletProvider pair={pair} rpcUrls={configuration.rpcUrls} walletConnectProjectId={configuration.walletConnectProjectId}>
        {children}
      </WagmiWalletProvider>
    );
  return (
    <ChakraProvider value={defaultSystem}>
      <QueryClientProvider client={queryClient}>
        <ServicesProvider services={services}>{wallet}</ServicesProvider>
      </QueryClientProvider>
    </ChakraProvider>
  );
};

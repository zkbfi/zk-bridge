/**
 * Helpers of the coverage tests of the shell and the actions. They render a component with chosen services and a
 * wallet that the test controls, so a test can make a wallet call fail or watch what the page asks of it.
 */
import { ChakraProvider, defaultSystem } from "@chakra-ui/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, type RenderResult } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import { FIXTURE_ACCOUNT, FIXTURE_PAIR } from "@terminal/data/fixtures";
import { ActionsContext, type ActionsPort } from "../../src/app/actions-context";
import { ServicesProvider, type Services } from "../../src/app/services";
import { WalletContext, type WalletPort } from "../../src/wallet/wallet-port";
import { buildTestServices } from "../render";

/** A connected wallet on the first chain of the fixture pair. Each call of the wallet does nothing. */
export const connectedWallet = (overrides: Partial<WalletPort> = {}): WalletPort => ({
  status: "connected",
  account: FIXTURE_ACCOUNT,
  chainId: FIXTURE_PAIR.first.chainId,
  walletName: "Test wallet",
  walletAvailable: true,
  kind: "real",
  connect: async () => undefined,
  disconnect: () => undefined,
  switchChain: async () => undefined,
  sendTransaction: async () => {
    throw new Error("The test did not expect a send.");
  },
  watchAsset: async () => undefined,
  ...overrides,
});

/** A wallet that is not connected. */
export const disconnectedWallet = (overrides: Partial<WalletPort> = {}): WalletPort =>
  connectedWallet({ status: "disconnected", account: null, chainId: null, walletName: null, ...overrides });

/** Options of {@link renderWithWallet}. */
export type RenderWithWalletOptions = {
  readonly wallet: WalletPort;
  /** Replaces parts of the fixture services. */
  readonly services?: Partial<Services>;
  readonly actions?: ActionsPort;
};

/**
 * A wrapper component with the fixture services and the given wallet. Pass it as the `wrapper` option of `render`, so
 * that `rerender` keeps the providers.
 *
 * @param options The wallet, the service overrides and the actions port.
 */
export const walletWrapper = (options: RenderWithWalletOptions) => {
  const services: Services = { ...buildTestServices(), ...options.services };
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity, refetchInterval: false } } });
  return ({ children }: { readonly children: ReactNode }) => (
    <ChakraProvider value={defaultSystem}>
      <QueryClientProvider client={queryClient}>
        <ServicesProvider services={services}>
          <WalletContext.Provider value={options.wallet}>
            <ActionsContext.Provider value={options.actions ?? { open: () => undefined }}>{children}</ActionsContext.Provider>
          </WalletContext.Provider>
        </ServicesProvider>
      </QueryClientProvider>
    </ChakraProvider>
  );
};

/**
 * Renders a component with the fixture services and the given wallet.
 *
 * @param ui The component.
 * @param options The wallet, the service overrides and the actions port.
 */
export const renderWithWallet = (ui: ReactElement, options: RenderWithWalletOptions): RenderResult => render(ui, { wrapper: walletWrapper(options) });

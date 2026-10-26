/**
 * Helpers of the view coverage tests. They render a view with chosen services, so a test can make a data source fail,
 * stall or answer with an unusual value.
 */
import { ChakraProvider, defaultSystem } from "@chakra-ui/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, type RenderResult } from "@testing-library/react";
import type { ReactElement } from "react";
import { FIXTURE_PAIR } from "@terminal/data/fixtures";
import { ActionsContext, type ActionsPort } from "../../src/app/actions-context";
import { ServicesProvider, type Services } from "../../src/app/services";
import { FixtureWalletProvider } from "../../src/wallet/fixture-wallet";
import { buildTestServices } from "../render";

/** A promise that never settles, for a read that stays in flight. */
export const never = <Value,>(): Promise<Value> => new Promise<Value>(() => undefined);

/**
 * Renders a view with the fixture services, where the given parts replace the fixture ones.
 *
 * @param ui The view.
 * @param overrides The parts of the services to replace.
 * @param actions The port that receives the dialogs that the view asks for.
 * @param wallet Whether the simulated wallet starts connected.
 */
export const renderWithServices = (ui: ReactElement, overrides: Partial<Services> = {}, actions: ActionsPort = { open: () => undefined }, wallet: { readonly connected: boolean } = { connected: true }): RenderResult => {
  const services: Services = { ...buildTestServices(), ...overrides };
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity, refetchInterval: false } } });
  return render(
    <ChakraProvider value={defaultSystem}>
      <QueryClientProvider client={queryClient}>
        <ServicesProvider services={services}>
          <FixtureWalletProvider initialChainId={FIXTURE_PAIR.first.chainId} startConnected={wallet.connected}>
            <ActionsContext.Provider value={actions}>{ui}</ActionsContext.Provider>
          </FixtureWalletProvider>
        </ServicesProvider>
      </QueryClientProvider>
    </ChakraProvider>,
  );
};

/** The fixture services with one data source call replaced. */
export const withDataSource = (replacement: Partial<Services["dataSource"]>): Partial<Services> => ({
  dataSource: { ...buildTestServices().dataSource, ...replacement },
});

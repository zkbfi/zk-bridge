/**
 * The render helper of the component tests. It wraps a component in the same providers as the page, with the fixture
 * data and a simulated wallet, so a test never reaches a network.
 */
import { ChakraProvider, defaultSystem } from "@chakra-ui/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, type RenderResult } from "@testing-library/react";
import type { ReactElement } from "react";
import type { Hash } from "viem";
import { FIXTURE_PAIR } from "@terminal/data/fixtures";
import type { DeliveryCostReport } from "@zk-bridge/shared";
import { ActionsContext, type ActionsPort } from "../src/app/actions-context";
import { createServices, ServicesProvider, type Services } from "../src/app/services";
import { readConfiguration } from "../src/config/environment";
import { FixtureWalletProvider } from "../src/wallet/fixture-wallet";
import { buildDeliveryReport, type DeliveryReportOptions } from "./helpers";

/** Options of {@link renderPage}. */
export type RenderPageOptions = {
  /** Start with a connected simulated wallet. Default: true. */
  readonly connected?: boolean;
  /** The chain that the simulated wallet starts on. Default: the first chain. */
  readonly chainId?: number;
  /** Called for each simulated send. */
  readonly onSend?: (hash: Hash) => void;
  /** What the delivery cost report holds. Default: 40 measured deliveries. */
  readonly report?: DeliveryReportOptions;
  /** Replaces the delivery cost report entirely. */
  readonly reportOverride?: (chainId: number) => DeliveryCostReport;
  /** Receives the dialogs that components ask for. */
  readonly actions?: ActionsPort;
};

/** The fixture services, with the delivery cost report of the options. */
export const buildTestServices = (options: RenderPageOptions = {}): Services => {
  const base = createServices(readConfiguration({ VITE_EXPLORER_DATA: "fixture" }), FIXTURE_PAIR);
  return {
    ...base,
    dataSource: {
      ...base.dataSource,
      getDeliveryCost: async (chainId) => (options.reportOverride === undefined ? buildDeliveryReport(chainId, options.report) : options.reportOverride(chainId)),
    },
  };
};

/**
 * Renders a component with every provider of the page.
 *
 * @param ui The component.
 * @param options The wallet and the data.
 */
export const renderPage = (ui: ReactElement, options: RenderPageOptions = {}): RenderResult & { readonly services: Services } => {
  const services = buildTestServices(options);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity, refetchInterval: false } } });
  const actions: ActionsPort = options.actions ?? { open: () => undefined };
  const result = render(
    <ChakraProvider value={defaultSystem}>
      <QueryClientProvider client={queryClient}>
        <ServicesProvider services={services}>
          <FixtureWalletProvider initialChainId={options.chainId ?? FIXTURE_PAIR.first.chainId} startConnected={options.connected ?? true} {...(options.onSend === undefined ? {} : { onSend: options.onSend })}>
            <ActionsContext.Provider value={actions}>{ui}</ActionsContext.Provider>
          </FixtureWalletProvider>
        </ServicesProvider>
      </QueryClientProvider>
    </ChakraProvider>,
  );
  return Object.assign(result, { services });
};

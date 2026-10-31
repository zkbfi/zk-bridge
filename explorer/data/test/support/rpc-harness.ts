import { createRpcExplorerApi, type ApiAnswer, type RpcExplorerApi, type RpcExplorerApiOptions } from "../../src/index.js";
import { createFakeChain, type FakeChain, type FakeChainOptions } from "./fake-chain.js";
import { buildScenario, FIRST_CHAIN, SECOND_CHAIN, type Scenario } from "./scenario.js";
import { testPair } from "./fixtures.js";

/** The RPC data source over the synthetic history, with the fake chains that it reads. */
export type RpcHarness = {
  readonly scenario: Scenario;
  readonly chains: { readonly 1: FakeChain; readonly 369: FakeChain };
  readonly api: RpcExplorerApi;
  /** Gets a path and returns the body of a 200 answer. */
  body(path: string): Promise<any>;
  answer(path: string): Promise<ApiAnswer>;
};

/** The unix second of the clock in the tests: one block after the last block of the history. */
export const HARNESS_NOW = 1_700_000_000 + 12 * 301;

/**
 * Builds the harness.
 *
 * @param settings Options of the data source, and failures of each fake chain.
 */
export const createRpcHarness = (
  settings: {
    readonly api?: Partial<RpcExplorerApiOptions>;
    readonly first?: FakeChainOptions;
    readonly second?: FakeChainOptions;
    readonly omitReader?: number;
    readonly scenario?: Parameters<typeof buildScenario>[1];
  } = {},
): RpcHarness => {
  const pair = testPair();
  const scenario = buildScenario(pair, settings.scenario);
  const chains = {
    [FIRST_CHAIN]: createFakeChain(scenario, FIRST_CHAIN, settings.first),
    [SECOND_CHAIN]: createFakeChain(scenario, SECOND_CHAIN, settings.second),
  };
  const readers = settings.omitReader === undefined ? chains : { ...chains, [settings.omitReader]: undefined };
  const api = createRpcExplorerApi({ pair, readers, nowSeconds: () => HARNESS_NOW, ...settings.api });
  const answer = (path: string) => api.get(path);
  return {
    scenario,
    chains,
    api,
    answer,
    async body(path) {
      const result = await answer(path);
      if (result.status !== 200) throw new Error(`${path} answered ${result.status}: ${JSON.stringify(result.body)}`);
      return result.body;
    },
  };
};

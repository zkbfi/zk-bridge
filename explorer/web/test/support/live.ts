/**
 * Helpers for the tests of a live page: a shared pair with no RPC URL, a fake connection factory whose status the test
 * controls, and live services built on them. No test here reaches a network.
 */
import { vi } from "vitest";
import { FIXTURE_PAIR } from "@terminal/data/fixtures";
import {
  loadPair,
  redactConnectionText,
  type ExplorerConnection,
  type ExplorerConnectionInput,
  type JsonResponse,
  type Pair,
  type SourceStatus,
} from "@zk-bridge/shared";
import { createServices, type Services } from "../../src/app/services";
import { readConfiguration, type WebConfiguration } from "../../src/config/environment";

/** The first chain of the fixture pair is chain 1 and the second is chain 369. */
export const FIRST_CHAIN = FIXTURE_PAIR.first.chainId;
export const SECOND_CHAIN = FIXTURE_PAIR.second.chainId;

const section = (chainId: number, byte: string, extra: Record<string, unknown> = {}) => ({
  chain_id: chainId,
  bridge: `0x${byte.repeat(20)}`,
  mediator: `0x${byte.repeat(20)}`,
  token_factory: `0x${byte.repeat(20)}`,
  wrapped_native: `0x${byte.repeat(20)}`,
  gate: `0x${byte.repeat(20)}`,
  light_client: `0x${byte.repeat(20)}`,
  start_block: 100,
  ...extra,
});

const deployment = (options: { readonly withRegistryRpcUrl: boolean }) => ({
  chain_a: section(1, "11"),
  chain_b: section(369, "44", { delivery_router: `0x${"77".repeat(20)}`, ...(options.withRegistryRpcUrl ? { rpc_url: "https://registry.example.org/pls" } : {}) }),
});

/** A pair in the shared form. Chain 369 has a registry RPC URL. Chain 1 has none. */
export const sharedPairForTests = (options: { readonly withRegistryRpcUrl?: boolean } = {}): Pair =>
  loadPair({ pairName: "eth-pls", environment: {}, deployment: deployment({ withRegistryRpcUrl: options.withRegistryRpcUrl ?? true }), requireRpcUrl: false });

/** A live configuration. Pass `VITE_` variables to add an environment layer. */
export const liveConfiguration = (variables: Record<string, string> = {}): WebConfiguration =>
  readConfiguration({ VITE_EXPLORER_DATA: "live", VITE_EXPLORER_DEPLOYMENT_URL: "https://example.org/deployment.json", ...variables });

export const INDEXER_STATUS: SourceStatus = { kind: "indexer", reason: null, label: "indexer" };

/** A status for a fallback to the RPC source. */
export const fallbackStatus = (message: string): SourceStatus => ({ kind: "rpc", reason: { code: "error", message }, label: `RPC fallback: ${message}` });

/** The fake connection factory. */
export type FakeConnections = {
  readonly create: (input: ExplorerConnectionInput) => ExplorerConnection;
  /** Every input that the runtime gave to the factory, oldest first. */
  readonly inputs: ExplorerConnectionInput[];
  /** Every connection that the factory made, oldest first. */
  readonly made: ExplorerConnection[];
  /** Changes the status and tells the listeners of the newest connection. */
  readonly setStatus: (next: SourceStatus) => void;
  /** Sets the answer of `request` for all connections. */
  readonly answerWith: (response: JsonResponse) => void;
};

/** Makes a fake connection factory. Each connection answers `request` with the current answer. */
export const fakeConnections = (): FakeConnections => {
  let status: SourceStatus = INDEXER_STATUS;
  let answer: JsonResponse = { status: 200, body: {} };
  const listeners = new Set<(status: SourceStatus) => void>();
  const inputs: ExplorerConnectionInput[] = [];
  const made: ExplorerConnection[] = [];
  const create = (input: ExplorerConnectionInput): ExplorerConnection => {
    inputs.push(input);
    const urls = [input.resolved.indexerUrl?.value, ...Object.values(input.resolved.rpcUrls).map((setting) => setting?.value)].flatMap((url) => (url === undefined ? [] : [url]));
    const connection: ExplorerConnection = {
      resolved: input.resolved,
      baseUrl: input.resolved.indexerUrl?.value ?? "http://indexer.not-set.invalid",
      getJson: vi.fn(async () => ({})),
      request: vi.fn(async () => answer),
      run: vi.fn(async (operations) => operations.viaIndexer()),
      rpc: { get: vi.fn(), findMessageByTransaction: vi.fn(async () => null) } as unknown as ExplorerConnection["rpc"],
      status: () => status,
      subscribe: (listener) => {
        listeners.add(listener);
        return () => void listeners.delete(listener);
      },
      checkNow: vi.fn(async () => undefined),
      redact: (text) => redactConnectionText(text, urls),
    };
    made.push(connection);
    return connection;
  };
  return {
    create,
    inputs,
    made,
    setStatus: (next) => {
      status = next;
      for (const listener of [...listeners]) listener(next);
    },
    answerWith: (response) => {
      answer = response;
    },
  };
};

/** Options of {@link liveServices}. */
export type LiveServicesOptions = {
  readonly variables?: Record<string, string>;
  readonly storage?: Pick<Storage, "getItem" | "setItem"> | null;
  readonly fake?: FakeConnections;
  /** False: chain 369 has no RPC URL in the deployment. Default true. */
  readonly withRegistryRpcUrl?: boolean;
};

/** Live services on a fake connection. The storage is the storage of jsdom unless the test passes another. */
export const liveServices = (options: LiveServicesOptions = {}): Services & { readonly fake: FakeConnections } => {
  const fake = options.fake ?? fakeConnections();
  const services = createServices(liveConfiguration(options.variables), FIXTURE_PAIR, {
    sharedPair: sharedPairForTests({ withRegistryRpcUrl: options.withRegistryRpcUrl ?? true }),
    storage: options.storage === undefined ? window.localStorage : options.storage,
    createConnection: fake.create,
  });
  return Object.assign(services, { fake });
};

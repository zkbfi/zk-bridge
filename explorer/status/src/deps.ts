import type { PublicClient } from "viem";
import type { Pair } from "@zk-bridge/shared";
import type { StatusConfig } from "./config.ts";

/** The reads that the checks make on a chain. A viem `PublicClient` has them all. */
export type ChainClient = Pick<PublicClient, "getBlock" | "getBlockNumber" | "readContract" | "call" | "estimateGas" | "getBalance">;

/** Everything that touches the outside world, so a test can replace it. */
export type Deps = {
  readonly config: StatusConfig;
  readonly pair: Pair;
  readonly fetch: typeof fetch;
  /** Milliseconds since 1970. */
  readonly now: () => number;
  /** Runs a program and gives its output. */
  readonly exec: (file: string, args: readonly string[]) => Promise<string>;
  /** The client of a chain of the pair. */
  readonly client: (chainId: number) => ChainClient;
  /** Per-process memory of the checks, such as the newest release sequence seen. */
  readonly memory: Map<string, number>;
  /** The RunPod API key, when one is configured. It is only ever sent to RunPod. */
  readonly apiKey?: string;
  /** The longest a request may take, in milliseconds. */
  readonly requestTimeoutMilliseconds: number;
};

/** The label of a chain on the page. */
export const labelOf = (deps: Deps, chainId: number): string => deps.config.chains[String(chainId)]?.label ?? `chain ${chainId}`;

/** The native token symbol of a chain. */
export const symbolOf = (deps: Deps, chainId: number): string => deps.config.chains[String(chainId)]?.symbol ?? "";

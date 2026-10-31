import type { Hex } from "viem";
import type { BlockSelector, ChainBlock, ChainLog, ChainReader, ChainReceipt, LogRequest, ViewCall } from "../../src/rpc/chain-reader.js";
import type { Scenario } from "./scenario.js";

/** What a test can change in a fake chain. */
export type FakeChainOptions = {
  /** Answers a window request with an error instead of logs. */
  readonly failLogs?: (request: LogRequest) => Error | undefined;
  /** The block that the `finalized` tag names. Null makes the tag fail, as a node without it does. Default: head minus 32. */
  readonly finalized?: bigint | null;
  /** Answers a view call with an error. */
  readonly failView?: (call: ViewCall) => Error | undefined;
  /** Answers a view call instead of the scenario. Return undefined to keep the answer of the scenario. */
  readonly viewOverride?: (call: ViewCall) => unknown;
  /** The chain identifier that `eth_chainId` reports. Default: the chain of the fake. */
  readonly reportedChainId?: number;
  /** Replaces the base fee of the latest block. */
  readonly baseFeePerGas?: bigint | null;
};

/** What a fake chain was asked. */
export type FakeChainCalls = {
  readonly getLogs: LogRequest[];
  readonly getBlock: BlockSelector[];
  readonly readContract: ViewCall[];
  readonly getTransactionReceipt: Hex[];
};

/** A reader that answers from a scenario, and remembers what it was asked. */
export type FakeChain = ChainReader & {
  readonly calls: FakeChainCalls;
  /** Moves the latest block, as a chain does when it grows. Events after the head are not served. */
  setHead(blockNumber: bigint): void;
};

/**
 * A fake of one chain of a scenario. `getLogs` filters the events of the scenario by address, name and block range,
 * as a node does. The other methods answer from the scenario.
 *
 * @param scenario The history.
 * @param chainId The chain that this fake is.
 * @param options Failures and overrides.
 */
export const createFakeChain = (scenario: Scenario, chainId: number, options: FakeChainOptions = {}): FakeChain => {
  const calls: FakeChainCalls = { getLogs: [], getBlock: [], readContract: [], getTransactionReceipt: [] };
  let head = scenario.head[chainId] as bigint;
  const block = (number: bigint): ChainBlock => ({ number, timestamp: scenario.timestampOf(chainId, number), baseFeePerGas: options.baseFeePerGas === undefined ? 7n : options.baseFeePerGas });
  const sideOf = scenario.pair.sides.find((side) => side.chainId === chainId)!;
  const addressOf = (contract: string): string => (sideOf.contracts as Record<string, string | null>)[{ bridge: "bridge", mediator: "mediator", lightClient: "lightClient", gate: "gate" }[contract] as string] as string;
  return {
    calls,
    setHead: (blockNumber) => void (head = blockNumber),
    getChainId: async () => options.reportedChainId ?? chainId,
    async getBlock(selector) {
      calls.getBlock.push(selector);
      if ("blockNumber" in selector) return block(selector.blockNumber);
      if (selector.tag === "latest") return block(head);
      if (options.finalized === null) throw new Error("the node does not serve the finalized tag");
      return block(options.finalized ?? head - 32n);
    },
    async getLogs(request) {
      calls.getLogs.push(request);
      const failure = options.failLogs?.(request);
      if (failure !== undefined) throw failure;
      const names = new Set(request.events.map((event) => event.name));
      return scenario.events
        .filter(
          (event) =>
            event.chainId === chainId &&
            addressOf(event.contract) === request.address &&
            names.has(event.eventName) &&
            event.blockNumber >= request.fromBlock &&
            event.blockNumber <= request.toBlock &&
            event.blockNumber <= head,
        )
        .map((event): ChainLog => ({
          eventName: event.eventName,
          address: request.address,
          blockNumber: event.blockNumber,
          logIndex: scenario.events.indexOf(event),
          transactionHash: event.transactionHash,
          args: event.args,
        }));
    },
    async readContract(call) {
      calls.readContract.push(call);
      const failure = options.failView?.(call);
      if (failure !== undefined) throw failure;
      const override = options.viewOverride?.(call);
      return override === undefined ? scenario.view(chainId, call) : override;
    },
    async getTransactionReceipt(hash) {
      calls.getTransactionReceipt.push(hash);
      const receipt = scenario.receipt(chainId, hash);
      if (receipt === undefined) {
        const error = new Error("the transaction receipt was not found");
        error.name = "TransactionReceiptNotFoundError";
        throw error;
      }
      return receipt satisfies ChainReceipt;
    },
  };
};

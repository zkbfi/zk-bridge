import { decodeFunctionData, encodeAbiParameters, encodeErrorResult, encodeEventTopics, encodeFunctionData, encodeFunctionResult, erc20Abi, toFunctionSelector, type Address, type Hex } from "viem";
import {
  beaconLightClientAbi,
  encodeProofMessage,
  multicall3Abi,
  deliveryRouterAbi,
  encodeFeeDirector,
  messageBridgeAbi,
  tokenFactoryAbi,
  tokenMediatorAbi,
  type DeliveryCall,
  type ProofDirection,
  type ProofMessage,
} from "@zk-bridge/shared";
import type { CallRequest, FeeQuote, ReceiptLog, ReceiptSummary, SendTerms, Simulation, TransactionPort } from "../../src/chain/transactions.ts";
import type { FeedItem, IndexerClient, MessageWithData } from "../../src/indexer/client.ts";
import { createLogger, type Logger } from "../../src/logging/logger.ts";
import type { EvidencePackage, ProveOutcome, ProverBinary } from "@zk-bridge/shared/prover";
import type { OutcomeRecord, OutcomeSink } from "../../src/runner/outcomes.ts";
import type { FeeDirector } from "../../src/runner/fee.ts";

import { BRIDGE, LIGHT_CLIENT, PROGRAM_KEY, address, emptyExecuteMessage, word } from "../../../shared/test/support/prover-builders.ts";

export {
  BRIDGE,
  LIGHT_CLIENT,
  PROGRAM_KEY,
  address,
  emptyExecuteMessage,
  evidenceFor,
  fakeLightClient,
  fakeProver,
  proofMessage,
  proofPayload,
  publicValuesFor,
  word,
} from "../../../shared/test/support/prover-builders.ts";

export const DELIVERY_ROUTER = address(0x77);
/** The Multicall3 contract that batches the calls of a delivery. */
export const MULTICALL = address(0x3c);
export const WRAPPED_NATIVE = address(0x88);
export const RUNNER = address(0x99);
/** The address that receives the fees. It differs from the signer of the runner. */
export const REWARD_ADDRESS = address(0x98);
export const OTHER_TOKEN = address(0x66);

/** A logger that keeps its lines, parsed. */
export function memoryLogger(knownSecrets: readonly string[] = []): { readonly logger: Logger; readonly lines: string[]; readonly events: () => Array<Record<string, unknown>> } {
  const lines: string[] = [];
  const logger = createLogger({ write: (line) => lines.push(line), now: () => new Date(0), knownSecrets: () => knownSecrets, minimumLevel: "debug" });
  return { logger, lines, events: () => lines.map((line) => JSON.parse(line) as Record<string, unknown>) };
}

/** The call data of a message that relays tokens to a delivery router with a director. */
export function feeOfferData(options: { director: FeeDirector; value: bigint; recipient?: Address; token?: Address; call?: DeliveryCall }): Hex {
  // The words do not depend on the token. The context names the wrapped native token twice so that the guard of the
  // shared module accepts every setting: a test may offer a message that the terminal would refuse to build.
  const callback = encodeFeeDirector(options.director, { router: DELIVERY_ROUTER, protectedAddresses: [], destinationToken: WRAPPED_NATIVE, destinationWrappedNative: WRAPPED_NATIVE }, options.call);
  return encodeFunctionData({
    abi: tokenMediatorAbi,
    functionName: "handleBridgedTokensAndCall",
    args: [options.token ?? OTHER_TOKEN, options.recipient ?? DELIVERY_ROUTER, options.value, callback],
  });
}

/** A covered token item as the indexer lists it. */
export function feedItem(options: { id?: number; token?: Address; decimals?: number; sourceHash?: Hex } = {}): FeedItem {
  const id = options.id ?? 1;
  return {
    messageId: word(id),
    kind: "token",
    status: "covered",
    direction: { sourceChainId: 1, destinationChainId: 369 },
    sender: address(0x01),
    executor: address(0x02),
    gasLimit: 2_000_000,
    sent: { transactionHash: options.sourceHash ?? word(0xa0 + id), blockNumber: 10, timestamp: 1_790_000_000 },
    transfer: {
      sourceToken: { chainId: 1, address: address(0x55), symbol: "SRC", decimals: options.decimals ?? 18 },
      destinationToken: { chainId: 369, address: options.token ?? OTHER_TOKEN, symbol: "DST", decimals: options.decimals ?? 18 },
      recipient: DELIVERY_ROUTER,
      value: "1000000000000000000",
    },
  };
}

/** An indexer that lists the items and the data the test gives. */
export function fakeIndexer(items: readonly FeedItem[], data: Readonly<Record<string, Hex>>): IndexerClient & { queries: unknown[] } {
  const queries: unknown[] = [];
  return {
    queries,
    async listFeed(query) {
      queries.push(query);
      return { items: query.statuses.includes("covered") ? [...items] : [], nextCursor: null };
    },
    async getMessage(messageId): Promise<MessageWithData> {
      const item = items.find((candidate) => candidate.messageId === messageId);
      if (item === undefined) throw new Error(`no message ${messageId}`);
      return { ...item, data: data[messageId] ?? "0x" };
    },
  };
}

/** The outcomes a runner wrote. */
export function memoryOutcomes(): OutcomeSink & { records: OutcomeRecord[] } {
  const records: OutcomeRecord[] = [];
  return {
    records,
    async record(entry) {
      records.push(entry);
    },
  };
}

/** What Multicall3 reports for one call of a batch: whether it succeeded, and its return data or its revert data. */
export interface ItemResultInput {
  readonly success: boolean;
  readonly returnData: Hex;
}

/** The call succeeded. */
export const EXECUTED: ItemResultInput = { success: true, returnData: "0x" };
/** The bridge refuses the message because it is delivered already. */
export const SKIPPED_ALREADY_DELIVERED: ItemResultInput = { success: false, returnData: encodeErrorResult({ abi: messageBridgeAbi, errorName: "AlreadyDelivered", args: [word(1)] }) };
/** The bridge refuses the message because the light client has not stored its anchor header. */
export const SKIPPED_ANCHOR_NOT_STORED: ItemResultInput = { success: false, returnData: encodeErrorResult({ abi: messageBridgeAbi, errorName: "AnchorNotStored", args: [100n, word(2)] }) };
/** The bridge refuses the message because the gas left is too little. */
export const SKIPPED_INSUFFICIENT_GAS: ItemResultInput = { success: false, returnData: encodeErrorResult({ abi: messageBridgeAbi, errorName: "InsufficientGas", args: [1n, 2n] }) };
/** The bridge reverts for another reason. */
export const FAILED_IN_BRIDGE: ItemResultInput = { success: false, returnData: encodeErrorResult({ abi: messageBridgeAbi, errorName: "IndexMismatch", args: [1n, 2n] }) };
/** The light client refuses the update because its head is at or past it. */
export const SKIPPED_HEAD_ADVANCED: ItemResultInput = { success: false, returnData: encodeErrorResult({ abi: beaconLightClientAbi, errorName: "HeadNotAdvancing", args: [200n, 164n] }) };
/** The light client refuses the update for another reason. */
export const UPDATE_FAILED: ItemResultInput = { success: false, returnData: encodeErrorResult({ abi: beaconLightClientAbi, errorName: "InvalidPublicValuesLength", args: [1n] }) };
/** The update was applied. */
export const UPDATE_APPLIED: ItemResultInput = EXECUTED;

/** The `AffirmationCompleted` log that the bridge writes when it executes a message. */
export function affirmationLog(messageId: Hex): ReceiptLog {
  const topics = encodeEventTopics({ abi: messageBridgeAbi, eventName: "AffirmationCompleted", args: { sender: address(0x01), executor: address(0x02), messageId } }) as Hex[];
  return { address: BRIDGE, topics, data: encodeAbiParameters([{ type: "bool" }], [true]) };
}

/** The `HeadUpdated` log that the light client writes when it takes an update. */
export function headUpdatedLog(slot: bigint): ReceiptLog {
  const topics = encodeEventTopics({ abi: beaconLightClientAbi, eventName: "HeadUpdated", args: { slot, headerRoot: word(0x21), executionBlockHash: word(0x22) } }) as Hex[];
  return { address: LIGHT_CLIENT, topics, data: "0x" };
}

/** The release of tokens to the router that opens the logs of an executed item: the mediator mints or unlocks to the router. */
export function releaseToRouterLog(token: Address = OTHER_TOKEN): ReceiptLog {
  return transferLog(token, DELIVERY_ROUTER, 1n);
}

/** The `Transfer` log of a token that pays `value` to `to`. */
export function transferLog(token: Address, to: Address, value: bigint): ReceiptLog {
  const topics = encodeEventTopics({ abi: erc20Abi, eventName: "Transfer", args: { from: DELIVERY_ROUTER, to } }) as Hex[];
  return { address: token, topics, data: encodeAbiParameters([{ type: "uint256" }], [value]) };
}

/** A chain whose answers the test sets. Every call is recorded, in order. */
export interface FakeChain extends TransactionPort {
  readonly log: Array<{ readonly kind: "simulate" | "call" | "send"; readonly request: CallRequest }>;
  /** The terms of every send, in order. */
  readonly sentTerms: SendTerms[];
  /** Makes the next send throw after it was broadcast, as a lost connection does. */
  sendFailure: Error | null;
  /** Replaces the gas used that a receipt reports. Default: the simulated gas of the chain. */
  gasUsed: bigint | null;
  quote: FeeQuote;
  /** The gas that a simulation reports. */
  gas: bigint;
  /** The simulation result for a call, by the function selector of its data. Default: success. */
  simulateOverride: ((request: CallRequest) => Simulation | undefined) | null;
  /** The answer of `feeInfo`. */
  feeTokens: bigint;
  /** The answer of `predictAddress` of the token factory: the address of the copy that a first transfer deploys. */
  predictedCopy: Address;
  /** Replaces `feeTokens` with an answer that depends on the offered value and the gas of the question. */
  feeTokensOf: ((question: { readonly value: bigint; readonly gasUsed: bigint }) => bigint) | null;
  /** The sends that did not follow a simulation of the very same call. Must stay empty. */
  readonly unsimulatedSends: () => CallRequest[];
  receiptSuccess: boolean;
  /**
   * The gas that a simulation of the single entry `executeMessageWithRunner` reports. Default: `gas`. The batch simulation
   * measures each item at the single entry, and adds the overhead of the batch entry to it.
   */
  executionGas: bigint | null;
  /** The identifier of the message at a position of the batch, for the `AffirmationCompleted` log of the mined batch. Default: `word(position + 1)`. */
  messageIdOfPosition: (position: number) => Hex;
  /** What the read-only call of the batch returns for the item at a position. Default: executed. */
  batchResult: (position: number, count: number) => ItemResultInput;
  /** What the light client does with the update of a batch, in the read-only call and in the mined receipt. Default: applied. */
  updateResult: ItemResultInput;
  /** What the mined receipt shows for the update. Default: the same as `updateResult`. */
  receiptUpdateResult: ItemResultInput | null;
  /** The gas that a simulation of `update` at the light client reports. Default: `gas`. */
  updateGas: bigint | null;
  /** What the mined receipt shows for an item. Default: the same as `batchResult`. */
  receiptResult: ((position: number, count: number) => ItemResultInput) | null;
  /** Extra logs that the mined batch writes for an executed item after the release of its tokens, such as the fee transfer. */
  receiptLogsOfItem: (position: number) => ReceiptLog[];
}

const EXECUTE_MESSAGE_SINGLE = selectorOf("executeMessage");
const UPDATE_SELECTOR = toFunctionSelector(beaconLightClientAbi.find((entry) => entry.type === "function" && entry.name === "update") as never);

function selectorOf(name: string): Hex {
  const entry = deliveryRouterAbi.find((candidate) => candidate.type === "function" && candidate.name === name);
  if (entry === undefined) throw new Error(`${name} is not in the ABI`);
  return toFunctionSelector(entry as never);
}

const AGGREGATE3 = toFunctionSelector(multicall3Abi.find((entry) => entry.type === "function" && entry.name === "aggregate3") as never);

/** What the fake needs to know about a batch call: how many items it holds, and whether its first call is the update. */
function batchShape(request: CallRequest): { readonly count: number; readonly hasUpdate: boolean } {
  const decoded = decodeFunctionData({ abi: multicall3Abi, data: request.data });
  if (decoded.functionName !== "aggregate3") throw new Error(`${decoded.functionName} is no batch`);
  const calls = decoded.args[0];
  if (calls.some((call) => !call.allowFailure)) throw new Error("every call of a batch must allow failure");
  const hasUpdate = calls[0]?.target.toLowerCase() === LIGHT_CLIENT.toLowerCase();
  return { count: calls.length - (hasUpdate ? 1 : 0), hasUpdate };
}

/** The identifier of the message at a position: the anchor slot of its proof names it (`word(slot)`), else the chain default. */
function messageIdAtFor(chain: FakeChain, request: CallRequest, position: number): Hex {
  const decoded = decodeFunctionData({ abi: multicall3Abi, data: request.data });
  if (decoded.functionName !== "aggregate3") throw new Error(`${decoded.functionName} is no batch`);
  const calls = decoded.args[0].filter((call) => call.target.toLowerCase() !== LIGHT_CLIENT.toLowerCase());
  const call = calls[position];
  if (call === undefined) return chain.messageIdOfPosition(position);
  const inner = decodeFunctionData({ abi: deliveryRouterAbi, data: call.callData });
  const slot = inner.functionName === "executeMessage" ? inner.args[0].anchorHeader.slot : 0n;
  return slot > 0n ? word(Number(slot)) : chain.messageIdOfPosition(position);
}

function resultsOf(chain: FakeChain, shape: { readonly count: number; readonly hasUpdate: boolean }, pick: { readonly update: ItemResultInput; readonly item: (position: number, count: number) => ItemResultInput }) {
  const items = Array.from({ length: shape.count }, (_, position) => pick.item(position, shape.count));
  return [...(shape.hasUpdate ? [pick.update] : []), ...items];
}

/** The selector of `TokenFactory.predictAddress`. */
const PREDICT_ADDRESS = toFunctionSelector("predictAddress(uint256,address)");

export function fakeChain(): FakeChain {
  const log: FakeChain["log"] = [];
  const batchLogs = (request: CallRequest): ReceiptLog[] => {
    const shape = batchShape(request);
    const results = resultsOf(chain, shape, { update: chain.receiptUpdateResult ?? chain.updateResult, item: chain.receiptResult ?? chain.batchResult });
    const updateLogs = shape.hasUpdate && (results[0] as ItemResultInput).success ? [headUpdatedLog(164n)] : [];
    const itemLogs = results
      .slice(shape.hasUpdate ? 1 : 0)
      .flatMap((result, position) => (result.success ? [releaseToRouterLog(), ...chain.receiptLogsOfItem(position), affirmationLog(messageIdAtFor(chain, request, position))] : []));
    return [...updateLogs, ...itemLogs];
  };
  const chain: FakeChain = {
    chainId: 369,
    account: RUNNER,
    log,
    sentTerms: [],
    sendFailure: null,
    gasUsed: null,
    quote: { baseFee: 10n, priorityFee: 0n },
    gas: 300_000n,
    simulateOverride: null,
    feeTokens: 0n,
    predictedCopy: OTHER_TOKEN,
    feeTokensOf: null,
    receiptSuccess: true,
    executionGas: null,
    messageIdOfPosition: (position) => word(position + 1),
    batchResult: () => EXECUTED,
    updateResult: EXECUTED,
    receiptUpdateResult: null,
    updateGas: null,
    receiptResult: null,
    receiptLogsOfItem: () => [],
    async feeQuote() {
      return chain.quote;
    },
    async simulate(request) {
      log.push({ kind: "simulate", request });
      const isSingle = request.data.startsWith(EXECUTE_MESSAGE_SINGLE);
      const isUpdate = request.data.startsWith(UPDATE_SELECTOR);
      const gas = isSingle ? (chain.executionGas ?? chain.gas) : isUpdate ? (chain.updateGas ?? chain.gas) : chain.gas;
      return chain.simulateOverride?.(request) ?? { ok: true, gas };
    },
    async call(request) {
      log.push({ kind: "call", request });
      if (request.data.startsWith(AGGREGATE3)) {
        const shape = batchShape(request);
        const results = resultsOf(chain, shape, { update: chain.updateResult, item: chain.batchResult });
        return encodeFunctionResult({ abi: multicall3Abi, functionName: "aggregate3", result: results });
      }
      if (request.data.startsWith(PREDICT_ADDRESS)) return encodeFunctionResult({ abi: tokenFactoryAbi, functionName: "predictAddress", result: chain.predictedCopy });
      // The other read-only call a delivery makes is `feeInfo`.
      const question = decodeFunctionData({ abi: deliveryRouterAbi, data: request.data });
      if (question.functionName !== "feeInfo") throw new Error(`the fake chain does not answer ${question.functionName}`);
      const [, value, gasUsed] = question.args;
      const fee = chain.feeTokensOf === null ? chain.feeTokens : chain.feeTokensOf({ value, gasUsed });
      return encodeFunctionResult({ abi: deliveryRouterAbi, functionName: "feeInfo", result: [fee, 0n] });
    },
    async send(request): Promise<ReceiptSummary> {
      log.push({ kind: "send", request: { to: request.to, data: request.data } });
      chain.sentTerms.push({ gas: request.gas, maxFeePerGas: request.maxFeePerGas, maxPriorityFeePerGas: request.maxPriorityFeePerGas });
      if (chain.sendFailure !== null) throw chain.sendFailure;
      return {
        hash: word(0xee),
        success: chain.receiptSuccess,
        gasUsed: chain.gasUsed ?? chain.gas,
        effectiveGasPrice: chain.quote.baseFee + chain.quote.priorityFee,
        blockNumber: 1n,
        logs: request.data.startsWith(AGGREGATE3) && chain.receiptSuccess ? batchLogs(request) : [],
      };
    },
    unsimulatedSends() {
      return log
        .map((entry, index) => ({ entry, index }))
        .filter(({ entry }) => entry.kind === "send")
        .filter(({ entry, index }) => !log.slice(0, index).some((earlier) => earlier.kind === "simulate" && earlier.request.to === entry.request.to && earlier.request.data === entry.request.data))
        .map(({ entry }) => entry.request);
    },
  };
  return chain;
}

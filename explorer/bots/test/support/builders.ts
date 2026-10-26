import { encodeAbiParameters, encodeFunctionData, encodeFunctionResult, type Address, type Hex } from "viem";
import {
  encodeProofMessage,
  feeRouterAbi,
  messageBridgeAbi,
  tokenMediatorAbi,
  type ProofDirection,
  type ProofMessage,
} from "@zk-bridge/shared";
import type { CallRequest, FeeQuote, ReceiptSummary, Simulation, TransactionPort } from "../../src/chain/transactions.ts";
import type { LightClientReader, LightClientState } from "../../src/chain/light-client.ts";
import type { FeedItem, IndexerClient, MessageWithData } from "../../src/indexer/client.ts";
import { createLogger, type Logger } from "../../src/logging/logger.ts";
import type { EvidencePackage } from "../../src/prover/packages.ts";
import type { ProveOutcome, ProverBinary } from "../../src/prover/prover-binary.ts";
import type { OutcomeRecord, OutcomeSink } from "../../src/runner/outcomes.ts";
import type { FeeDirector } from "../../src/runner/fee.ts";

/** A 32 byte word with every byte set to `seed`. */
export const word = (seed: number): Hex => `0x${seed.toString(16).padStart(2, "0").repeat(32)}`;
/** An address with every byte set to `seed`. */
export const address = (seed: number): Address => `0x${seed.toString(16).padStart(2, "0").repeat(20)}`;

export const FEE_ROUTER = address(0x77);
export const WRAPPED_NATIVE = address(0x88);
export const RUNNER = address(0x99);
export const LIGHT_CLIENT = address(0x44);
export const BRIDGE = address(0x33);
export const OTHER_TOKEN = address(0x66);
export const PROGRAM_KEY = word(0x42);

/** A logger that keeps its lines, parsed. */
export function memoryLogger(knownSecrets: readonly string[] = []): { readonly logger: Logger; readonly lines: string[]; readonly events: () => Array<Record<string, unknown>> } {
  const lines: string[] = [];
  const logger = createLogger({ write: (line) => lines.push(line), now: () => new Date(0), knownSecrets: () => knownSecrets, minimumLevel: "debug" });
  return { logger, lines, events: () => lines.map((line) => JSON.parse(line) as Record<string, unknown>) };
}

/** Public values for a light client update from `startSlot` to `newSlot`. */
export function publicValuesFor(startSlot: bigint, startRoot: Hex, newSlot: bigint, newRoot: Hex): Hex {
  return encodeAbiParameters(
    [
      { type: "bytes32" },
      { type: "bytes32" },
      { type: "uint64" },
      { type: "bytes32" },
      { type: "bytes32" },
      { type: "bytes32" },
      { type: "uint64" },
      { type: "bytes32" },
      { type: "uint64" },
      { type: "bytes32" },
      { type: "bytes32" },
    ],
    [word(1), startRoot, startSlot, word(3), word(4), newRoot, newSlot, word(5), 123n, word(6), word(7)],
  );
}

/** A proof message for an update. The proof bytes are a stand-in: the fake prover decides whether they verify. */
export function proofMessage(options: { startSlot?: bigint; newSlot?: bigint; direction?: ProofDirection; programKey?: Hex; proofByte?: string } = {}): ProofMessage {
  const startSlot = options.startSlot ?? 100n;
  const newSlot = options.newSlot ?? 164n;
  const startRoot = word(Number(startSlot % 200n) + 1);
  const newRoot = word(Number(newSlot % 200n) + 1);
  return {
    version: 1,
    pair: "eth-pls",
    direction: options.direction ?? "first-to-second",
    programKey: options.programKey ?? PROGRAM_KEY,
    startSlot,
    startRoot,
    newSlot,
    newRoot,
    publicValues: publicValuesFor(startSlot, startRoot, newSlot, newRoot),
    proof: `0x${(options.proofByte ?? "ab").repeat(356)}`,
  };
}

/** The encoded payload of {@link proofMessage}. */
export const proofPayload = (options: Parameters<typeof proofMessage>[0] = {}): Hex => encodeProofMessage(proofMessage(options));

/** A light client reader that returns what the test sets. */
export function fakeLightClient(initial: Partial<LightClientState> = {}): LightClientReader & { state: LightClientState; reads: number } {
  const reader = {
    state: { headSlot: 100n, headRoot: word(101), programKey: PROGRAM_KEY, ...initial },
    reads: 0,
    async read() {
      reader.reads += 1;
      return reader.state;
    },
  };
  return reader;
}

/** The call data of a message that relays tokens to a fee router with a director. */
export function feeOfferData(options: { director: FeeDirector; value: bigint; recipient?: Address; token?: Address }): Hex {
  const callback = encodeAbiParameters(
    [{ type: "address" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }],
    [options.director.recipient, options.director.settings, options.director.limit, options.director.multiplier],
  );
  return encodeFunctionData({
    abi: tokenMediatorAbi,
    functionName: "handleBridgedTokensAndCall",
    args: [options.token ?? OTHER_TOKEN, options.recipient ?? FEE_ROUTER, options.value, callback],
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
      recipient: FEE_ROUTER,
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

/** Evidence that a bridge accepts: the calldata is a real `executeMessage` call with an empty proof. */
export function evidenceFor(options: { prerequisites?: EvidencePackage["prerequisites"]; alreadyDelivered?: boolean; executeData?: Hex } = {}): EvidencePackage {
  return {
    schemaVersion: 2,
    route: "ethereum_to_pulsechain",
    sourceTransactionHash: word(0xa1),
    logIndex: 0,
    message: { messageId: word(1), sender: address(1), executor: address(2), gasLimit: 2_000_000, data: "0x" },
    destination: { chainId: 369, bridge: BRIDGE, lightClient: LIGHT_CLIENT },
    anchor: { slot: 100, root: word(101) },
    deliveryStatus: options.alreadyDelivered === true ? "succeeded" : "notDelivered",
    alreadyDelivered: options.alreadyDelivered ?? false,
    execute: { to: BRIDGE, data: options.executeData ?? emptyExecuteMessage() },
    prerequisites: options.prerequisites ?? [],
    createdAt: "2026-10-25T00:00:00Z",
  };
}


/** The calldata of `executeMessage` with an all zero proof: enough for the router to re-encode it. */
export function emptyExecuteMessage(anchorSlot = 0n): Hex {
  const item = messageBridgeAbi.find((entry) => entry.type === "function" && entry.name === "executeMessage");
  if (item === undefined || item.type !== "function") throw new Error("executeMessage is not in the ABI");
  const zeroOf = (component: { type: string; components?: readonly { type: string; name?: string; components?: readonly unknown[] }[] }): unknown => {
    if (component.type === "tuple") return Object.fromEntries((component.components ?? []).map((inner) => [(inner as { name: string }).name, zeroOf(inner as never)]));
    if (component.type.endsWith("[]")) return [];
    if (component.type === "bytes32") return word(0);
    if (component.type === "bytes") return "0x";
    if (component.type === "address") return address(0);
    if (component.type === "bool") return false;
    return 0n;
  };
  const proof = zeroOf(item.inputs[0] as never) as { anchorHeader: { slot: bigint } };
  proof.anchorHeader.slot = anchorSlot;
  return encodeFunctionData({ abi: messageBridgeAbi, functionName: "executeMessage", args: [proof as never] });
}

/** A prover binary whose answers the test sets. */
export function fakeProver(options: { evidence?: () => EvidencePackage | Promise<EvidencePackage>; verify?: (programKey: Hex) => void | Promise<void>; prove?: () => Promise<ProveOutcome> } = {}): ProverBinary & { evidenceRuns: number; verifications: number } {
  const prover = {
    evidenceRuns: 0,
    verifications: 0,
    async prove() {
      if (options.prove === undefined) throw new Error("prove is not expected");
      return options.prove();
    },
    async evidence() {
      prover.evidenceRuns += 1;
      return (options.evidence ?? (() => evidenceFor()))();
    },
    async verify(request: { programKey: Hex }) {
      prover.verifications += 1;
      await options.verify?.(request.programKey);
    },
  };
  return prover;
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

/** A chain whose answers the test sets. Every call is recorded, in order. */
export interface FakeChain extends TransactionPort {
  readonly log: Array<{ readonly kind: "simulate" | "call" | "send"; readonly request: CallRequest }>;
  quote: FeeQuote;
  /** The gas that a simulation reports. */
  gas: bigint;
  /** The simulation result for a call, by the function selector of its data. Default: success. */
  simulateOverride: ((request: CallRequest) => Simulation | undefined) | null;
  /** The answer of `feeInfo`. */
  feeTokens: bigint;
  /** The sends that did not follow a simulation of the very same call. Must stay empty. */
  readonly unsimulatedSends: () => CallRequest[];
  receiptSuccess: boolean;
}

export function fakeChain(): FakeChain {
  const log: FakeChain["log"] = [];
  const chain: FakeChain = {
    chainId: 369,
    account: RUNNER,
    log,
    quote: { baseFee: 10n, priorityFee: 0n },
    gas: 300_000n,
    simulateOverride: null,
    feeTokens: 0n,
    receiptSuccess: true,
    async feeQuote() {
      return chain.quote;
    },
    async simulate(request) {
      log.push({ kind: "simulate", request });
      return chain.simulateOverride?.(request) ?? { ok: true, gas: chain.gas };
    },
    async call(request) {
      log.push({ kind: "call", request });
      // The only read-only call a delivery makes is `feeInfo`.
      return encodeFunctionResult({ abi: feeRouterAbi, functionName: "feeInfo", result: [chain.feeTokens, 0n] });
    },
    async send(request): Promise<ReceiptSummary> {
      log.push({ kind: "send", request: { to: request.to, data: request.data } });
      return { hash: word(0xee), success: chain.receiptSuccess, gasUsed: chain.gas, effectiveGasPrice: chain.quote.baseFee + chain.quote.priorityFee, blockNumber: 1n, logs: [] };
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

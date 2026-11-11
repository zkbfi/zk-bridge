/**
 * A transaction on Explore: its kind, the decoded call and events (from the deployment's ABIs), gas and fee, and where
 * it sits: the steps from the user's action to delivery (spec "Address and transaction pages"). No prose about what it
 * did (owner: it reads as temporary); the kind, the details and the steps say it.
 */
import { SLOTS_PER_SYNC_COMMITTEE_PERIOD, beaconForkGateAbi, beaconLightClientAbi, deliveryRouterAbi, messageBridgeAbi, tokenMediatorAbi } from "@zk-bridge/shared";
import { decodeEventLog, decodeFunctionData, getAddress, type Abi, type AbiFunction, type Address, type Hex, type Transaction, type TransactionReceipt } from "viem";
import type { ChainConfig, FeedItem, PairConfig } from "@terminal/model/types";
import { formatRoute } from "../app/route";
import { amountText, chainsFor } from "../bridge/bridge-model";
import { CONTRACT_NAMES } from "./contract-names";
import type { ProofRow } from "./explore-source";

/** Slots per sync-committee period on the beacon chain. */
export const SLOTS_PER_PERIOD = BigInt(SLOTS_PER_SYNC_COMMITTEE_PERIOD);

const CONTRACTS: readonly { readonly key: keyof ChainConfig["contracts"]; readonly name: string; readonly kind: string; readonly abi: Abi }[] = [
  { key: "lightClient", name: "Light client", kind: "Light-client update", abi: beaconLightClientAbi as Abi },
  { key: "tokenMediator", name: CONTRACT_NAMES.tokenMediator, kind: "Transfer", abi: tokenMediatorAbi as Abi },
  { key: "messageBridge", name: "MessageBridge", kind: "Message", abi: messageBridgeAbi as Abi },
  { key: "deliveryRouter", name: "DeliveryRouter", kind: "Delivery", abi: deliveryRouterAbi as Abi },
  { key: "gate", name: "Gate", kind: "Gate", abi: beaconForkGateAbi as Abi },
];
const ALL_ABIS: readonly Abi[] = CONTRACTS.map((contract) => contract.abi);

/** A decoded transaction. */
export type DescribedTransaction = {
  readonly chainId: number;
  readonly hash: Hex;
  readonly kind: string;
  readonly success: boolean;
  readonly blockNumber: bigint;
  readonly from: Address;
  readonly to: Address | null;
  /** The deployment's name for `to`, or null for another contract or an account. */
  readonly toName: string | null;
  /** `name(type arg, …)` from the ABI, or null when no ABI of the deployment decodes it. */
  readonly functionSignature: string | null;
  readonly gasUsed: bigint;
  readonly gasPriceWei: bigint;
  readonly feeWei: bigint;
  readonly nonce: number;
  readonly index: number;
  readonly inputBytes: number;
  readonly input: Hex;
  readonly events: readonly { readonly name: string; readonly address: Address; readonly args: readonly (readonly [string, string])[] }[];
  /** The proof this transaction posted, if any. */
  readonly proof: ProofRow | null;
  /** The transfer this transaction sent or delivered, if any. */
  readonly transfer: FeedItem | null;
};

/** An event argument as text: bigints in full, lists and structs (with bigints inside) as JSON-like text. */
export const argText = (value: unknown): string => (typeof value === "bigint" ? value.toString() : Array.isArray(value) ? `[${value.map(argText).join(", ")}]` : typeof value === "object" && value !== null ? JSON.stringify(value, (_, inner) => (typeof inner === "bigint" ? inner.toString() : inner)) : String(value));

/** The signature `name(type arg, …)` of the first of `abis` that decodes the call, or null. */
export const decodeCall = (input: Hex, abis: readonly Abi[]): string | null => {
  for (const abi of abis) {
    try {
      const { functionName } = decodeFunctionData({ abi, data: input });
      // decodeFunctionData names a function of this ABI, so the entry exists.
      const item = abi.find((entry) => entry.type === "function" && entry.name === functionName) as AbiFunction;
      return `${functionName}(${item.inputs.map((input) => `${input.type}${input.name === undefined || input.name === "" ? "" : ` ${input.name}`}`).join(", ")})`;
    } catch {
      // Not this ABI.
    }
  }
  return null;
};

/**
 * The signature of a call that one of the deployment's ABIs decodes, or null for any other call.
 *
 * @param input The call data.
 */
export const deploymentCallOf = (input: Hex): string | null => decodeCall(input, ALL_ABIS);

/**
 * Decodes a transaction against the deployment.
 *
 * @param input The chain, the transaction and its receipt (from the chain), the pair, the proofs and the feed (from the indexer).
 */
export const describeTransaction = (input: { readonly chainId: number; readonly tx: Transaction; readonly receipt: TransactionReceipt; readonly pair: PairConfig; readonly proofs: readonly ProofRow[]; readonly feed: readonly FeedItem[] }): DescribedTransaction => {
  const { chainId, tx, receipt, pair } = input;
  const chain = pair.first.chainId === chainId ? pair.first : pair.second;
  const to = tx.to === null || tx.to === undefined ? null : getAddress(tx.to);
  const contract = to === null ? undefined : CONTRACTS.find((candidate) => chain.contracts[candidate.key]?.toLowerCase() === to.toLowerCase());
  const hash = tx.hash.toLowerCase() as Hex;
  const proof = input.proofs.find((row) => row.chainId === chainId && row.transactionHash === hash) ?? null;
  const transfer = input.feed.find((item) => item.sourceTransactionHash.toLowerCase() === hash || item.destinationTransactionHash?.toLowerCase() === hash) ?? null;
  const events = receipt.logs.flatMap((log) => {
    for (const abi of ALL_ABIS) {
      try {
        // With the generic Abi viem types the decoded event loosely; a decoded log always has its name, and args only when it has any.
        const decoded = decodeEventLog({ abi, data: log.data, topics: log.topics }) as unknown as { readonly eventName: string; readonly args?: Record<string, unknown> };
        const args = decoded.args === undefined ? [] : Object.entries(decoded.args).map(([name, value]) => [name, argText(value)] as const);
        return [{ name: decoded.eventName, address: getAddress(log.address), args }];
      } catch {
        // Not this ABI.
      }
    }
    return [];
  });
  const kind = proof !== null ? "Light-client update" : transfer !== null ? (transfer.sourceTransactionHash.toLowerCase() === hash ? "Transfer sent" : "Transfer delivered") : (contract?.kind ?? (receipt.contractAddress ? "Contract creation" : "Transaction"));
  return {
    chainId,
    hash,
    kind,
    success: receipt.status === "success",
    blockNumber: receipt.blockNumber,
    from: getAddress(tx.from),
    to,
    toName: contract?.name ?? null,
    functionSignature: tx.input === "0x" ? null : decodeCall(tx.input, contract === undefined ? ALL_ABIS : [contract.abi, ...ALL_ABIS]),
    gasUsed: receipt.gasUsed,
    gasPriceWei: receipt.effectiveGasPrice,
    feeWei: receipt.gasUsed * receipt.effectiveGasPrice,
    nonce: tx.nonce,
    index: receipt.transactionIndex,
    inputBytes: (tx.input.length - 2) / 2,
    input: tx.input,
    events,
    proof,
    transfer,
  };
};

/** What a step's drawer shows. */
export type StepDetail =
  | { readonly kind: "block"; readonly chainId: number; readonly number: bigint; readonly hash: Hex | null; readonly slot: bigint | null; readonly period: bigint | null }
  | { readonly kind: "tx"; readonly chainId: number; readonly hash: Hex };

/** A step of "where it sits". `at` is unix seconds when known; `href` leads to the step's own page. */
export type TxStep = { readonly label: string; readonly done: boolean; readonly at: number | null; readonly href?: string; readonly detail?: StepDetail };

/** A chain name without its network suffix ("PulseChain testnet v4" → "PulseChain"), for short step labels (owner). */
export const shortChain = (name: string): string => name.replace(/ .*/, "");

/**
 * Where a transaction sits: from the user's action (the transfer that started it) to delivery. Labels are short; the
 * numbers go in each step's drawer.
 *
 * @param described The decoded transaction.
 * @param pair The pair.
 * @param transfer The transfer it belongs to, if one is known.
 */
export const whereItSits = (described: DescribedTransaction, pair: PairConfig, transfer: FeedItem | null): readonly TxStep[] => {
  const steps: TxStep[] = [];
  const here = pair.first.chainId === described.chainId ? pair.first : pair.second;
  const there = here === pair.first ? pair.second : pair.first;
  const txRoute = (chainId: number, hash: Hex): string => formatRoute({ name: "explore", page: { kind: "tx", chainId, id: hash } });
  if (transfer !== null) {
    const { source } = chainsFor(pair, transfer.direction);
    const amount = transfer.token !== null && transfer.amount !== null ? ` · ${amountText(transfer.amount, transfer.token.decimals)} ${transfer.token.symbol}` : "";
    steps.push({ label: `Transfer sent${amount}`, done: true, at: transfer.sentAt, href: txRoute(source.chainId, transfer.sourceTransactionHash), detail: { kind: "tx", chainId: source.chainId, hash: transfer.sourceTransactionHash } });
  }
  if (described.proof !== null) {
    const proof = described.proof;
    steps.push({ label: `Block final on ${shortChain(there.name)}`, done: true, at: null, detail: { kind: "block", chainId: there.chainId, number: proof.executionBlockNumber, hash: proof.executionBlockHash, slot: proof.slot, period: proof.slot / SLOTS_PER_PERIOD } });
    steps.push({ label: "Proof generated", done: true, at: null, href: formatRoute({ name: "explore", page: { kind: "proof", chainId: proof.chainId, id: String(proof.number) } }) });
    steps.push({ label: `This transaction on ${shortChain(here.name)}`, done: true, at: proof.timestamp, detail: { kind: "tx", chainId: here.chainId, hash: described.hash } });
  } else if (transfer === null || transfer.sourceTransactionHash.toLowerCase() !== described.hash) {
    steps.push({ label: `This transaction on ${shortChain(here.name)}`, done: true, at: null, detail: { kind: "tx", chainId: here.chainId, hash: described.hash } });
  }
  if (transfer !== null) {
    const { destination } = chainsFor(pair, transfer.direction);
    steps.push({
      label: `Delivered on ${shortChain(destination.name)}`,
      done: transfer.deliveredAt !== null,
      at: transfer.deliveredAt,
      ...(transfer.destinationTransactionHash === null ? {} : { href: txRoute(destination.chainId, transfer.destinationTransactionHash), detail: { kind: "tx" as const, chainId: destination.chainId, hash: transfer.destinationTransactionHash } }),
    });
  }
  return steps;
};

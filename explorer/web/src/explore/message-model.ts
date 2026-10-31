/**
 * The message page's model (mockup explore-message.html): the app on each side named by what it is, the payload decoded,
 * and the steps from the send to the delivery. Every value comes from the indexer, the deployment or the chain; what none
 * of them records stays null and the page shows "—".
 */
import { decodeMediatorMessage, usdText, type CostView } from "@zk-bridge/shared";
import { formatUnits, type Address, type Hex } from "viem";
import type { PairConfig } from "@terminal/model/types";
import { formatRoute } from "../app/route";
import { amountText } from "../bridge/bridge-model";
import type { MessageDetail } from "../data/message-detail";
import { contractNameOf } from "./contract-names";
import type { ProofRow } from "./explore-source";
import { shortHex } from "./parts";
import { deploymentCallOf, shortChain, type StepDetail } from "./tx-model";

/** An app on one side of a message: the deployment's name for it (null for any other contract), and where it leads. */
export type MessageApp = { readonly name: string | null; readonly address: Address; readonly href: string };

/**
 * The app at an address: a contract of the deployment by its name, leading to its contract page; any other address
 * leads to its address page.
 *
 * @param pair The pair.
 * @param chainId The chain the app is on.
 * @param address The address.
 */
export const appOf = (pair: PairConfig, chainId: number, address: Address): MessageApp => {
  const name = contractNameOf(pair, chainId, address);
  return {
    name,
    address,
    href: formatRoute({ name: "explore", page: name === null ? { kind: "address", id: address } : { kind: "contract", chainId, id: address } }),
  };
};

/** The size of a payload in bytes. */
export const payloadBytes = (data: Hex): number => (data.length - 2) / 2;

/**
 * What a transfer's payload asks the target mediator to do, in a few words ("release 80 USDC to 0x52…9ee7"), or null
 * when the payload is not a mediator handler call.
 *
 * @param detail The message, with its payload and transfer.
 */
export const payloadSummary = (detail: Pick<MessageDetail, "data" | "transfer">): string | null => {
  if (detail.data === null) return null;
  const decoded = decodeMediatorMessage(detail.data);
  if (decoded === null) return null;
  const token = detail.transfer?.destinationToken ?? null;
  const amount = token === null ? `${decoded.value.toString()} base units` : `${amountText(decoded.value, token.decimals)} ${token.symbol}`;
  const verb = decoded.releasesNativeToken ? "release" : decoded.deploysCopy ? "deploy the copy and mint" : "mint";
  return `${verb} ${amount} to ${shortHex(decoded.recipient)}${decoded.callbackData === null ? "" : " and call it"}`;
};

/** The called function of a plain message: its signature when the deployment's ABIs know it, else its selector. Null without a payload. */
export const calledFunction = (data: Hex | null): { readonly text: string; readonly known: boolean } | null => {
  if (data === null || data.length < 10) return null;
  const signature = deploymentCallOf(data);
  return signature === null ? { text: data.slice(0, 10), known: false } : { text: signature, known: true };
};

/** What a message step's drawer shows: a block or a transaction (as on the transaction page), or the delivery itself. */
export type MessageStepDetail = StepDetail | { readonly kind: "delivery"; readonly chainId: number; readonly reverted: boolean };

/** One step of the message. `at` is unix seconds when known. A reverted delivery carries the error tone. */
export type MessageStep = {
  readonly label: string;
  readonly done: boolean;
  readonly at: number | null;
  readonly href?: string;
  readonly detail?: MessageStepDetail;
  readonly tone?: "error";
};

const chainName = (pair: PairConfig, chainId: number): string => {
  const chain = [pair.first, pair.second].find((candidate) => candidate.chainId === chainId);
  return chain === undefined ? `chain ${chainId}` : shortChain(chain.name);
};

/**
 * The proof that covered the message: the one posted to the destination at the head slot that covers the send.
 *
 * @param detail The message.
 * @param proofs The proofs that the indexer recorded.
 */
export const coveringProof = (detail: Pick<MessageDetail, "destinationChainId" | "coveredByHeadSlot">, proofs: readonly ProofRow[]): ProofRow | null => {
  const slot = detail.coveredByHeadSlot;
  return slot === null ? null : (proofs.find((proof) => proof.chainId === detail.destinationChainId && proof.slot === BigInt(slot)) ?? null);
};

/**
 * The steps of a message: sent, the block final on the source chain, the proof posted to the destination, and the
 * delivery (or the call that reverted, or the release that failed). Each step that happened opens a drawer.
 *
 * @param detail The message.
 * @param pair The pair.
 * @param proofs The proofs that the indexer recorded.
 */
export const messageSteps = (detail: MessageDetail, pair: PairConfig, proofs: readonly ProofRow[]): readonly MessageStep[] => {
  const source = chainName(pair, detail.sourceChainId);
  const destination = chainName(pair, detail.destinationChainId);
  const covered = detail.coveredByHeadSlot !== null || detail.deliveredAt !== null;
  const proof = coveringProof(detail, proofs);
  const delivered = detail.deliveredAt !== null;
  const failed = delivered && (detail.deliverySucceeded === false || detail.releaseFailed);
  const deliveryLabel = !failed ? `Delivered on ${destination}` : detail.releaseFailed ? `Release failed on ${destination}` : `Call reverted on ${destination}`;
  return [
    {
      label: `Sent on ${source}`,
      done: true,
      at: detail.sentAt,
      detail: { kind: "tx", chainId: detail.sourceChainId, hash: detail.sourceTransactionHash },
    },
    {
      label: `Block final on ${source}`,
      done: covered,
      at: null,
      detail: { kind: "block", chainId: detail.sourceChainId, number: BigInt(detail.sentBlockNumber), hash: null, slot: null, period: null },
    },
    {
      label: proof === null ? `Proof posted to ${destination}` : `Proof #${proof.number} posted to ${destination}`,
      done: covered,
      at: proof?.timestamp ?? detail.coveredAt,
      ...(proof === null ? {} : { href: formatRoute({ name: "explore", page: { kind: "proof", chainId: proof.chainId, id: String(proof.number) } }) }),
    },
    {
      label: deliveryLabel,
      // A failed delivery is where the message stopped: the step is current, not done.
      done: delivered && !failed,
      at: detail.deliveredAt,
      ...(delivered ? { detail: { kind: "delivery" as const, chainId: detail.destinationChainId, reverted: failed } } : {}),
      ...(failed ? { tone: "error" as const } : {}),
    },
  ];
};

/** Dollars (USD × 1e18) as text: "$2.52", "<$0.01" under a cent, "$0" for nothing. */
const dollarText = (usd: bigint): string => (usd === 0n ? "$0" : usd < 10n ** 16n ? "<$0.01" : `$${usdText(Number(usd) / 1e18)}`);

/**
 * A step's cost for its drawer: "<native> <symbol> · $<usd>" (the dollars at the price block the indexer read), and
 * "shared · … over N transfers" for a proof, whose cost every message it covered shares. "—" for the dollars where
 * there is no price (testnets); null without a cost.
 *
 * @param cost The indexer's cost of the step's transaction, with the covered count for a proof.
 * @param pair The pair, for the native coin's symbol.
 */
export const stepCostText = (cost: (CostView & { readonly coveredMessages?: number }) | null, pair: PairConfig): string | null => {
  if (cost === null) return null;
  const symbol = [pair.first, pair.second].find((chain) => chain.chainId === cost.chainId)?.nativeSymbol;
  const coin = `${Number(Number(formatUnits(BigInt(cost.costWei), 18)).toPrecision(3))}${symbol === undefined ? "" : ` ${symbol}`}`;
  const dollars = cost.costUsd === null ? "—" : dollarText(BigInt(cost.costUsd));
  const text = `${coin} · ${dollars}`;
  return cost.coveredMessages === undefined ? text : `shared · ${text} over ${cost.coveredMessages} transfer${cost.coveredMessages === 1 ? "" : "s"}`;
};

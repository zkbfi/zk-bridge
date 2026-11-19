/**
 * The message page's model (mockup explore-message.html): the app on each side named by what it is, the payload decoded,
 * and the steps from the send to the delivery. Every value comes from the indexer, the deployment or the chain; what none
 * of them records stays null and the page shows "—".
 */
import { decodeMediatorMessage, type CostView } from "@zk-bridge/shared";
import type { Address, Hex } from "viem";
import type { PairConfig } from "@terminal/model/types";
import { formatRoute } from "../app/route";
import { amountText } from "../bridge/bridge-model";
import { dollarsText, shortAmountText } from "../bridge/number";
import type { MessageDetail } from "../data/message-detail";
import { contractNameOf } from "./contract-names";
import { deliveryOutcome, type DeliveryOutcome } from "./delivery-outcome";
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
  /** "error" is where a message stopped. "warning" is a delivery that did not pay the recipient as asked (see `deliveryOutcome`). */
  readonly tone?: "error" | "warning";
  /** What a delivery that did not pay as asked really did, for the drawer. */
  readonly outcome?: DeliveryOutcome;
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
 * What the router did when it did not pay the recipient as asked, from the delivery that the indexer recorded: a failed
 * callback of the router, a hand-off to its failed delivery address, or a call after the payout that failed. Null for an
 * ordinary delivery, a message the router did not deliver, and a delivery that failed to release.
 *
 * @param detail The message.
 * @param pair The pair.
 * @param failedDelivery The router's `failedDeliveryAddress()`, or null when it is not known.
 */
export const outcomeOf = (detail: MessageDetail, pair: PairConfig, failedDelivery: Address | null = null): DeliveryOutcome | null => {
  const transfer = detail.transfer;
  if (detail.deliveredAt === null || detail.releaseFailed) return null;
  const delivery = transfer?.delivery ?? null;
  const arriving = transfer === null ? null : (transfer.destinationToken ?? { symbol: transfer.sourceToken.symbol, decimals: transfer.sourceToken.decimals });
  const amount = delivery?.amount ?? transfer?.deliveredValue ?? null;
  return deliveryOutcome(
    {
      callbackFailed: detail.callbackFailed,
      viaRouter: delivery !== null,
      handOffReason: delivery?.handOffReason ?? null,
      handOffRefused: delivery?.handOffRefused ?? false,
      callFailed: delivery?.callFailed ?? null,
    },
    {
      destination: chainName(pair, detail.destinationChainId),
      failedDelivery,
      amountText: amount === null || arriving === null ? null : `${amountText(amount, arriving.decimals)} ${arriving.symbol}`,
      recipient: delivery?.recipient ?? null,
    },
  );
};

/**
 * The steps of a message: sent, the block final on the source chain, the proof posted to the destination, and the
 * delivery (or the release that failed). Each step that happened opens a drawer.
 *
 * @param detail The message.
 * @param pair The pair.
 * @param proofs The proofs that the indexer recorded.
 * @param failedDelivery The delivery router's `failedDeliveryAddress()` when the page has read it, for the words of a failed delivery.
 */
export const messageSteps = (detail: MessageDetail, pair: PairConfig, proofs: readonly ProofRow[], failedDelivery: Address | null = null): readonly MessageStep[] => {
  const source = chainName(pair, detail.sourceChainId);
  const destination = chainName(pair, detail.destinationChainId);
  const covered = detail.coveredByHeadSlot !== null || detail.deliveredAt !== null;
  const proof = coveringProof(detail, proofs);
  const delivered = detail.deliveredAt !== null;
  const failed = delivered && detail.releaseFailed;
  // A delivery that fails reverts as a whole and leaves no log, so the page never shows a failed bridge call. A callback that failed still delivers.
  const outcome = outcomeOf(detail, pair, failedDelivery);
  // A callback that failed on a recipient that is not a router still delivered: the mediator paid the recipient. On a router, the tokens never reached the recipient (see `deliveryOutcome`).
  const deliveryLabel = failed ? `Release failed on ${destination}` : outcome !== null ? outcome.label : detail.callbackFailed ? `Delivered on ${destination}, the call after it failed` : `Delivered on ${destination}`;
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
      ...(failed ? { tone: "error" as const } : outcome === null ? {} : { tone: "warning" as const, outcome }),
    },
  ];
};

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
  const coin = `${shortAmountText(BigInt(cost.costWei), 18)}${symbol === undefined ? "" : ` ${symbol}`}`;
  const dollars = cost.costUsd === null ? "—" : dollarsText(BigInt(cost.costUsd));
  const text = `${coin} · ${dollars}`;
  return cost.coveredMessages === undefined ? text : `shared · ${text} over ${cost.coveredMessages} transfer${cost.coveredMessages === 1 ? "" : "s"}`;
};

/**
 * The rules of the proof panel on the message page. Every function here is pure or takes its network access as an
 * argument, so a test hands in fakes and the page never needs a server.
 *
 * Three rules shape this file. Only the latest proof of a direction matters. Every endpoint is configured and never
 * discovered. No text that this file returns holds a URL, because a URL can hold a key.
 */
import type { Hex } from "viem";
import {
  fetchJsonResponse,
  proofCategory,
  tryDecodeProofMessage,
  planUpdateFromProofMessage,
  type EndpointKey,
  type JsonFetcher,
  type MessageStatus,
  type OperatorChain,
  type ProofDirection,
  type ProofMessage,
  type ResolvedConnection,
} from "@zk-bridge/shared";
import { createBackendClient, type BackendClient } from "@zk-bridge/shared/backend-client";
import { postJsonResponse, readBoardMessages, type BoardJsonFetcher } from "@zk-bridge/shared/msgboard-http";
import type { ChainConfig, PairConfig } from "@terminal/model/types";
import { planMessageExecution } from "@terminal/tx/operator";
import type { PlannedTransaction } from "@terminal/tx/plan";
import type { StepDisclosure, WebStep } from "../tx/bridge-steps";

/** The two reads of the network that the panel makes. A test passes fakes. */
export type PanelTransport = {
  readonly fetchJson: JsonFetcher;
  /** Posts a JSON body. `postJsonResponse` of the msgboard code fits it. */
  readonly postJson: BoardJsonFetcher;
};

/** The transport that uses `fetch`. */
export const realPanelTransport: PanelTransport = { fetchJson: fetchJsonResponse, postJson: postJsonResponse };

/** The endpoints that the panel reads. Only the resolved URLs matter, so a test passes just these. */
export type PanelEndpoints = Pick<ResolvedConnection, EndpointKey>;

/** The endpoints when nothing is set. */
export const NO_ENDPOINTS: PanelEndpoints = { backendUrl: null, msgboardIndexerUrl: null, archiveUrl: null, msgboardUrl: null };

/** Where a message is on its way. */
export type MessageStage = "sent" | "waiting-for-finality" | "covered" | "delivered";

const DELIVERED_STATUSES: readonly MessageStatus[] = ["delivered", "failed_call", "release_failed"];

/**
 * Tells where a message is. A stored head at or after the slot of the message covers it, even when the status that the
 * indexer gave is older.
 *
 * @param input.status The status that the indexer gave.
 * @param input.headSlot The slot of the head now stored by the light client on the destination chain, or null if unknown.
 * @param input.sourceSlot The slot of the message on the source chain, or null if unknown.
 */
export const messageStage = (input: { status: MessageStatus; headSlot: bigint | null; sourceSlot: bigint | null }): MessageStage => {
  if (DELIVERED_STATUSES.includes(input.status)) return "delivered";
  if (input.status === "covered") return "covered";
  if (input.headSlot !== null && input.sourceSlot !== null && input.headSlot >= input.sourceSlot) return "covered";
  if (input.status === "waiting_for_finality") return "waiting-for-finality";
  return "sent";
};

/** The stages in order, with a sentence for each. */
export const STAGES: readonly { readonly stage: MessageStage; readonly label: string; readonly meaning: string }[] = [
  { stage: "sent", label: "Sent", meaning: "The send is on the source chain. Its block is not final yet." },
  { stage: "waiting-for-finality", label: "Waiting for finality", meaning: "The block is final. The light client on the destination chain has no head that covers it." },
  { stage: "covered", label: "Covered", meaning: "The light client holds a head that covers the send. Anyone can deliver the message." },
  { stage: "delivered", label: "Delivered", meaning: "The message ran on the destination chain. It runs only once." },
];

/**
 * The direction of a proof for a message: the proof follows the chain where the message was sent.
 *
 * @param pair The pair.
 * @param sourceChainId The chain where the message was sent.
 */
export const directionOf = (pair: PairConfig, sourceChainId: number): ProofDirection =>
  sourceChainId === pair.first.chainId ? "first-to-second" : "second-to-first";

/** The place that a proof came from. */
export type ProofSource = "msgboard indexer" | "msgboard node";

/** What the search for the latest proof found. `notes` say, without any URL, why a source did not answer. */
export type LatestProofReading =
  | { readonly kind: "found"; readonly source: ProofSource; readonly message: ProofMessage; readonly headCheckedAt: number | null; readonly notes: readonly string[] }
  | { readonly kind: "none"; readonly notes: readonly string[] };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

/** A message that is for this pair and this direction. A proof for another route must never pass. */
const isForRoute = (message: ProofMessage, pair: string, direction: ProofDirection): boolean => message.pair === pair && message.direction === direction;

type SourceAnswer =
  | { readonly kind: "found"; readonly message: ProofMessage; readonly headCheckedAt: number | null }
  | { readonly kind: "missing"; readonly note: string }
  | { readonly kind: "empty"; readonly note: string };

const checkedAtOf = (body: Record<string, unknown>): number | null => (typeof body.headCheckedAt === "number" ? body.headCheckedAt : null);

/** Reads `GET /proofs/latest/:direction` of the msgboard indexer. A 404 is an answer: the indexer holds no usable proof. */
const fromMsgboardIndexer = async (input: { baseUrl: string; pair: string; direction: ProofDirection; transport: PanelTransport }): Promise<SourceAnswer> => {
  const prefix = "The msgboard indexer";
  const response = await input.transport.fetchJson(`${input.baseUrl}/proofs/latest/${input.direction}`).catch(() => null);
  if (response === null) return { kind: "missing", note: `${prefix} did not answer.` };
  if (response.status === 404) return { kind: "empty", note: `${prefix} holds no usable proof.` };
  if (response.status === 503) return { kind: "missing", note: `${prefix} cannot tell now. Try again later.` };
  if (response.status !== 200) return { kind: "missing", note: `${prefix} answered with status ${response.status}.` };
  const body = isRecord(response.body) ? response.body : null;
  const payload = body !== null && typeof body.payload === "string" ? body.payload : null;
  if (body === null || payload === null) return { kind: "missing", note: `${prefix} gave an answer of an unknown shape.` };
  const decoded = tryDecodeProofMessage(payload as Hex);
  if (!decoded.ok) return { kind: "missing", note: `${prefix} gave a proof that does not decode (${decoded.reason}).` };
  if (!isForRoute(decoded.message, input.pair, input.direction)) return { kind: "missing", note: `${prefix} gave a proof for another route.` };
  return { kind: "found", message: decoded.message, headCheckedAt: checkedAtOf(body) };
};

/**
 * Reads the proofs now on the msgboard node and keeps the best one: the proof that starts at the stored head and
 * reaches furthest. When the head is unknown, the proof that reaches furthest wins.
 */
const fromMsgboardNode = async (input: { baseUrl: string; pair: string; direction: ProofDirection; headSlot: bigint | null; transport: PanelTransport }): Promise<SourceAnswer> => {
  const prefix = "The msgboard node";
  const messages = await readBoardMessages({ boardUrl: input.baseUrl, category: proofCategory(input.pair, input.direction), fetchJson: input.transport.postJson }).catch(() => null);
  if (messages === null) return { kind: "missing", note: `${prefix} did not give its messages.` };
  const proofs = messages
    .map((message) => tryDecodeProofMessage(message.data))
    .flatMap((result) => (result.ok && isForRoute(result.message, input.pair, input.direction) ? [result.message] : []))
    .filter((proof) => input.headSlot === null || proof.startSlot === input.headSlot);
  const best = proofs.reduce<ProofMessage | null>((current, proof) => (current === null || proof.newSlot > current.newSlot ? proof : current), null);
  if (best === null) return { kind: "empty", note: `${prefix} holds no proof that starts at the stored head.` };
  return { kind: "found", message: best, headCheckedAt: null };
};

/**
 * Finds the latest proof of a direction. The msgboard indexer answers first. When it is not set or does not answer, the
 * msgboard node answers. An answer of "no usable proof" from a working indexer ends the search, because the indexer drops
 * a proof once the head moves past it, and the board may still hold an old one.
 *
 * @param input.endpoints The endpoints in force.
 * @param input.pair The pair name.
 * @param input.direction The direction.
 * @param input.headSlot The stored head slot of the destination chain, or null when unknown.
 * @param input.transport The network access.
 */
export const readLatestProof = async (input: {
  endpoints: PanelEndpoints;
  pair: string;
  direction: ProofDirection;
  headSlot: bigint | null;
  transport: PanelTransport;
}): Promise<LatestProofReading> => {
  const indexer = input.endpoints.msgboardIndexerUrl;
  const notes: string[] = indexer === null ? ["No msgboard indexer is set."] : [];
  if (indexer !== null) {
    const answer = await fromMsgboardIndexer({ baseUrl: indexer.value, pair: input.pair, direction: input.direction, transport: input.transport });
    if (answer.kind === "found") return { kind: "found", source: "msgboard indexer", message: answer.message, headCheckedAt: answer.headCheckedAt, notes };
    notes.push(answer.note);
    if (answer.kind === "empty") return { kind: "none", notes };
  }
  const node = input.endpoints.msgboardUrl;
  if (node === null) return { kind: "none", notes: [...notes, "No msgboard node is set. Set the Msgboard indexer URL or the Msgboard node URL in Connections."] };
  const answer = await fromMsgboardNode({ baseUrl: node.value, pair: input.pair, direction: input.direction, headSlot: input.headSlot, transport: input.transport });
  if (answer.kind === "found") return { kind: "found", source: "msgboard node", message: answer.message, headCheckedAt: null, notes };
  return { kind: "none", notes: [...notes, answer.note] };
};

/**
 * Tells why a proof cannot be posted now, or null when the light client would take it. The contract refuses an update
 * that does not start at its current head (`PreviousHeadSlotMismatch`), so the page reads the head again before it posts.
 *
 * @param proof The proof.
 * @param headSlot The slot that the light client stores now.
 */
export const proofStartProblem = (proof: ProofMessage, headSlot: bigint): string | null => {
  if (proof.newSlot <= headSlot) return `The light client already holds slot ${headSlot}. This proof reaches only slot ${proof.newSlot}.`;
  if (proof.startSlot !== headSlot) return `The light client head is now at slot ${headSlot}, but this proof starts at slot ${proof.startSlot}. Request a new proof.`;
  return null;
};

/** What the archive gave for a message. `text` is the JSON of the evidence, as the planner reads it. */
export type EvidenceReading = { readonly kind: "found"; readonly text: string } | { readonly kind: "none"; readonly note: string };

const HASH = /^0x[0-9a-fA-F]{64}$/;

/**
 * Asks the archive for the evidence of a message. The backend serves the same route, so it answers when no archive is
 * set. A 404 means no evidence is held. A 503 means the module is not running. The text is not checked here: the planner
 * checks it against the chains of the pair.
 *
 * @param input.endpoints The endpoints in force.
 * @param input.messageId The message identifier.
 * @param input.transport The network access.
 */
export const readEvidence = async (input: { endpoints: PanelEndpoints; messageId: string; transport: PanelTransport }): Promise<EvidenceReading> => {
  const source = input.endpoints.archiveUrl ?? input.endpoints.backendUrl;
  if (source === null) return { kind: "none", note: "No archive is set. Set the Archive URL in Connections." };
  if (!HASH.test(input.messageId)) return { kind: "none", note: "A message identifier is 0x and 64 hex digits." };
  const response = await input.transport.fetchJson(`${source.value}/evidence/${input.messageId}`).catch(() => null);
  if (response === null) return { kind: "none", note: "The archive did not answer." };
  if (response.status === 404) return { kind: "none", note: "The archive holds no evidence for this message." };
  if (response.status === 503) return { kind: "none", note: "The archive is not running on this backend." };
  if (response.status !== 200 || !isRecord(response.body)) return { kind: "none", note: `The archive answered with status ${response.status}.` };
  return { kind: "found", text: JSON.stringify(response.body) };
};

/** A client for the backend, or null when no backend is set. */
export const backendClientOf = (endpoints: PanelEndpoints, transport: PanelTransport): BackendClient | null => {
  const backend = endpoints.backendUrl;
  if (backend === null) return null;
  return createBackendClient({ baseUrl: backend.value, fetchJson: transport.fetchJson, postJson: transport.postJson });
};

const NO_DISCLOSURE: StepDisclosure = { feesApplyTo: "this-transaction", destinationNativeSymbol: null, destinationChainId: null, amountToken: null, delivery: null };

const operatorChainOf = (chain: ChainConfig): OperatorChain => ({
  chainId: chain.chainId,
  name: chain.name,
  lightClient: chain.contracts.lightClient,
  messageBridge: chain.contracts.messageBridge,
});

/**
 * Plans the light client update that a proof carries, on the destination chain of its direction.
 *
 * @param message The proof.
 * @param pair The pair.
 * @throws OperatorFileError when the public values of the proof disagree with its slots and roots.
 */
export const planProofUpdate = (message: ProofMessage, pair: PairConfig): WebStep => {
  const chain = message.direction === "first-to-second" ? pair.second : pair.first;
  const call = planUpdateFromProofMessage(message, operatorChainOf(chain));
  const plan: PlannedTransaction = {
    title: call.title,
    chain,
    to: call.to,
    contractLabel: `BeaconLightClient (${chain.name})`,
    functionSignature: call.functionSignature,
    functionName: call.functionName,
    data: call.data,
    value: 0n,
    arguments: call.arguments,
    notes: call.notes,
  };
  return { plan, disclosure: NO_DISCLOSURE };
};

/** The steps that deliver a message, or the reason that none can be planned. */
export type DeliveryPlan =
  | { readonly kind: "ready"; readonly sourceSlot: bigint; readonly steps: readonly DeliveryStep[] }
  | { readonly kind: "unavailable"; readonly reason: string };

/** One step of a delivery. A prerequisite may be skipped, because the chain may already hold the row. */
export type DeliveryStep = { readonly step: WebStep; readonly role: "prerequisite" | "execute"; readonly reason: string | null };

/**
 * Plans the delivery from an evidence reading. The prerequisites come first, then the execution.
 *
 * @param reading What the archive gave.
 * @param pair The pair.
 */
export const planDelivery = (reading: EvidenceReading, pair: PairConfig): DeliveryPlan => {
  if (reading.kind === "none") return { kind: "unavailable", reason: reading.note };
  try {
    const { summary, steps } = planMessageExecution(reading.text, pair);
    return {
      kind: "ready",
      sourceSlot: summary.sourceSlot,
      steps: steps.map((entry) => ({ step: { plan: entry.plan, disclosure: NO_DISCLOSURE }, role: entry.role, reason: entry.reason })),
    };
  } catch (error) {
    // The planner reports a bad file as an `OperatorFileError`. Any other failure also means the evidence is unusable.
    return { kind: "unavailable", reason: `The evidence cannot be used: ${(error as Error).message}` };
  }
};

/** A button, with the reason that it is off. */
export type Availability = { readonly enabled: true } | { readonly enabled: false; readonly reason: string };

const ENABLED: Availability = { enabled: true };

const off = (reason: string): Availability => ({ enabled: false, reason });

/** Input of the availability rules. */
export type AvailabilityInput = {
  readonly stage: MessageStage;
  readonly backendSet: boolean;
  readonly walletConnected: boolean;
  /** The latest proof, or null when none was found. */
  readonly proof: ProofMessage | null;
  /** The delivery plan, or null while the evidence loads. */
  readonly delivery: DeliveryPlan | null;
};

/**
 * Whether the user may ask the backend for a proof, and if not, why.
 *
 * @param input The stage, the backend setting and the rest of the facts.
 */
export const requestProofAvailability = (input: AvailabilityInput): Availability => {
  if (!input.backendSet) return off("Set the Backend URL in Connections to ask for a proof.");
  if (input.stage === "delivered") return off("The message is delivered. No proof is needed.");
  if (input.stage === "covered") return off("The light client already covers this message. No proof is needed.");
  if (input.stage === "sent") return off("The block of the send is not final yet. A proof can cover it after finality.");
  return ENABLED;
};

/**
 * Whether the user may post the light client update, and if not, why.
 *
 * @param input The stage, the wallet and the latest proof.
 */
export const postUpdateAvailability = (input: AvailabilityInput): Availability => {
  if (input.stage === "delivered") return off("The message is delivered. The light client update is not needed.");
  if (input.stage === "covered") return off("The light client already covers this message. The update is not needed.");
  if (input.proof === null) return off("No proof is available to post. Request a proof first, or set the Msgboard indexer URL or the Msgboard node URL in Connections.");
  if (!input.walletConnected) return off("Connect a wallet to post the update.");
  return ENABLED;
};

/**
 * Whether the user may deliver the message, and if not, why.
 *
 * @param input The stage, the wallet and the delivery plan.
 */
export const deliverAvailability = (input: AvailabilityInput): Availability => {
  if (input.stage === "delivered") return off("The message is already delivered. It runs only once.");
  if (input.stage !== "covered") return off("The light client does not cover this message yet. Post a proof first.");
  if (input.delivery === null) return off("The evidence is loading.");
  if (input.delivery.kind === "unavailable") return off(input.delivery.reason);
  if (!input.walletConnected) return off("Connect a wallet to deliver the message.");
  return ENABLED;
};

/** The words for the status of a proof request. */
export const REQUEST_STATUS_TEXT = {
  queued: "Waiting in the queue.",
  proving: "The prover is working on the proof.",
  published: "The proof is on the msgboard. Post the light client update.",
  "on-chain": "The light client holds the proof.",
  failed: "The request failed.",
} as const satisfies Readonly<Record<string, string>>;

/** The request statuses after which the status no longer changes. */
export const FINAL_REQUEST_STATUSES: readonly string[] = ["published", "on-chain", "failed"];

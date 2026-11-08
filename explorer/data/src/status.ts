/**
 * Status values of a message or transfer, in the order of its life.
 *
 * - `sent`: the send is on the source chain and is too young to be finalized.
 * - `waiting_for_finality`: the send is older than the finality window and no stored head covers it.
 * - `covered`: the destination light client stored a head whose execution block is at or after the source block.
 *   Anyone can now prove and deliver the message.
 * - `delivered`: the destination bridge executed the message. A delivery that fails (the target reverts, or the gas runs out)
 *   reverts as a whole and leaves no log, so the message stays `covered` until someone delivers it again. There is no
 *   status for a delivery that failed.
 * - `release_failed`: the destination bridge executed the message, but the recipient could not take the tokens
 *   (blocked recipient, paused token, reverting token, flow limiter refusal). The mediator emitted `ReleaseFailed`.
 *   Final: the mediator keeps no claim record, and the tokens stay in the mediator.
 */
export const MESSAGE_STATUSES = [
  "sent",
  "waiting_for_finality",
  "covered",
  "delivered",
  "release_failed",
] as const;

/** One status value. */
export type MessageStatus = (typeof MESSAGE_STATUSES)[number];

/** Whether the destination bridge executed the message. A failed delivery reverts, so it is never an outcome. */
export type DeliveryOutcome = "none" | "succeeded";

/** The facts that decide a status. */
export type StatusFacts = {
  readonly delivery: DeliveryOutcome;
  /** The mediator emitted `ReleaseFailed`: the recipient could not take the release. Final. */
  readonly releaseFailed: boolean;
  /** Some stored head on the destination covers the source block. */
  readonly coveredByHead: boolean;
  /** The timestamp of the source block, in seconds. */
  readonly sentTimestamp: bigint;
  /** The newest timestamp that the indexer saw on the source chain, in seconds. */
  readonly latestSourceTimestamp: bigint;
  /** The seconds after which a send counts as waiting for finality. */
  readonly finalitySeconds: number;
};

/**
 * Derives the status of a message from the facts. It is a pure function: the same facts always give the same status,
 * whatever order the indexer wrote them in.
 *
 * @param facts The facts about the message.
 */
export const deriveStatus = (facts: StatusFacts): MessageStatus => {
  if (facts.delivery === "succeeded") return deliveredStatus(facts);
  if (facts.coveredByHead) return "covered";
  const age = facts.latestSourceTimestamp - facts.sentTimestamp;
  return age >= BigInt(facts.finalitySeconds) ? "waiting_for_finality" : "sent";
};

const deliveredStatus = (facts: StatusFacts): MessageStatus => {
  if (facts.releaseFailed) return "release_failed";
  return "delivered";
};

/**
 * Whether a stored head covers a message: the head's execution block is at or after the source block.
 *
 * @param headExecutionBlockNumber The execution block of the newest stored head on the destination, or null.
 * @param sourceBlockNumber The block of the send on the source chain.
 */
export const isCovered = (headExecutionBlockNumber: bigint | null, sourceBlockNumber: bigint): boolean =>
  headExecutionBlockNumber !== null && headExecutionBlockNumber >= sourceBlockNumber;

/** The statuses that mean a transfer is still on its way. */
export const IN_FLIGHT_STATUSES = ["sent", "waiting_for_finality", "covered"] as const satisfies readonly MessageStatus[];

/**
 * Whether a status is an in-flight status.
 *
 * @param status The status to test.
 */
export const isInFlight = (status: MessageStatus): boolean => (IN_FLIGHT_STATUSES as readonly string[]).includes(status);

/**
 * The seconds of one beacon slot, by chain identifier. Ethereum and Sepolia have 12 second slots. PulseChain and
 * PulseChain testnet v4 have 10 second slots.
 */
export const SECONDS_PER_SLOT = {
  1: 12,
  369: 10,
  11155111: 12,
  943: 10,
} as const satisfies Readonly<Record<number, number>>;

/** The slot length of a chain that has no entry in the table. */
const DEFAULT_SECONDS_PER_SLOT = 12;

/** The slots of one epoch on every beacon chain that the bridge follows. */
const SLOTS_PER_EPOCH = 32;

/** The epochs that a send waits for finality. */
const FINALITY_EPOCHS = 2;

/**
 * The seconds of one slot on a chain.
 *
 * @param chainId The chain identifier. A chain with no entry gets 12 seconds.
 */
export const secondsPerSlot = (chainId: number): number =>
  (SECONDS_PER_SLOT as Readonly<Record<number, number>>)[chainId] ?? DEFAULT_SECONDS_PER_SLOT;

/**
 * The seconds a send needs to become final by default: two epochs of 32 slots on the beacon chain of the source.
 * The same formula serves every chain: Ethereum 768, PulseChain 640, Sepolia 768, PulseChain testnet v4 640.
 *
 * @param chainId The source chain identifier.
 */
export const defaultFinalitySeconds = (chainId: number): number =>
  secondsPerSlot(chainId) * SLOTS_PER_EPOCH * FINALITY_EPOCHS;

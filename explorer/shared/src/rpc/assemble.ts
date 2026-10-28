import type { Address, Hex } from "viem";
import { tokenKey, type TokenRow, type TransferRow } from "../api-views.js";
import { isCovered } from "../status.js";
import { mergeMessage, mergeTransfer, type MessageRow, type TransferPatch } from "../message-merge.js";
import { otherSide, sideOf, type Pair } from "../pairs.js";
import { decodeSend, type DecodedSend } from "../send-decoding.js";
import { buildTokenRow, type TokenMetadata } from "../token-facts.js";
import type { ChainLog } from "./chain-reader.js";

/** The facts about a token that need the chain: its metadata and the native token behind it. */
export type TokenReading = TokenMetadata & {
  /** The native token on the other chain when this token is a bridged copy, else null. */
  readonly nativeBehind: Address | null;
};

/** The newest light client head of a chain, read from the contract. */
export type CurrentHead = {
  readonly slot: bigint;
  readonly executionBlockNumber: bigint;
  /** When the head was stored, or null when no update event of it is in the scanned history. */
  readonly updatedTimestamp: bigint | null;
};

/** Everything that the assembly reads besides the logs. The caller fetches all of it first. */
export type AssembleInput = {
  readonly pair: Pair;
  /** The scanned logs of each chain, ordered by block and log index. */
  readonly logs: ReadonlyMap<number, readonly ChainLog[]>;
  /** The timestamp of a block that holds a log from {@link collectNeeds}. */
  readonly timestampOf: (chainId: number, blockNumber: bigint) => bigint;
  /** The timestamp of the latest block of a chain. */
  readonly latestTimestamp: (chainId: number) => bigint;
  /** What was read for a token from {@link collectNeeds}. */
  readonly readingOf: (chainId: number, address: Address) => TokenReading;
  /** The execution block that a stored head holds, for a head hash from {@link collectNeeds}. */
  readonly executionBlockOf: (chainId: number, executionBlockHash: Hex) => bigint;
  /** The head stored now on a chain, or null when it stores none. */
  readonly currentHead: (chainId: number) => CurrentHead | null;
};

/** The rows built from the logs. */
export type Assembled = {
  readonly messages: ReadonlyMap<Hex, MessageRow>;
  readonly transfers: ReadonlyMap<Hex, TransferRow>;
  readonly tokens: ReadonlyMap<string, TokenRow>;
};

/** What the assembly will ask for. */
export type Needs = {
  readonly timestampBlocks: readonly { readonly chainId: number; readonly blockNumber: bigint }[];
  readonly tokens: readonly { readonly chainId: number; readonly address: Address }[];
  readonly headHashes: readonly { readonly chainId: number; readonly hash: Hex }[];
};

const hexOf = (log: ChainLog, name: string): Hex => log.args[name] as Hex;
const addressOf = (log: ChainLog, name: string): Address => log.args[name] as Address;

/** The events that name a token on their own chain: the transfer events. */
const TRANSFER_EVENTS = new Set(["TokensBridgingInitiated", "TokensBridged"]);

/** The events whose block timestamp the assembly needs. */
const TIMESTAMPED = new Set(["UserRequestForAffirmation", "AffirmationCompleted", "TokensBridgingInitiated", "NewTokenRegistered", "HeadUpdated", "ForkConfirmed"]);

/**
 * Decodes the send in a log, or null when the log is malformed: it does not decode, or its identifier in the topic is
 * not the one in its data. The indexer would stop on such a log. The RPC source skips it and lists the rest.
 */
const decodeSendLog = (pair: Pair, chainId: number, log: ChainLog): DecodedSend | null => {
  try {
    const decoded = decodeSend(pair, chainId, log.args.encodedData as Hex);
    return decoded.messageFacts.messageId === hexOf(log, "messageId") ? decoded : null;
  } catch {
    return null;
  }
};

/**
 * Lists the chain reads that {@link assemble} needs for these logs: block timestamps, token readings and the execution
 * blocks of stored heads.
 *
 * @param pair The pair.
 * @param logs The scanned logs of each chain.
 */
export const collectNeeds = (pair: Pair, logs: ReadonlyMap<number, readonly ChainLog[]>): Needs => {
  const timestampBlocks = new Map<string, { chainId: number; blockNumber: bigint }>();
  const tokens = new Map<string, { chainId: number; address: Address }>();
  const headHashes = new Map<string, { chainId: number; hash: Hex }>();
  for (const [chainId, chainLogs] of logs) {
    const wantToken = (id: number, address: Address): void => void tokens.set(tokenKey(id, address), { chainId: id, address });
    for (const log of chainLogs) {
      if (TIMESTAMPED.has(log.eventName)) timestampBlocks.set(`${chainId}:${log.blockNumber}`, { chainId, blockNumber: log.blockNumber });
      if (TRANSFER_EVENTS.has(log.eventName)) wantToken(chainId, addressOf(log, "token"));
      if (log.eventName === "NewTokenRegistered") wantToken(chainId, addressOf(log, "bridgedToken"));
      if (log.eventName === "HeadUpdated") headHashes.set(`${chainId}:${hexOf(log, "executionBlockHash")}`, { chainId, hash: hexOf(log, "executionBlockHash") });
      if (log.eventName !== "UserRequestForAffirmation") continue;
      const transfer = decodeSendLog(pair, chainId, log)?.transfer;
      if (transfer === undefined || transfer === null) continue;
      wantToken(transfer.releasesNativeToken ? otherSide(pair, chainId).chainId : chainId, transfer.token);
    }
  }
  return { timestampBlocks: [...timestampBlocks.values()], tokens: [...tokens.values()], headHashes: [...headHashes.values()] };
};

/**
 * Builds the rows of messages, transfers and tokens from the logs of both chains, with the same merge rules and the
 * same status derivation as the indexer handlers (`explorer/indexer/src/handlers`). The logs of one chain apply in
 * order. Each message gets its facts from the logs of both chains and its status from `deriveStatus`.
 *
 * @param input The pair, the logs and the chain reads.
 */
export const assemble = (input: AssembleInput): Assembled => {
  const { pair } = input;
  const messages = new Map<Hex, MessageRow>();
  const transfers = new Map<Hex, TransferRow>();
  const registrations = new Map<string, { transactionHash: Hex; blockNumber: bigint; timestamp: bigint }>();
  const referenced = new Map<string, { chainId: number; address: Address }>();

  const writeMessage = (messageId: Hex, sourceChainId: number, destinationChainId: number, patch: Partial<MessageRow>): void => {
    messages.set(
      messageId,
      mergeMessage({
        messageId,
        sourceChainId,
        destinationChainId,
        existing: messages.get(messageId) ?? null,
        patch,
        latestSourceTimestamp: input.latestTimestamp(sourceChainId),
        finalitySeconds: sideOf(pair, sourceChainId).finalitySeconds,
      }),
    );
  };
  const writeTransfer = (messageId: Hex, sourceChainId: number, destinationChainId: number, patch: TransferPatch): void => {
    transfers.set(messageId, mergeTransfer({ messageId, sourceChainId, destinationChainId, existing: transfers.get(messageId) ?? null, patch }));
  };
  const refer = (chainId: number, address: Address): void => void referenced.set(tokenKey(chainId, address), { chainId, address });

  const apply = (chainId: number, log: ChainLog): void => {
    const other = otherSide(pair, chainId).chainId;
    const messageId = log.args.messageId as Hex | undefined;
    const timestamp = (): bigint => input.timestampOf(chainId, log.blockNumber);
    if (log.eventName === "UserRequestForAffirmation") {
      const decoded = decodeSendLog(pair, chainId, log);
      if (decoded === null) return;
      writeMessage(decoded.messageFacts.messageId, chainId, decoded.destinationChainId, {
        ...decoded.messageFacts,
        sentTransactionHash: log.transactionHash,
        sentBlockNumber: log.blockNumber,
        sentTimestamp: timestamp(),
        sentLogIndex: log.logIndex,
      });
      const transfer = decoded.transfer;
      if (transfer === null) return;
      refer(transfer.releasesNativeToken ? decoded.destinationChainId : chainId, transfer.token);
      writeTransfer(decoded.messageFacts.messageId, chainId, decoded.destinationChainId, {
        recipient: transfer.recipient,
        value: transfer.value,
        handler: transfer.handler,
        deploysCopy: transfer.deploysCopy,
        hasCallback: transfer.callbackData !== null,
        sourceIsNative: !transfer.releasesNativeToken,
        sentTimestamp: timestamp(),
        ...(transfer.releasesNativeToken ? { destinationToken: transfer.token } : { sourceToken: transfer.token }),
      });
      return;
    }
    if (log.eventName === "AffirmationCompleted") {
      writeMessage(hexOf(log, "messageId"), other, chainId, {
        deliveredTransactionHash: log.transactionHash,
        deliveredBlockNumber: log.blockNumber,
        deliveredTimestamp: timestamp(),
        deliveredSuccess: log.args.status as boolean,
        executedBy: null,
      });
      return;
    }
    if (log.eventName === "TokensBridgingInitiated") {
      const token = addressOf(log, "token");
      refer(chainId, token);
      writeTransfer(hexOf(log, "messageId"), chainId, other, {
        sourceToken: token,
        sender: addressOf(log, "sender"),
        value: log.args.value as bigint,
        sourceIsNative: input.readingOf(chainId, token).nativeBehind === null,
        sentTimestamp: timestamp(),
      });
      return;
    }
    if (log.eventName === "TokensBridged") {
      const token = addressOf(log, "token");
      refer(chainId, token);
      writeTransfer(hexOf(log, "messageId"), other, chainId, {
        destinationToken: token,
        paidTo: addressOf(log, "recipient"),
        deliveredValue: log.args.value as bigint,
      });
      return;
    }
    if (log.eventName === "NewTokenRegistered") {
      const copy = addressOf(log, "bridgedToken");
      refer(chainId, copy);
      registrations.set(tokenKey(chainId, copy), { transactionHash: log.transactionHash, blockNumber: log.blockNumber, timestamp: timestamp() });
      return;
    }
    if (log.eventName === "CallbackFailed") return writeMessage(hexOf(log, "messageId"), other, chainId, { callbackFailed: true });
    if (log.eventName === "ReleaseFailed") return writeMessage(hexOf(log, "messageId"), other, chainId, { releaseFailed: true });
  };

  for (const side of pair.sides) for (const log of input.logs.get(side.chainId) as readonly ChainLog[]) apply(side.chainId, log);

  const coverings = (destinationChainId: number) =>
    (input.logs.get(destinationChainId) as readonly ChainLog[])
      .filter((log) => log.eventName === "HeadUpdated")
      .map((log) => ({
        slot: log.args.slot as bigint,
        executionBlockNumber: input.executionBlockOf(destinationChainId, hexOf(log, "executionBlockHash")),
        timestamp: input.timestampOf(destinationChainId, log.blockNumber),
      }));
  const eventsByChain = new Map(pair.sides.map((side) => [side.chainId, coverings(side.chainId)]));
  for (const row of [...messages.values()]) {
    if (row.sentBlockNumber === null) continue;
    const sentBlock = row.sentBlockNumber;
    const first = eventsByChain.get(row.destinationChainId)?.find((event) => isCovered(event.executionBlockNumber, sentBlock));
    const current = input.currentHead(row.destinationChainId);
    const covering =
      first !== undefined
        ? { coveredByHeadSlot: first.slot, coveredAtTimestamp: first.timestamp }
        : current !== null && isCovered(current.executionBlockNumber, sentBlock)
          ? { coveredByHeadSlot: current.slot, coveredAtTimestamp: current.updatedTimestamp }
          : null;
    if (covering !== null) writeMessage(row.messageId, row.sourceChainId, row.destinationChainId, covering);
  }

  const tokens = new Map<string, TokenRow>();
  for (const [key, { chainId, address }] of referenced) {
    const reading = input.readingOf(chainId, address);
    const registration = registrations.get(key);
    const { nativeBehind } = reading;
    tokens.set(
      key,
      buildTokenRow({
        chainId,
        address,
        metadata: reading,
        hints: {
          ...(nativeBehind === null
            ? { isBridgedCopy: false, homeChainId: chainId, homeToken: address }
            : { isBridgedCopy: true, homeChainId: otherSide(pair, chainId).chainId, homeToken: nativeBehind }),
          ...(registration === undefined
            ? {}
            : {
                registeredTransactionHash: registration.transactionHash,
                registeredBlockNumber: registration.blockNumber,
                registeredTimestamp: registration.timestamp,
              }),
        },
      }),
    );
  }
  return { messages, transfers, tokens };
};

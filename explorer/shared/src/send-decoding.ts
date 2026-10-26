import type { Hex } from "viem";
import { sameAddress } from "./address.js";
import { decodeAmbMessage } from "./amb.js";
import { decodeMediatorMessage, type MediatorMessage } from "./mediator-message.js";
import type { MessageRow } from "./message-merge.js";
import { otherSide, type Pair } from "./pairs.js";

/** What a `UserRequestForAffirmation` log tells about a message. */
export type DecodedSend = {
  readonly sourceChainId: number;
  readonly destinationChainId: number;
  /** The message columns that a send fills. */
  readonly messageFacts: Pick<MessageRow, "messageId" | "sender" | "executor" | "gasLimit" | "dataType" | "data" | "kind">;
  /** The mediator call inside a token message, or null for an arbitrary message. */
  readonly transfer: MediatorMessage | null;
};

/**
 * Decodes the log of a send: the AMB message, and the mediator call when the executor is the mediator of the other side.
 *
 * @param pair The pair, to recognize the remote mediator.
 * @param chainId The chain that emitted the log (the source chain).
 * @param encodedData The `encodedData` argument of `UserRequestForAffirmation`.
 * @throws When the message is malformed or does not start on `chainId`, or its destination is not the other side.
 */
export const decodeSend = (pair: Pair, chainId: number, encodedData: Hex): DecodedSend => {
  const { header, data } = decodeAmbMessage(encodedData);
  const destination = otherSide(pair, chainId);
  if (header.sourceChainId !== BigInt(chainId)) {
    throw new Error(`message ${header.messageId} says it starts on chain ${header.sourceChainId}, not ${chainId}`);
  }
  if (header.destinationChainId !== BigInt(destination.chainId)) {
    throw new Error(`message ${header.messageId} goes to chain ${header.destinationChainId}, not ${destination.chainId}`);
  }
  const toRemoteMediator = sameAddress(header.executor, destination.contracts.mediator);
  const transfer = toRemoteMediator ? decodeMediatorMessage(data) : null;
  return {
    sourceChainId: chainId,
    destinationChainId: destination.chainId,
    messageFacts: {
      messageId: header.messageId,
      sender: header.sender,
      executor: header.executor,
      gasLimit: header.gasLimit,
      dataType: header.dataType,
      data,
      kind: transfer === null ? "message" : "token",
    },
    transfer,
  };
};

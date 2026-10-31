// Moved to @zkb/data; this path keeps every existing import working.
export {
  DATA_TYPE_PASS,
  DATA_TYPE_CONFIRM,
  MESSAGE_PACKING_VERSION,
  type AmbHeader,
  type AmbMessage,
  chainIdLength,
  encodeAmbMessage,
  decodeAmbMessage,
  messageIdPrefix,
  buildMessageId,
  messageNonce,
  hasValidVersion,
} from "@zkb/data";

// Moved to @zkb/data; this path keeps every existing import working.
export {
  MESSAGE_STATUSES,
  type MessageStatus,
  type DeliveryOutcome,
  type StatusFacts,
  deriveStatus,
  isCovered,
  IN_FLIGHT_STATUSES,
  isInFlight,
  SECONDS_PER_SLOT,
  secondsPerSlot,
  defaultFinalitySeconds,
} from "@zkb/data";

// Moved to @zkb/data; this path keeps every existing import working.
export {
  type StoredHead,
  readStoredHead,
  readExecutionBlockNumber,
  readFinalizedSlot,
  type GateReading,
  readGate,
  type MediatorReading,
  readMediatorBalances,
  type CopyReading,
  readBridgedCopy,
} from "@zkb/data";

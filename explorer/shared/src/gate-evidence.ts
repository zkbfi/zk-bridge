// Lives in @zkb/data; this path lets the bots import it from @zk-bridge/shared like the rest.
export {
  type GateEvidenceErrorCode,
  GateEvidenceError,
  type GateChainClient,
  GATE_MODES,
  type GateMode,
  type GateStatus,
  readGateStatus,
  type BeaconProofSource,
  createBeaconProofSource,
  SHAPE_REQUEST_ORDER,
  type ReadyGateEvidence,
  type WaitForGateHeader,
  buildGateEvidence,
  describeRevert,
  type GateConfirmation,
  ensureGateConfirmed,
} from "@zkb/data";
